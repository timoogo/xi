import type Database from "better-sqlite3";
import type { AccountStore } from "../accounts/store";
import { getAppDatabase } from "../auth";
import { createLocalInference, InferenceConfigError, inferenceConfigFromEnv, InferenceOutputError, InferenceUnavailableError, type Inference, type InferenceConfig } from "../watch/inference";
import type { Fetcher } from "../watch/net";
import { bindInference } from "./inference";
import { createProviderFetch, destinationPolicyFromEnv } from "./network";
import { createOllamaClient } from "./ollama";
import { resolveLLM, type EnvironmentServer } from "./resolve";
import { createLLMStore, LLMStoreError } from "./store";
import { deleteInstanceSchema, LLM_ERROR_CODES, type InstanceDependencies, LLM_ERROR_LABELS, mergeInferenceOptions, type AgentLLMSettings, type ConnectionStatus, type EnvironmentInstance, type LLMErrorCode, type ModelTestResult, type ResolutionProblemCode, type ResolvedInferenceOptions, type ResolvedLLM } from "./types";

/**
 * LLM runtime shared by the web server and the watch worker.
 *
 * Network policy (see network.ts): provider calls are made by the server only, to stored instances
 * of the requesting owner, on fixed endpoints (`/api/version`, `/api/tags`, `/api/chat`), without
 * redirects and with deadlines. Local network addresses (loopback, private ranges, Tailscale CGNAT,
 * IPv6 ULA) are allowed on purpose — a LAN Ollama is the point; link-local (cloud metadata) and
 * public addresses are refused, except IPs listed by the operator in XI_INFERENCE_ALLOW.
 * XI_LLM_ALLOWED_HOSTS ("host" or "host:port", comma-separated) restricts owners to those hosts,
 * e.g. on an installation shared by several accounts. Explicit checks and tests are rate-limited
 * per owner and report error codes, never remote bodies, so the endpoints cannot serve as a
 * network scanner or an HTTP proxy.
 */
const CHECK_LIMIT = 12;
const CHECK_WINDOW_MS = 10 * 60_000;
const TEST_SYSTEM = "Tu es un test de connexion. Réponds uniquement par un objet JSON.";
const TEST_PROMPT = 'Réponds exactement : {"ok": true}';

type Binding = { ok: true; inference: Inference; resolved: ResolvedLLM } | { ok: false; code: ResolutionProblemCode; message: string };

const codeOf = (error: unknown): LLMErrorCode => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && (LLM_ERROR_CODES as readonly string[]).includes(code) ? code as LLMErrorCode : "http";
};
/** Messages of the inference error classes are fixed texts (never remote bodies); anything else gets its label. */
const messageOf = (error: unknown) => error instanceof InferenceUnavailableError || error instanceof InferenceConfigError || error instanceof InferenceOutputError ? error.message : LLM_ERROR_LABELS[codeOf(error)];

export function createLLMRuntime({ db, env = process.env, fetch, now = () => new Date() }: { db: Database.Database; env?: Record<string, string | undefined>; fetch?: Fetcher; now?: () => Date }) {
  const policy = destinationPolicyFromEnv(env);
  const store = createLLMStore(db, { policy, now });
  const request = fetch ?? createProviderFetch(policy);

  // The operator's environment server, read once: a refused configuration is reported, never used.
  let envConfig: InferenceConfig | null = null;
  let envError: string | null = null;
  try {
    envConfig = inferenceConfigFromEnv(env);
    if (envConfig) createLocalInference(envConfig);
  } catch (error) {
    envConfig = null;
    envError = error instanceof Error ? error.message : "Configuration refusée.";
  }
  const environmentServer: EnvironmentServer = envConfig ? { url: envConfig.url, api: envConfig.api, defaultModel: envConfig.defaultModel, timeoutMs: envConfig.timeoutMs } : null;

  const recent = new Map<string, number[]>();
  function throttle(owner: string) {
    const since = now().getTime() - CHECK_WINDOW_MS;
    const calls = (recent.get(owner) ?? []).filter(at => at > since);
    if (calls.length >= CHECK_LIMIT) throw new LLMStoreError("Trop de vérifications et de tests : réessayez dans quelques minutes.", 429);
    calls.push(now().getTime());
    recent.set(owner, calls);
  }

  const resolve = (owner: string, agent: AgentLLMSettings | null) => resolveLLM({ store, owner, agent, environment: environmentServer });

  function inferenceFor(owner: string, resolved: ResolvedLLM, options: ResolvedInferenceOptions): Inference {
    if (resolved.instanceSource === "environment") return createLocalInference({ ...envConfig!, timeoutMs: options.timeoutMs });
    const instance = store.get(owner, resolved.instance.id)!;
    return bindInference({ type: instance.type, baseUrl: instance.baseUrl, policy, options, fetch: request });
  }

  function bind(owner: string, agent: AgentLLMSettings | null): Binding {
    const resolution = resolve(owner, agent);
    if (!resolution.ok) return resolution;
    return { ok: true, inference: inferenceFor(owner, resolution.value, resolution.value.options), resolved: resolution.value };
  }

  /** Connectivity (`/api/version`, loads no model) then installed models (`/api/tags`); recorded on the instance. */
  async function check(owner: string, id: string) {
    const instance = store.get(owner, id);
    if (!instance) throw new LLMStoreError("Instance introuvable.", 404);
    throttle(owner);
    const checkedAt = now().toISOString();
    try {
      const client = createOllamaClient({ baseUrl: instance.baseUrl, policy, fetch: request });
      const { version, latencyMs } = await client.version();
      const models = await client.models();
      return store.recordCheck(owner, id, { state: "ok", checkedAt, version, latencyMs }, models);
    } catch (error) {
      const status: ConnectionStatus = { state: "error", checkedAt, code: codeOf(error), message: messageOf(error) };
      return store.recordCheck(owner, id, status);
    }
  }

  /**
   * Explicit short request: measures latency, publishes nothing, changes nothing. Either an agent's
   * (or the owner's global) resolution, or one instance of the owner (`instanceId`), optionally with
   * another of its models.
   */
  async function testModel(owner: string, agent: AgentLLMSettings | null, model?: string, instanceId?: string): Promise<ModelTestResult> {
    let resolved: ResolvedLLM;
    if (instanceId) {
      const instance = store.get(owner, instanceId);
      if (!instance) throw new LLMStoreError("Instance introuvable.", 404);
      if (!instance.enabled) return { ok: false, latencyMs: null, code: "disabled", message: `L’instance « ${instance.name} » est désactivée.` };
      const chosen = model ?? instance.defaultModel;
      if (!chosen) return { ok: false, latencyMs: null, code: "no-model", message: "Choisissez un modèle à tester." };
      resolved = { instanceSource: "global", modelSource: model ? "agent" : "instance", instance: { id: instance.id, key: instance.key, name: instance.name, type: instance.type }, model: chosen, options: mergeInferenceOptions(instance.options) };
    } else {
      const resolution = resolve(owner, agent);
      if (!resolution.ok) return { ok: false, latencyMs: null, code: resolution.code, message: resolution.message };
      resolved = model ? { ...resolution.value, model, modelSource: "agent" } : resolution.value;
    }
    throttle(owner);
    // The test runs with the options the agent's runs will use (account ← agent): a test with its own
    // generation limit would fail or pass where the real runs do not. Only the deadline is bounded.
    const options = { ...resolved.options, timeoutMs: Math.min(resolved.options.timeoutMs, 120_000) };
    const started = performance.now();
    try {
      const reply = await inferenceFor(owner, resolved, options).complete({ model: resolved.model, system: TEST_SYSTEM, prompt: TEST_PROMPT });
      return { ok: true, latencyMs: Math.round(performance.now() - started), model: resolved.model, instance: resolved.instance.name, reply: reply.trim().slice(0, 200) };
    } catch (error) {
      return { ok: false, latencyMs: Math.round(performance.now() - started), code: codeOf(error), message: messageOf(error) };
    }
  }

  return {
    store, policy, resolve, bind, check, testModel,
    environment: (): EnvironmentInstance => ({ configured: !!envConfig, api: envConfig?.api ?? null, defaultModel: envConfig?.defaultModel ?? null, error: envError }),
  };
}
export type LLMRuntime = ReturnType<typeof createLLMRuntime>;

/** Agents that would lose their instance: explicit references, plus inheriting agents when it is the default. */
export async function instanceDependencies(runtime: LLMRuntime, accounts: AccountStore, owner: string, id: string): Promise<InstanceDependencies> {
  if (!runtime.store.get(owner, id)) throw new LLMStoreError("Instance introuvable.", 404);
  const isDefault = runtime.store.settings(owner).defaultInstanceId === id;
  const names = new Map((await accounts.list(owner)).filter(account => account.owner === owner).map(account => [account.id, account.name]));
  const agents: InstanceDependencies["agents"] = [];
  for (const agent of await accounts.watchAgents()) {
    if (agent.owner !== owner || !agent.llm?.valid) continue;
    const reason = agent.llm.config.instanceId === id ? "explicit" : isDefault && agent.llm.config.instanceId === null ? "inherits-default" : null;
    if (reason) agents.push({ id: agent.id, handle: agent.handle, name: names.get(agent.id) ?? agent.handle, reason });
  }
  return { isDefault, agents };
}

/**
 * Deletion with an explicit decision for dependent agents (never silently broken):
 * - another instance id: explicit agents move to it (its default model); if the deleted one was the
 *   default, it becomes the default;
 * - "global": explicit agents go back to inheriting;
 * - "none": they keep the dangling reference and show a configuration problem.
 * With "global" or "none", a deleted default instance leaves no default.
 */
export async function deleteInstance(runtime: LLMRuntime, accounts: AccountStore, owner: string, id: string, input: unknown) {
  const { reassignTo } = deleteInstanceSchema.parse(input);
  const dependencies = await instanceDependencies(runtime, accounts, owner, id);
  if (dependencies.agents.length && !reassignTo) throw new LLMStoreError(`${dependencies.agents.length} ΞAgent(s) utilisent cette instance : choisissez ce qu’ils deviennent.`, 409, { dependencies });
  if (reassignTo && reassignTo !== "global" && reassignTo !== "none") {
    const target = runtime.store.get(owner, reassignTo);
    if (!target) throw new LLMStoreError("Instance de remplacement introuvable.", 404);
    if (target.id === id) throw new LLMStoreError("Choisissez une autre instance que celle supprimée.");
    if (!target.enabled) throw new LLMStoreError("L’instance de remplacement est désactivée.");
  }
  const target = reassignTo === "global" ? null : reassignTo === "none" || !reassignTo ? undefined : reassignTo;
  const reassigned = target === undefined ? [] : await accounts.reassignLLM(owner, id, target);
  if (dependencies.isDefault) runtime.store.setDefault(owner, { revision: runtime.store.settings(owner).revision, defaultInstanceId: target ?? null });
  runtime.store.remove(owner, id);
  const defaultInstanceId = runtime.store.settings(owner).defaultInstanceId;
  return { deleted: true as const, reassigned, defaultInstanceId, ...(dependencies.isDefault && !defaultInstanceId ? { notice: runtime.environment().configured
    ? "Plus aucune instance par défaut : les ΞAgents qui héritent de la configuration globale utilisent désormais le serveur de l’installation."
    : "Plus aucune instance par défaut : les ΞAgents qui héritent de la configuration globale signalent un problème de configuration." } : {}) };
}

const singleton = globalThis as typeof globalThis & { xiLLM?: LLMRuntime; xiLLMFactory?: typeof createLLMRuntime };
/** Web-side runtime; the worker builds its own with the same factory. */
export function getLLMRuntime() {
  // Next dev reloads modules but keeps globalThis: never reuse closures of an older implementation.
  if (process.env.NODE_ENV !== "production" && singleton.xiLLMFactory !== createLLMRuntime) {
    singleton.xiLLM = undefined;
    singleton.xiLLMFactory = createLLMRuntime;
  }
  singleton.xiLLM ??= createLLMRuntime({ db: getAppDatabase() });
  return singleton.xiLLM;
}
