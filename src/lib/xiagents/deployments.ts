import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import type Database from "better-sqlite3";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { AccountStore } from "../accounts/store";
import { DEFAULT_WATCH_POLICY, accountDraftSchema, profileSchema, settingsSchema } from "../accounts/types";
import { bloubConfigSchema } from "../bloub/config";
import { agentLLMConfigSchema, INHERIT_LLM, type AgentLLMConfig, type AgentLLMSettings, type Resolution } from "../llm/types";
import { agentLLMSettings, describeLLM } from "../watch/llm-binding";
import { assertWithin, inside, listDir, writeAtomic, type Vault } from "../publications/vault";
import { locked } from "../topics/lock";
import type { TopicStore } from "../topics/store";
import { draftSchema, TopicError } from "../topics/types";
import { proposeFromUrl } from "../watch/collect";
import { createJobQueue, PRIORITY } from "../watch/jobs";
import type { PoliteFetch } from "../watch/net";
import type { SourceStore } from "../watch/sources";
import { canonicalUrl } from "../watch/stories";
import { parentTagProblem } from "./draft";
import { scheduleSchema, nextWatchOpening, watchOpen } from "./schedule";

/**
 * Deployment of a confirmed ΞAgent (or topic) configuration, in the manner of a hosting platform:
 * a durable record (`<vault>/.xi-deployments/<id>.md`, private 0700/0600) with real steps, each
 * persisted with its own logs before the next one starts. Every step is idempotent (identifiers
 * allocated once, lookups before writes), so a failed or interrupted deployment resumes from where
 * it stopped without duplicating topics, agents or sources. The agent's watch is enabled only by
 * the last step: a partial deployment never leaves a half-configured agent running.
 */
const topicRef = z.discriminatedUnion("type", [
  z.object({ type: z.literal("existing"), id: z.uuid() }).strict(),
  z.object({ type: z.literal("new"), key: z.string().regex(/^[a-z0-9-]{1,40}$/) }).strict(),
]);
export type TopicRef = z.infer<typeof topicRef>;
const httpUrl = z.string().trim().max(2_000).refine(value => { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; } }, "URL http(s) attendue.");
export const sourceSpecSchema = z.object({
  url: httpUrl,
  /** Only explicit decisions are deployed: undecided suggestions are never saved. */
  status: z.enum(["approved", "excluded"]),
  origin: z.enum(["ai", "user"]),
  type: z.string().trim().max(80),
  rationale: z.string().trim().max(500),
}).strict();
export type SourceSpec = z.infer<typeof sourceSpecSchema>;
export const agentSpecSchema = z.object({
  handle: accountDraftSchema.shape.handle, name: accountDraftSchema.shape.name, description: accountDraftSchema.shape.description,
  primary: topicRef, secondary: z.array(topicRef).max(30),
  presetId: z.string().min(1).max(100), presetVersion: z.number().int().positive(), settings: settingsSchema,
  /** Deprecated (deployments recorded before `llm`): a model override, read through `agentLLM`. */
  modelRef: z.string().trim().min(1).max(200).nullable().optional(),
  /** Model selection: inherit, another model, or another of the owner's instances (docs/llm.md). */
  llm: agentLLMConfigSchema.default(INHERIT_LLM),
  profile: profileSchema,
  sources: z.array(sourceSpecSchema).max(50),
  schedule: scheduleSchema,
  bloub: bloubConfigSchema,
  /** Autonomous publication of validated drafts (private); operator flags still apply. */
  autoPublish: z.boolean(),
}).strict();
export const deploymentSpecSchema = z.object({
  target: z.enum(["agent", "topic"]),
  newTopics: z.array(z.object({ key: z.string().regex(/^[a-z0-9-]{1,40}$/), draft: draftSchema }).strict()).max(10),
  agent: agentSpecSchema.nullable(),
  proposal: z.object({ generatedBy: z.enum(["ai", "rules", "yaml", "manual"]), model: z.string().max(200).nullable() }).strict(),
}).strict().superRefine((spec, context) => {
  const keys = spec.newTopics.map(topic => topic.key);
  if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", message: "Topics nouveaux dupliqués." });
  if (spec.target === "agent" && !spec.agent) context.addIssue({ code: "custom", message: "Configuration du ΞAgent manquante." });
  if (spec.target === "topic" && (spec.agent || !spec.newTopics.length)) context.addIssue({ code: "custom", message: "Un topic à créer est attendu." });
  if (spec.agent) {
    const refs = [spec.agent.primary, ...spec.agent.secondary];
    const ids = refs.map(ref => ref.type === "existing" ? ref.id : `new:${ref.key}`);
    if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "Topics du ΞAgent dupliqués." });
    if (refs.some(ref => ref.type === "new" && !keys.includes(ref.key))) context.addIssue({ code: "custom", message: "Topic nouveau inconnu." });
    const urls = spec.agent.sources.map(source => canonicalUrl(source.url).key);
    if (new Set(urls).size !== urls.length) context.addIssue({ code: "custom", message: "Sources dupliquées." });
  }
});
export type DeploymentSpec = z.infer<typeof deploymentSpecSchema>;
/** The agent's model selection; a legacy `modelRef` without an explicit choice becomes a model override. */
export function agentLLM(agent: Pick<z.infer<typeof agentSpecSchema>, "modelRef" | "llm">): AgentLLMConfig {
  const llm = agent.llm ?? INHERIT_LLM;
  return agent.modelRef && !llm.model && !llm.instanceId ? { ...llm, model: agent.modelRef } : llm;
}

export type StepStatus = "pending" | "running" | "completed" | "failed";
export type StepLog = { at: string; level: "info" | "warn" | "error"; message: string };
export type DeploymentStep = { key: StepKey; name: string; status: StepStatus; startedAt: string | null; finishedAt: string | null; logs: StepLog[]; error: string | null };
export type Deployment = {
  id: string; owner: string; target: DeploymentSpec["target"]; state: "pending" | "running" | "failed" | "completed";
  createdAt: string; updatedAt: string; attempts: number; spec: DeploymentSpec;
  ids: { agentId: string | null; topics: Record<string, string> };
  steps: DeploymentStep[];
};
const STEPS = {
  validate: "Validation de la configuration",
  check: "Vérification des topics et des identifiants",
  topics: "Création des topics nécessaires",
  identity: "Enregistrement de l’identité, de la charte et de l’avatar",
  sources: "Configuration des sources",
  calendars: "Enregistrement des calendriers",
  monitoring: "Initialisation de la surveillance",
  readiness: "Vérifications de disponibilité",
  activation: "Activation du mode automatique",
} as const;
export type StepKey = keyof typeof STEPS;
const AGENT_STEPS: StepKey[] = ["validate", "check", "topics", "identity", "sources", "calendars", "monitoring", "readiness", "activation"];
const TOPIC_STEPS: StepKey[] = ["validate", "check", "topics"];

const encode = (data: unknown) => `---\n${stringify(data)}---\n`;
const decode = (text: string) => { const match = /^---\n([\s\S]*?)\n---\n/.exec(text); if (!match) throw new TopicError("Déploiement illisible."); return parse(match[1]); };
/**
 * Business errors (TopicError, ZodError) are shown as is. Anything else is an internal failure: the
 * owner sees its kind and the step (never its message, which may hold paths or data), and the server
 * log gets what an operator needs to find it.
 */
function message(error: unknown, context?: { deploymentId: string; step: StepKey }) {
  if (error instanceof z.ZodError) return error.issues.map(issue => issue.message).join(" ; ");
  if (error instanceof TopicError) return error.message;
  const kind = error instanceof Error ? error.name : typeof error;
  const code = typeof (error as NodeJS.ErrnoException | undefined)?.code === "string" ? (error as NodeJS.ErrnoException).code : null;
  if (context) console.error("ΞAgent deployment step failed", { deployment: context.deploymentId, step: context.step, error: kind, code, message: error instanceof Error ? error.message.slice(0, 300) : null });
  return `Erreur interne (${kind}${code ? ` ${code}` : ""})${context ? ` pendant « ${STEPS[context.step]} »` : ""} : les étapes terminées sont conservées. Relancez le déploiement ; si l’erreur persiste, les journaux du serveur la détaillent${context ? ` (déploiement ${context.deploymentId})` : ""}.`;
}

export type DeploymentDeps = {
  vault: Vault; db: Database.Database; accounts: AccountStore; topics: TopicStore; sources: SourceStore; fetch: PoliteFetch;
  /** Environment facts checked by the readiness step (never invented). */
  readiness: () => { inference: { configured: boolean; model: string | null; error: string | null }; autoPublish: boolean; workerLastTickAt: number | null };
  /** The owner's LLM configuration (llm/server.ts): ownership of a chosen instance, and the resolution checked at readiness. */
  llm?: { owns: (owner: string, instanceId: string) => boolean; resolve: (owner: string, settings: AgentLLMSettings) => Resolution };
  now?: () => Date;
};

export function createDeployments({ vault, db, accounts, topics, sources, fetch, readiness, llm, now = () => new Date() }: DeploymentDeps) {
  const directory = inside(vault.root, ".xi-deployments");
  async function prepare() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (await assertWithin(vault.root, directory) !== directory) throw new TopicError("Lien symbolique interdit.");
  }
  const path = (id: string) => inside(directory, `${z.uuid().parse(id)}.md`);
  const save = (deployment: Deployment) => { deployment.updatedAt = now().toISOString(); return writeAtomic(path(deployment.id), encode(deployment)); };
  async function load(owner: string, id: string): Promise<Deployment> {
    if (!z.uuid().safeParse(id).success) throw new TopicError("Déploiement introuvable.", 404);
    await prepare();
    let deployment: Deployment;
    try { deployment = decode(await readFile(path(id), "utf8")) as Deployment; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new TopicError("Déploiement introuvable.", 404); throw error; }
    if (deployment.owner !== owner) throw new TopicError("Déploiement introuvable.", 404);
    return deployment;
  }
  /** Per-deployment cross-process lock: one execution at a time, others get 409 and keep watching. */
  async function exclusive<T>(id: string, task: () => Promise<T>) {
    const dir = inside(directory, ".locks", z.uuid().parse(id));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return locked(dir, task);
  }

  /** Problems found without writing anything (shown before the deployment is created). */
  async function preflight(owner: string, spec: DeploymentSpec, ids?: Deployment["ids"]) {
    const problems: string[] = [];
    const catalog = await topics.list();
    for (const topic of spec.newTopics) {
      const allocated = ids?.topics[topic.key];
      const clash = catalog.find(t => (t.tag === topic.draft.tag || t.aliases.includes(topic.draft.tag)) && t.id !== allocated);
      if (clash) problems.push(`Le tag « ${topic.draft.tag} » est déjà utilisé par le topic « ${clash.name} » : sélectionnez ce topic existant.`);
      if (topic.draft.parentId && !catalog.some(t => t.id === topic.draft.parentId)) problems.push(`Parent introuvable pour le topic « ${topic.draft.name} ».`);
      else { const problem = parentTagProblem(topic.draft, catalog); if (problem) problems.push(problem); }
    }
    if (spec.agent) {
      const agent = spec.agent;
      for (const ref of [agent.primary, ...agent.secondary]) if (ref.type === "existing" && !catalog.some(t => t.id === ref.id)) problems.push("Un topic sélectionné n’existe plus : rechargez le catalogue.");
      if (!await accounts.handleAvailable(agent.handle, ids?.agentId ?? null)) problems.push(`Le handle @${agent.handle} est déjà réservé.`);
      if (!(await accounts.listPresets(owner)).some(p => p.id === agent.presetId && p.version === agent.presetVersion)) problems.push("Version de preset introuvable.");
      // Only the owner's own instances: another owner's id is as unknown as a deleted one.
      const instanceId = agentLLM(agent).instanceId;
      if (instanceId && llm && !llm.owns(owner, instanceId)) problems.push("L’instance d’intelligence artificielle choisie n’existe plus : choisissez-en une autre ou la configuration globale.");
    }
    return problems;
  }

  /** Idempotent: the same id and configuration return the existing deployment. */
  async function create(owner: string, id: string, input: unknown) {
    z.uuid().parse(id);
    const spec = deploymentSpecSchema.parse(input);
    await prepare();
    return exclusive(id, async () => {
      try {
        const existing = await load(owner, id);
        if (JSON.stringify(existing.spec) !== JSON.stringify(spec)) throw new TopicError("Ce déploiement existe déjà avec une autre configuration.", 409);
        return existing;
      } catch (error) { if (!(error instanceof TopicError && error.status === 404)) throw error; }
      if ((await listDir(directory)).some(entry => entry.name === `${id}.md`)) throw new TopicError("Identifiant de déploiement indisponible.", 409);
      const problems = await preflight(owner, spec);
      if (problems.length) throw new TopicError(problems.join(" "), 422);
      const at = now().toISOString();
      const deployment: Deployment = {
        id, owner, target: spec.target, state: "pending", createdAt: at, updatedAt: at, attempts: 0, spec,
        ids: { agentId: spec.agent ? randomUUID() : null, topics: Object.fromEntries(spec.newTopics.map(topic => [topic.key, randomUUID()])) },
        steps: (spec.target === "agent" ? AGENT_STEPS : TOPIC_STEPS).map(key => ({ key, name: STEPS[key], status: "pending", startedAt: null, finishedAt: null, logs: [], error: null })),
      };
      await save(deployment);
      return deployment;
    });
  }

  async function list(owner: string, { agentId }: { agentId?: string } = {}) {
    await prepare();
    const items: Deployment[] = [];
    for (const entry of await listDir(directory)) {
      if (!entry.isFile() || !/^[0-9a-f-]{36}\.md$/.test(entry.name)) continue;
      try {
        const deployment = decode(await readFile(inside(directory, entry.name), "utf8")) as Deployment;
        if (deployment.owner === owner && (!agentId || deployment.ids.agentId === agentId)) items.push(deployment);
      } catch { /* an unreadable record is skipped, never shown to another owner */ }
    }
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Runs (or resumes) a deployment from its first unfinished step. */
  async function run(owner: string, id: string) {
    await load(owner, id);
    return exclusive(id, async () => {
      const deployment = await load(owner, id);
      if (deployment.state === "completed") return deployment;
      deployment.state = "running"; deployment.attempts++;
      await save(deployment);
      const resolveRef = (ref: TopicRef) => ref.type === "existing" ? ref.id : deployment.ids.topics[ref.key];
      const agentTopics = () => deployment.spec.agent ? [deployment.spec.agent.primary, ...deployment.spec.agent.secondary].map(resolveRef) : [];
      for (const step of deployment.steps) {
        if (step.status === "completed") continue;
        const log = (level: StepLog["level"], text: string) => { step.logs.push({ at: now().toISOString(), level, message: text.slice(0, 1_000) }); };
        step.status = "running"; step.startedAt = now().toISOString(); step.error = null;
        log("info", deployment.attempts > 1 ? `Reprise (tentative ${deployment.attempts}).` : "Démarrage.");
        await save(deployment);
        try {
          await operations[step.key](deployment, { log, resolveRef, agentTopics });
          step.status = "completed"; step.finishedAt = now().toISOString();
          await save(deployment);
        } catch (error) {
          step.status = "failed"; step.finishedAt = now().toISOString(); step.error = message(error, { deploymentId: deployment.id, step: step.key });
          log("error", step.error);
          deployment.state = "failed";
          await save(deployment);
          return deployment;
        }
      }
      deployment.state = "completed";
      await save(deployment);
      return deployment;
    });
  }

  type Context = { log: (level: StepLog["level"], text: string) => void; resolveRef: (ref: TopicRef) => string; agentTopics: () => string[] };
  const operations: Record<StepKey, (deployment: Deployment, context: Context) => Promise<void>> = {
    async validate(deployment, { log }) {
      const spec = deploymentSpecSchema.parse(deployment.spec);
      log("info", `Configuration valide : ${spec.newTopics.length} topic(s) à créer${spec.agent ? `, ΞAgent @${spec.agent.handle}, ${spec.agent.sources.filter(s => s.status === "approved").length} source(s) approuvée(s), ${spec.agent.sources.filter(s => s.status === "excluded").length} exclue(s), fuseau ${spec.agent.schedule.timeZone}` : ""}.`);
      log("info", { ai: `Proposition initiale générée par le modèle local ${spec.proposal.model ?? ""}, vérifiée et modifiée par le propriétaire.`, rules: "Proposition initiale déduite des mots-clés (règles locales, sans IA), vérifiée par le propriétaire.", yaml: "Configuration importée depuis un fichier YAML, vérifiée par le propriétaire.", manual: "Configuration saisie manuellement." }[spec.proposal.generatedBy]);
    },
    async check(deployment, { log }) {
      const problems = await preflight(deployment.owner, deployment.spec, deployment.ids);
      if (problems.length) throw new TopicError(problems.join(" "), 409);
      const catalog = await topics.list();
      for (const ref of deployment.spec.agent ? [deployment.spec.agent.primary, ...deployment.spec.agent.secondary] : []) {
        if (ref.type === "existing") log("info", `Topic existant réutilisé : ${catalog.find(t => t.id === ref.id)?.tag}.`);
      }
      if (deployment.spec.agent) log("info", `Handle @${deployment.spec.agent.handle} disponible.`);
    },
    async topics(deployment, { log }) {
      for (const topic of deployment.spec.newTopics) {
        const { topic: saved, created } = await topics.create(deployment.owner, deployment.ids.topics[topic.key], topic.draft);
        log("info", `${created ? "Topic créé" : "Topic déjà créé par une tentative précédente"} : ${saved.tag} (${saved.id}).`);
      }
      if (!deployment.spec.newTopics.length) log("info", "Aucun nouveau topic : uniquement des topics existants.");
    },
    async identity(deployment, { log, agentTopics }) {
      const agent = deployment.spec.agent!;
      const [primaryTopicId, ...secondaryTopicIds] = agentTopics();
      const { account, created } = await accounts.createAgent(deployment.owner, deployment.ids.agentId!, {
        draft: { handle: agent.handle, name: agent.name, description: agent.description, primaryTopicId, secondaryTopicIds, presetId: agent.presetId, presetVersion: agent.presetVersion, settings: agent.settings, active: true, modelRef: null, validationMode: "human" },
        profile: agent.profile, bloub: agent.bloub, llm: agentLLM(agent),
      });
      log("info", `${created ? "ΞAgent enregistré" : "ΞAgent déjà enregistré, éléments manquants complétés"} : @${account.handle} (${account.id}). Veille désactivée jusqu’à l’activation.`);
    },
    async sources(deployment, { log, agentTopics }) {
      const agent = deployment.spec.agent!;
      const topicIds = agentTopics();
      let failed = 0;
      for (const spec of agent.sources) {
        const host = new URL(spec.url).hostname;
        try {
          if (spec.status === "approved") {
            const { source, created } = await proposeFromUrl({ fetch, sources, owner: deployment.owner, url: spec.url, topicIds, by: deployment.owner, note: `${spec.origin === "ai" ? "Suggérée par le modèle local, approuvée explicitement" : "Ajoutée et approuvée"} par le propriétaire lors du déploiement. ${spec.rationale}`.trim() });
            let current = source;
            if (["proposed", "rejected", "disabled"].includes(current.status)) current = await sources.decide(deployment.owner, current.id, { action: "approve", revision: current.revision, note: "Approuvée par le propriétaire lors du déploiement du ΞAgent." });
            const missing = topicIds.filter(topic => !current.topicIds.includes(topic));
            if (missing.length) current = await sources.decide(deployment.owner, current.id, { action: "update", revision: current.revision, edits: { topicIds: [...current.topicIds, ...missing].slice(0, 30) }, note: `Associée au ΞAgent @${agent.handle}.` });
            log("info", `${created ? "Source ajoutée" : "Source déjà présente"} et approuvée : ${current.publisher} — ${current.url} (fiabilité estimée : ${current.reliability.level}).`);
          } else {
            const { source } = await sources.propose(deployment.owner, { url: spec.url, kind: "feed", site: `${new URL(spec.url).origin}/`, publisher: host, topicIds, reliability: { level: "inconnue", reasons: ["Exclue par le propriétaire."], estimated: true }, note: `Exclue lors du déploiement de @${agent.handle}.` }, deployment.owner);
            if (source.status === "proposed") { await sources.decide(deployment.owner, source.id, { action: "reject", revision: source.revision, note: "Exclue par le propriétaire : jamais collectée ni reproposée." }); log("info", `Source exclue : ${host}.`); }
            else if (source.status === "approved") log("warn", `${host} est déjà approuvée pour vos autres ΞAgents : non modifiée.`);
            else log("info", `Source déjà exclue ou désactivée : ${host}.`);
          }
        } catch (error) {
          if (!(error instanceof TopicError)) throw error;
          failed++;
          log("error", `Source non ajoutée (${host}) : ${error.message}`);
        }
      }
      if (!agent.sources.length) log("warn", "Aucune source : la veille ne collectera rien tant qu’aucune source n’est approuvée.");
      if (failed) log("warn", `${failed} source(s) non ajoutée(s). Vous pourrez les proposer de nouveau depuis la page du ΞAgent.`);
    },
    async calendars(deployment, { log }) {
      const agentId = deployment.ids.agentId!;
      const wanted = deployment.spec.agent!.schedule;
      const current = await accounts.schedule(deployment.owner, agentId);
      const same = current.explicit && current.valid && JSON.stringify(scheduleSchema.strip().parse(current)) === JSON.stringify(scheduleSchema.parse(wanted));
      if (!same) await accounts.setSchedule(deployment.owner, agentId, { revision: current.revision, schedule: wanted });
      const days = (kind: "watch" | "publish") => wanted[kind].week.filter(ranges => ranges.length).length;
      log("info", `Calendriers enregistrés (${wanted.timeZone}) : veille ${days("watch")} j/7, publication ${days("publish")} j/7, ${Object.keys(wanted.watch.exceptions).length + Object.keys(wanted.publish.exceptions).length} exception(s) ; tolérance ${wanted.graceMinutes} min ; rattrapage ${wanted.catchUpHours} h ; événements majeurs ${wanted.majorEvents.enabled ? "autorisés" : "désactivés"}.`);
    },
    async monitoring(deployment, { log, agentTopics }) {
      const agentId = deployment.ids.agentId!;
      const agent = (await accounts.watchAgents()).find(item => item.id === agentId);
      if (!agent) throw new TopicError("ΞAgent introuvable après son enregistrement.");
      const topicSet = new Set(agentTopics());
      const approved = (await sources.approved()).filter(source => source.owner === deployment.owner && source.topicIds.some(topic => topicSet.has(topic)));
      const at = now().getTime();
      if (watchOpen(agent, at)) {
        const queue = createJobQueue(db, () => now().getTime());
        let planned = 0;
        for (const source of approved) if (queue.enqueue({ kind: "collect-source", key: `collect-source:deploy:${deployment.id}:${source.id}`, payload: { sourceId: source.id, owner: deployment.owner, agentId, trigger: "manual" }, runAfter: at, maxAttempts: 3, priority: PRIORITY.manual }).created) planned++;
        log("info", `Plage de veille ouverte : ${planned} première(s) collecte(s) planifiée(s) pour le prochain passage du worker.`);
      } else {
        const next = nextWatchOpening(agent, at);
        log("info", next === null ? "Calendrier de veille vide : aucune collecte ne sera planifiée." : `Plage de veille fermée : première veille à ${new Date(next).toISOString()}.`);
      }
      log("info", `${approved.length} source(s) approuvée(s) couvrent les topics du ΞAgent.`);
    },
    async readiness(deployment, { log }) {
      const agentId = deployment.ids.agentId!;
      const agent = (await accounts.watchAgents()).find(item => item.id === agentId);
      if (!agent?.schedule?.explicit || !agent.schedule.valid) throw new TopicError("Calendriers illisibles après enregistrement.");
      if (!agent.profile) throw new TopicError("Charte éditoriale absente après enregistrement.");
      if (!agent.watch.valid) throw new TopicError("Configuration de veille illisible.");
      const facts = readiness();
      if (llm) {
        const resolution = llm.resolve(deployment.owner, agentLLMSettings(agent));
        if (resolution.ok) log("info", `Modèle résolu : ${describeLLM(resolution.value)}. La connexion sera vérifiée à la première évaluation.`);
        else log("warn", `${resolution.message} Collecte possible, évaluation et rédaction en attente (Paramètres → Intelligence artificielle).`);
      }
      else if (facts.inference.error) log("warn", `Inférence locale refusée : ${facts.inference.error}. Collecte possible, évaluation et rédaction suspendues.`);
      else if (!facts.inference.configured) log("warn", "Inférence locale non configurée (aucune instance, ni XI_INFERENCE_URL) : collecte possible, évaluation et rédaction en attente.");
      else if (!agentLLMSettings(agent).config.model && !facts.inference.model) log("warn", "Aucun modèle : choisissez un modèle pour le ΞAgent ou XI_INFERENCE_MODEL.");
      else log("info", `Inférence locale configurée (modèle ${agentLLMSettings(agent).config.model ?? facts.inference.model}).`);
      if (facts.workerLastTickAt === null) log("warn", "Aucun passage du worker enregistré : installez le timer xi-watch (docs/watch.md).");
      else if (now().getTime() - facts.workerLastTickAt > 30 * 60_000) log("warn", `Dernier passage du worker : ${new Date(facts.workerLastTickAt).toISOString()} (plus de 30 min).`);
      else log("info", `Worker actif (dernier passage ${new Date(facts.workerLastTickAt).toISOString()}).`);
      if (deployment.spec.agent!.autoPublish && !facts.autoPublish) log("warn", "Publication autonome demandée, mais non autorisée par l’opérateur (XI_WATCH_AUTOPUBLISH) : les brouillons attendront.");
    },
    async activation(deployment, { log }) {
      const agentId = deployment.ids.agentId!;
      const current = await accounts.watchPolicy(deployment.owner, agentId);
      const policy = { ...DEFAULT_WATCH_POLICY, ...current.policy, enabled: true, paused: false, autoPublish: deployment.spec.agent!.autoPublish };
      if (JSON.stringify(policy) !== JSON.stringify(current.policy) || current.revision === null) await accounts.setWatchPolicy(deployment.owner, agentId, { revision: current.revision, policy });
      log("info", `Mode automatique activé : veille selon les calendriers${policy.autoPublish ? ", publication autonome privée des brouillons validés" : ", publication autonome désactivée"}.`);
    },
  };

  return { create, run, list, preflight, get: load };
}
export type Deployments = ReturnType<typeof createDeployments>;
