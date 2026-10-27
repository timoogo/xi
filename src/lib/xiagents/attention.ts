import type { WatchDiagnostics } from "../watch/diagnostics";

/**
 * What the ΞAgent page summarises, read from the watch diagnostics only: no pipeline rule is
 * re-implemented here. Four kinds, never mixed up:
 * - blocked: something is broken and the agent cannot do its work;
 * - decisions: the agent waits for its owner (sources to approve, drafts that cannot be published automatically);
 * - scheduled: compliant drafts the publisher will publish on its own at the next window;
 * - waiting: normal steps of the pipeline (evaluation, drafting, pause), nothing to do.
 * `href` points to the detailed section of the page.
 */
export type AttentionItem = { label: string; detail?: string; at?: string | null; href: string };
export type Attention = { running: boolean; healthy: boolean; blocked: AttentionItem[]; decisions: AttentionItem[]; scheduled: AttentionItem[]; waiting: AttentionItem[] };
export type ActivityItem = { storyId: string; title: string; status: string; lane: string | null; scheduled: boolean; reason: string; updatedAt: string };
type Input = Pick<WatchDiagnostics, "watch" | "running" | "worker" | "llm" | "failedJobs" | "sources" | "candidates" | "publishBlocks" | "nextWindow">;

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
/** A drafted candidate goes out on its own when nothing blocks the publisher (diagnostics' `publishBlocks`). */
const publishesAlone = (data: Input) => data.running && !data.publishBlocks.length;

export function agentAttention(data: Input): Attention {
  const blocked: AttentionItem[] = [], decisions: AttentionItem[] = [], scheduled: AttentionItem[] = [], waiting: AttentionItem[] = [];
  if (!data.watch.valid) blocked.push({ label: "Paramètres de veille illisibles", detail: "La veille reste fermée jusqu’à leur réenregistrement.", href: "#policy-title" });
  if (data.running && data.worker.stale) blocked.push({ label: "Le worker de veille ne tourne pas", detail: data.worker.lastTickAt ? "Aucun passage depuis plus de 30 min : ni collecte, ni analyse, ni publication." : "Aucun passage enregistré : ni collecte, ni analyse, ni publication.", at: data.worker.lastTickAt, href: "#xiagent-watch" });
  if (data.llm && !data.llm.ok) blocked.push({ label: "Modèle d’IA indisponible", detail: "Analyse et rédaction sont impossibles tant que sa configuration n’est pas corrigée.", href: "#xiagent-llm" });
  if (data.failedJobs > 0) blocked.push({ label: plural(data.failedJobs, "tâche en échec définitif", "tâches en échec définitif"), detail: "Toutes les tentatives ont échoué.", href: "#jobs-title" });
  const failing = data.sources.filter(source => source.status === "approved" && (source.state?.lastOutcome === "error" || source.state?.lastOutcome === "robots"));
  if (failing.length) blocked.push({ label: plural(failing.length, "source active en échec de collecte", "sources actives en échec de collecte"), detail: failing.map(source => source.publisher).join(", "), href: "#sources-title" });

  const proposed = data.sources.filter(source => source.status === "proposed").length;
  if (proposed) decisions.push({ label: plural(proposed, "source en attente d’approbation", "sources en attente d’approbation"), detail: "Elle ne peut établir une information qu’après votre décision.", href: "#sources-title" });
  const drafted = data.candidates.filter(candidate => candidate.status === "drafted").length;
  if (drafted && publishesAlone(data)) scheduled.push({ label: plural(drafted, "publication automatique programmée", "publications automatiques programmées"), detail: "Brouillons conformes, publiés à la prochaine fenêtre dans la limite des plafonds.", at: data.nextWindow, href: "#drafts-title" });
  else if (drafted && data.running) decisions.push({ label: plural(drafted, "brouillon à relire", "brouillons à relire"), detail: `Publication automatique impossible : ${data.publishBlocks.join(" ")}`, href: "#drafts-title" });
  else if (drafted) waiting.push({ label: plural(drafted, "brouillon en attente de la reprise de la veille", "brouillons en attente de la reprise de la veille"), href: "#drafts-title" });
  const accepted = data.candidates.filter(candidate => candidate.status === "accepted").length;
  if (accepted) waiting.push({ label: plural(accepted, "information retenue avant rédaction", "informations retenues avant rédaction"), href: "#candidates-title" });
  const evaluating = data.candidates.filter(candidate => candidate.status === "evaluating").length;
  if (evaluating) waiting.push({ label: plural(evaluating, "actualité en cours d’évaluation", "actualités en cours d’évaluation"), href: "#candidates-title" });

  return { running: data.running, healthy: data.running && !blocked.length && !decisions.length, blocked, decisions, scheduled, waiting };
}

/** The latest editorial candidates, newest first, with where each one stands (diagnostics' blocker). */
export function agentActivity(data: Input, limit = 5): ActivityItem[] {
  return data.candidates.slice(0, limit).map(candidate => ({
    storyId: candidate.storyId, title: candidate.title, status: candidate.status, lane: candidate.lane, updatedAt: candidate.updatedAt,
    scheduled: candidate.status === "drafted" && publishesAlone(data),
    reason: candidate.blocker.step === "publiée" ? "Publiée." : candidate.blocker.reason,
  }));
}
