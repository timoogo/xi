import { z } from "zod";
import { InferenceConfigError, InferenceOutputError, InferenceUnavailableError } from "../watch/inference";
import { FetchError, type Fetcher, type FetchResponse } from "../watch/net";
import { createProviderFetch, InterruptedFetchError, validateBaseUrl, type DestinationPolicy } from "./network";
import type { ModelInfo, ResolvedInferenceOptions } from "./types";

/**
 * Ollama HTTP client, stateless. Endpoints: `GET /api/version` (connectivity, loads no model),
 * `GET /api/tags` (installed models) and `POST /api/chat` (non-streamed inference). It never pulls
 * a model. Only fields parsed by the schemas below are used: a server's raw body (Ollama or not)
 * is never echoed back, errors carry fixed French messages and an `LLMErrorCode`.
 */
export type OllamaClient = {
  version(opts?: { timeoutMs?: number }): Promise<{ version: string | null; latencyMs: number }>;
  models(opts?: { timeoutMs?: number }): Promise<ModelInfo[]>;
  chat(req: { model: string; system: string; prompt: string; options: ResolvedInferenceOptions; json: boolean }): Promise<string>;
};

const VERSION_TIMEOUT_MS = 5_000;
const TAGS_TIMEOUT_MS = 10_000;
const MAX_MODELS = 500;

const versionReply = z.object({ version: z.string().max(100) });
const optionalString = z.string().max(200).optional().catch(undefined);
const optionalNumber = z.number().nonnegative().optional().catch(undefined);
const tagEntry = z.object({
  name: z.string().min(1).max(200).optional().catch(undefined),
  model: z.string().min(1).max(200).optional().catch(undefined),
  size: optionalNumber,
  modified_at: optionalString,
  details: z.object({ family: optionalString, parameter_size: optionalString, quantization_level: optionalString }).optional().catch(undefined),
});
const tagsReply = z.object({ models: z.array(z.unknown()).max(10_000) });
/**
 * `thinking`: reasoning of thinking models (qwen3, deepseek-r1…), returned apart from the answer.
 * It is never used as the answer. `done: false` or `done_reason: "length"` mean an unfinished answer.
 */
const chatReply = z.object({
  message: z.object({ content: z.string(), thinking: z.string().optional().catch(undefined) }),
  done: z.boolean().optional().catch(undefined),
  done_reason: z.string().max(50).optional().catch(undefined),
});
const errorReply = z.object({ error: z.string().max(2_000) });

const MEMORY = /requires more system memory|out of memory|insufficient memory|cudamalloc|not enough memory/i;
const CONTEXT = /context length|context window|exceeds|too long|too many tokens/i;
const MISSING = /model .*not found|not found, try pulling|no such model|pull the model/i;

/** The transport error is kept as `cause`: its system code (ECONNRESET…) is what diagnoses a failure. */
function fromFetch(error: unknown): never {
  const caused = <T extends Error>(wrapped: T) => Object.assign(wrapped, { cause: error });
  if (error instanceof InterruptedFetchError) throw caused(new InferenceUnavailableError("Connexion à Ollama interrompue pendant la réponse.", null, "interrupted"));
  if (error instanceof FetchError) {
    if (error.code === "redirect") throw caused(new InferenceConfigError("Redirection refusée : indiquez l’adresse directe du serveur Ollama.", "blocked"));
    if (error.code === "blocked-address" || error.code === "blocked-url") throw caused(new InferenceConfigError("Destination refusée : le serveur doit être sur le réseau local ou autorisé par l’opérateur.", "blocked"));
    if (error.code === "timeout") throw caused(new InferenceUnavailableError("Délai de réponse d’Ollama dépassé.", null, "timeout"));
    if (error.code === "too-large") throw caused(new InferenceOutputError("Réponse d’Ollama trop volumineuse.", "invalid-response"));
  }
  throw caused(new InferenceUnavailableError("Serveur Ollama injoignable (connexion refusée, nom introuvable ou réseau indisponible).", null, "unreachable"));
}

/** Non-200 status: Ollama explains in `{error}`; only its category is used, never its text. */
function fromStatus(response: FetchResponse, model: string | null): never {
  let explanation = "";
  try { explanation = errorReply.parse(JSON.parse(response.body.toString("utf8"))).error; } catch { /* not an Ollama error body */ }
  if (model && (MISSING.test(explanation) || (response.status === 404 && !explanation))) {
    throw new InferenceConfigError(`Modèle « ${model.slice(0, 200)} » non installé sur ce serveur Ollama. Installez-le avec « ollama pull ${model.slice(0, 200)} » puis actualisez la liste.`, "model-missing");
  }
  if (MEMORY.test(explanation)) throw new InferenceUnavailableError("Mémoire insuffisante sur le serveur Ollama pour charger ce modèle : choisissez un modèle plus léger ou libérez de la mémoire.", null, "out-of-memory");
  if (CONTEXT.test(explanation)) throw new InferenceOutputError("Contexte trop grand pour ce modèle : réduisez la taille de contexte ou la quantité de texte.", "context-too-large");
  if (response.status >= 500) throw new InferenceUnavailableError(`Serveur Ollama en erreur (HTTP ${response.status}).`, null, "http");
  throw new InferenceConfigError(`Requête refusée par le serveur (HTTP ${response.status}) : vérifiez qu’il s’agit bien d’un serveur Ollama.`, "http");
}

function json(response: FetchResponse): unknown {
  try { return JSON.parse(response.body.toString("utf8")); }
  catch { throw new InferenceOutputError("Réponse illisible : ce serveur ne répond pas comme Ollama.", "invalid-response"); }
}

function toModel(raw: unknown): ModelInfo | null {
  const parsed = tagEntry.safeParse(raw);
  if (!parsed.success) return null;
  const entry = parsed.data;
  const name = entry.name ?? entry.model;
  if (!name) return null;
  return {
    name,
    sizeBytes: entry.size ?? null,
    family: entry.details?.family || null,
    parameterSize: entry.details?.parameter_size || null,
    quantization: entry.details?.quantization_level || null,
    contextLength: null,
    modifiedAt: entry.modified_at || null,
  };
}

/** Throws InferenceConfigError ("bad-url" or "blocked") at once when the URL is refused. */
export function createOllamaClient({ baseUrl, policy, fetch }: { baseUrl: string; policy: DestinationPolicy; fetch?: Fetcher }): OllamaClient {
  const base = validateBaseUrl(baseUrl, policy);
  const request = fetch ?? createProviderFetch(policy);
  const endpoint = (path: string) => new URL(path, base).href;
  async function call(path: string, init: { method: "GET" | "POST"; body?: string; timeoutMs: number; maxBytes: number; model?: string }) {
    let response: FetchResponse;
    try {
      response = await request(endpoint(path), { method: init.method, body: init.body, headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) }, timeoutMs: init.timeoutMs, maxBytes: init.maxBytes, maxRedirects: 0 });
    } catch (error) { fromFetch(error); }
    if (response.status !== 200) fromStatus(response, init.model ?? null);
    return json(response);
  }

  return {
    async version({ timeoutMs = VERSION_TIMEOUT_MS } = {}) {
      const started = performance.now();
      const parsed = versionReply.safeParse(await call("api/version", { method: "GET", timeoutMs, maxBytes: 16_000 }));
      if (!parsed.success) throw new InferenceOutputError("Ce serveur ne répond pas comme Ollama (version absente).", "invalid-response");
      return { version: parsed.data.version || null, latencyMs: Math.round(performance.now() - started) };
    },
    async models({ timeoutMs = TAGS_TIMEOUT_MS } = {}) {
      const parsed = tagsReply.safeParse(await call("api/tags", { method: "GET", timeoutMs, maxBytes: 2_000_000 }));
      if (!parsed.success) throw new InferenceOutputError("Liste des modèles illisible : ce serveur ne répond pas comme Ollama.", "invalid-response");
      const models = parsed.data.models.map(toModel).filter((model): model is ModelInfo => model !== null);
      const unique = models.filter((model, index) => models.findIndex(other => other.name === model.name) === index);
      return unique.sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_MODELS);
    },
    async chat({ model, system, prompt, options, json: structured }) {
      // Deterministic decoding (seed 0): the same input gives the same output, so a resumed task does not drift.
      const body = {
        model, stream: false,
        messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
        ...(structured ? { format: "json" } : {}),
        // Answers are short structured objects: reasoning would spend the generation limit
        // (num_predict counts thinking tokens) before the JSON starts. Ignored by models without it.
        think: false,
        options: { temperature: options.temperature, num_predict: options.maxTokens, seed: 0, ...(options.contextSize ? { num_ctx: options.contextSize } : {}) },
      };
      const parsed = chatReply.safeParse(await call("api/chat", { method: "POST", body: JSON.stringify(body), timeoutMs: options.timeoutMs, maxBytes: 1_000_000, model }));
      if (!parsed.success) throw new InferenceOutputError("Format de réponse d’Ollama inattendu.", "invalid-response");
      const { message, done, done_reason: reason } = parsed.data;
      const unfinished = done === false || reason === "length";
      if (unfinished && !message.content.trim() && message.thinking?.trim()) {
        throw new InferenceOutputError(`Réponse incomplète : le modèle a épuisé la limite de génération (${options.maxTokens} tokens) en raisonnement (thinking) sans produire de réponse.`, "truncated");
      }
      if (structured && unfinished) throw new InferenceOutputError(`Réponse incomplète : la génération s’est arrêtée (${reason === "length" ? `limite de ${options.maxTokens} tokens atteinte` : "réponse non terminée"}) avant la fin de l’objet JSON.`, "truncated");
      if (structured && !message.content.trim()) throw new InferenceOutputError("Réponse vide du modèle : aucun objet JSON produit.", "invalid-json");
      return message.content;
    },
  };
}
