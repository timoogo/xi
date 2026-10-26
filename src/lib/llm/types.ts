import { z } from "zod";

/**
 * LLM providers: shared contract (client-safe, no server import).
 *
 * Layers, each in its own module:
 * 1. provider definition — `LLMProviderType` (only "ollama" for now);
 * 2. connection to an instance — `network.ts` (destination policy) + `ollama.ts` (HTTP client);
 * 3. available models — `ollama.ts` (`GET /api/tags`), cached on the instance row by `store.ts`;
 * 4. global configuration — `store.ts`: the owner's instances and default instance (SQLite);
 * 5. per-agent selection — `AgentLLMConfig`, top-level `llm` key of the agent's generator file;
 * 6. inference parameters — `InferenceOptions`, built-in ← instance ← agent;
 * 7. execution — `resolve.ts` (which instance, model, options) then `inference.ts` (an `Inference`
 *    bound to that resolution). Agents never hold an HTTP client or a URL.
 *
 * "Global" is per account: Ξ has no installation administrator, so each owner configures their
 * own instances; another owner's instances are never visible nor usable. The operator's
 * environment server (XI_INFERENCE_URL) remains the installation-level default for owners who
 * have chosen no default instance (see `resolve.ts`), and is shown as such in the interface.
 */

export const LLM_PROVIDER_TYPES = ["ollama"] as const;
export type LLMProviderType = (typeof LLM_PROVIDER_TYPES)[number];
export const PROVIDER_LABELS: Record<LLMProviderType, string> = { ollama: "Ollama" };

// ---------------------------------------------------------------- inference parameters

/**
 * Explicit inference parameters. Every field optional: an absent field inherits from the level
 * below (agent → instance → built-in defaults). Decoding stays deterministic (seed 0, fixed
 * internally) so a resumed task does not drift.
 */
export const inferenceOptionsSchema = z.object({
  /** 0 = deterministic; factual watch keeps it low. */
  temperature: z.number().min(0).max(2).optional(),
  /** Generation limit in tokens (Ollama `num_predict`). */
  maxTokens: z.number().int().min(16).max(32_768).optional(),
  /** Context window in tokens (Ollama `num_ctx`); absent = the model's own default. */
  contextSize: z.number().int().min(512).max(262_144).optional(),
  /** Whole-request deadline. */
  timeoutMs: z.number().int().min(5_000).max(600_000).optional(),
}).strict();
export type InferenceOptions = z.infer<typeof inferenceOptionsSchema>;
/** Fully resolved parameters handed to the client (contextSize stays optional: model default). */
export type ResolvedInferenceOptions = { temperature: number; maxTokens: number; contextSize: number | null; timeoutMs: number };
export const BUILTIN_INFERENCE_OPTIONS: ResolvedInferenceOptions = { temperature: 0, maxTokens: 2_048, contextSize: null, timeoutMs: 180_000 };

/** built-in ← instance ← agent; absent fields never erase a lower level. */
export function mergeInferenceOptions(...layers: (InferenceOptions | null | undefined)[]): ResolvedInferenceOptions {
  const merged: ResolvedInferenceOptions = { ...BUILTIN_INFERENCE_OPTIONS };
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.temperature !== undefined) merged.temperature = layer.temperature;
    if (layer.maxTokens !== undefined) merged.maxTokens = layer.maxTokens;
    if (layer.contextSize !== undefined) merged.contextSize = layer.contextSize;
    if (layer.timeoutMs !== undefined) merged.timeoutMs = layer.timeoutMs;
  }
  return merged;
}

// ---------------------------------------------------------------- instances (global, per owner)

/** Portable reference of an instance (YAML): unique per owner, stable across renames. */
export const instanceKeySchema = z.string().trim().min(1).max(60).regex(/^[a-z0-9][a-z0-9-]*$/, "Clé : minuscules, chiffres et tirets.");
export const modelNameSchema = z.string().trim().min(1).max(200);

/** Owner input when creating or editing an instance (the URL is validated again by `network.ts`). */
export const instanceInputSchema = z.object({
  type: z.enum(LLM_PROVIDER_TYPES),
  name: z.string().trim().min(1).max(120),
  key: instanceKeySchema,
  baseUrl: z.string().trim().min(1).max(500),
  enabled: z.boolean(),
  defaultModel: modelNameSchema.nullable(),
  options: inferenceOptionsSchema,
}).strict();
export type InstanceInput = z.infer<typeof instanceInputSchema>;

/** Metadata reported by Ollama (`/api/tags`); absent fields stay null, never guessed. */
export type ModelInfo = {
  name: string;
  sizeBytes: number | null;
  family: string | null;
  parameterSize: string | null;
  quantization: string | null;
  /** Only when the server reports it; `/api/tags` does not, so usually null. */
  contextLength: number | null;
  modifiedAt: string | null;
};

export type ConnectionStatus =
  | { state: "unknown" }
  | { state: "ok"; checkedAt: string; version: string | null; latencyMs: number }
  | { state: "error"; checkedAt: string; code: LLMErrorCode; message: string };

export type LLMInstance = InstanceInput & {
  id: string;
  owner: string;
  revision: string;
  createdAt: string;
  updatedAt: string;
  status: ConnectionStatus;
  /** Last discovered list (null until the first refresh). */
  models: ModelInfo[] | null;
  modelsAt: string | null;
};

/** The operator's environment server, read-only (its URL is never sent to the browser). */
export type EnvironmentInstance = { configured: boolean; api: "ollama" | "openai" | null; defaultModel: string | null; error: string | null };

export type LLMSettings = { defaultInstanceId: string | null; revision: string | null };

// ---------------------------------------------------------------- per-agent selection

/**
 * Top-level `llm` key of an agent's generator file (with revision metadata when stored).
 * - inherit (A): instanceId null, model null, options {};
 * - other model (B): instanceId null, model set — the global instance, another installed model;
 * - other instance (C): instanceId set (model null = that instance's default model).
 * Absent key: legacy agents — `editorial.modelRef`, when set, acts as a model override (B).
 */
export const agentLLMConfigSchema = z.object({
  instanceId: z.uuid().nullable(),
  model: modelNameSchema.nullable(),
  options: inferenceOptionsSchema,
}).strict();
export type AgentLLMConfig = z.infer<typeof agentLLMConfigSchema>;
export const INHERIT_LLM: AgentLLMConfig = { instanceId: null, model: null, options: {} };
export type AgentLLMMode = "inherit" | "model" | "instance";
export const agentLLMMode = (config: AgentLLMConfig): AgentLLMMode => config.instanceId ? "instance" : config.model ? "model" : "inherit";
export const storedAgentLLMSchema = agentLLMConfigSchema.extend({ revision: z.uuid(), updatedAt: z.iso.datetime(), updatedBy: z.string().min(1) });
/** `valid: false`: unreadable `llm` key — reported as a configuration problem, never guessed. */
export type AgentLLMSettings = { config: AgentLLMConfig; revision: string | null; valid: boolean; legacy: boolean };

// ---------------------------------------------------------------- resolution

export type ResolutionSource = "agent" | "global" | "environment";
export type ResolvedLLM = {
  /** Where the instance came from. */
  instanceSource: ResolutionSource;
  /** Where the model came from: the agent, or the instance's default. */
  modelSource: "agent" | "instance";
  /** Environment instance: id "environment", key "environment". */
  instance: { id: string; key: string; name: string; type: LLMProviderType | "openai" };
  model: string;
  options: ResolvedInferenceOptions;
};
export type ResolutionProblemCode = "not-configured" | "instance-missing" | "instance-disabled" | "no-model" | "invalid-config";
export type Resolution = { ok: true; value: ResolvedLLM } | { ok: false; code: ResolutionProblemCode; message: string };

/** Summary for the browser (no URL). */
export type AgentLLMView = { settings: AgentLLMSettings; resolution: Resolution };

// ---------------------------------------------------------------- errors

/**
 * Inference error codes, recorded in run histories. The thrown classes stay those of
 * `watch/inference.ts` (InferenceUnavailableError: wait without consuming an attempt;
 * InferenceConfigError: owner action needed; InferenceOutputError: bounded retries), each
 * carrying one of these codes.
 */
export const LLM_ERROR_CODES = [
  "unreachable", "bad-url", "blocked", "timeout", "model-missing", "invalid-response",
  "context-too-large", "out-of-memory", "interrupted", "disabled", "not-configured", "http",
  // Model output problems, distinguished for diagnosis: cut by the generation limit, not JSON, JSON off the schema.
  "truncated", "invalid-json", "schema",
] as const;
export type LLMErrorCode = (typeof LLM_ERROR_CODES)[number];
export const LLM_ERROR_LABELS: Record<LLMErrorCode, string> = {
  unreachable: "Serveur injoignable",
  "bad-url": "URL incorrecte",
  blocked: "Destination refusée",
  timeout: "Délai dépassé",
  "model-missing": "Modèle non installé",
  "invalid-response": "Réponse invalide",
  "context-too-large": "Contexte trop grand",
  "out-of-memory": "Mémoire insuffisante",
  interrupted: "Connexion interrompue",
  disabled: "Instance désactivée",
  "not-configured": "Aucune configuration",
  http: "Erreur du serveur",
  truncated: "Réponse tronquée",
  "invalid-json": "JSON invalide",
  schema: "Réponse hors format",
};

// ---------------------------------------------------------------- explicit test

export type ModelTestResult = { ok: true; latencyMs: number; model: string; instance: string; reply: string } | { ok: false; latencyMs: number | null; code: LLMErrorCode | ResolutionProblemCode; message: string };

// ---------------------------------------------------------------- creation draft

/**
 * `AgentDraft.llm` (xiagents/draft.ts). `unresolvedKey`: instance key read from a YAML file that
 * matches none of the owner's instances — blocks deployment until the owner maps it to one of
 * their instances or to the global configuration (never dropped, never guessed).
 */
export type AgentLLMDraft = { instanceId: string | null; unresolvedKey: string | null; model: string; options: InferenceOptions };
export const INHERIT_LLM_DRAFT: AgentLLMDraft = { instanceId: null, unresolvedKey: null, model: "", options: {} };

// ---------------------------------------------------------------- HTTP contract (owner-only routes)

/** GET /api/llm/instances */
export type InstancesResponse = { instances: LLMInstance[]; settings: LLMSettings; environment: EnvironmentInstance };
/** GET /api/llm/instances/<id>/dependencies — agents that would lose their instance. */
export type InstanceDependencies = { isDefault: boolean; agents: { id: string; handle: string; name: string; reason: "explicit" | "inherits-default" }[] };
/**
 * DELETE /api/llm/instances/<id> body. `reassignTo`: another instance id, "global" (explicit
 * agents go back to inheriting), or "none" (they keep the dangling reference and show a
 * configuration problem). Required as soon as there are dependencies.
 */
export const deleteInstanceSchema = z.object({ confirm: z.literal(true), reassignTo: z.union([z.uuid(), z.literal("global"), z.literal("none")]).optional() }).strict();
