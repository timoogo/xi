import { LLM_ERROR_LABELS, PROVIDER_LABELS, type AgentLLMMode, type ConnectionStatus, type LLMErrorCode, type LLMInstance, type Resolution, type ResolutionProblemCode } from "@/lib/llm/types";

/** What the pickers need of an instance (never its URL). */
export type InstanceChoice = Pick<LLMInstance, "id" | "key" | "name" | "type" | "enabled" | "defaultModel" | "models" | "options">;
export const toChoice = ({ id, key, name, type, enabled, defaultModel, models, options }: LLMInstance): InstanceChoice => ({ id, key, name, type, enabled, defaultModel, models, options });

export const selectClass = "w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";
export const DASH = "—";

export const date = (value: string | null) => value ? new Date(value).toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" }) : DASH;

/** Decimal units, as Ollama reports sizes in bytes. */
export function formatBytes(bytes: number | null) {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return DASH;
  const units = ["o", "Ko", "Mo", "Go", "To"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value.toLocaleString("fr-FR", { maximumFractionDigits: unit < 2 ? 0 : 1 })} ${units[unit]}`;
}

export const providerLabel = (type: string) => (PROVIDER_LABELS as Record<string, string>)[type] ?? type;

export const MODE_LABELS: Record<AgentLLMMode, string> = { inherit: "héritée", model: "modèle spécifique", instance: "instance spécifique" };

const PROBLEM_LABELS: Record<ResolutionProblemCode, string> = {
  "not-configured": "Aucune configuration",
  "instance-missing": "Instance supprimée",
  "instance-disabled": "Instance désactivée",
  "no-model": "Aucun modèle",
  "invalid-config": "Configuration illisible",
};
export const errorLabel = (code: LLMErrorCode | ResolutionProblemCode) => (LLM_ERROR_LABELS as Record<string, string>)[code] ?? PROBLEM_LABELS[code as ResolutionProblemCode] ?? "Erreur";

/** Text equivalent of a connection state (the colour only repeats it). */
export function statusText(status: ConnectionStatus) {
  if (status.state === "unknown") return "Connexion non vérifiée";
  if (status.state === "ok") return `Connecté${status.version ? ` (Ollama ${status.version})` : ""} · ${status.latencyMs} ms · vérifié le ${date(status.checkedAt)}`;
  return `${errorLabel(status.code)} : ${status.message} · vérifié le ${date(status.checkedAt)}`;
}

export const SOURCE_LABELS = { agent: "propre au ΞAgent", global: "configuration globale", environment: "serveur de l’installation" } as const;

export function resolutionText(resolution: Resolution) {
  if (!resolution.ok) return `${errorLabel(resolution.code)} : ${resolution.message}`;
  const { instance, model, instanceSource, modelSource } = resolution.value;
  return `${instance.name} · ${model} (${SOURCE_LABELS[instanceSource]}${modelSource === "instance" ? ", modèle par défaut de l’instance" : ""})`;
}

/** JSON request with the API's `{ error }` message on failure; `status` kept for 409 handling. */
export class RequestError extends Error {
  constructor(message: string, readonly status: number, readonly data: Record<string, unknown>) { super(message); }
}
export async function request<T>(url: string, method = "GET", data?: unknown): Promise<T> {
  const response = await fetch(url, { method, cache: "no-store", ...(data === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }) });
  const result = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new RequestError(typeof result.error === "string" ? result.error : response.status === 429 ? "Trop de tests rapprochés. Réessayez dans un instant." : "Opération impossible. Réessayez.", response.status, result);
  return result as T;
}
