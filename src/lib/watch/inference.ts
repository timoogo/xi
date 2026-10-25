import { BlockList, isIP } from "node:net";
import { z } from "zod";
import type { LLMErrorCode } from "../llm/types";
import { createSafeFetch, FetchError } from "./net";

/**
 * Local inference only (Ollama, or a server exposing the OpenAI chat API, e.g. llama.cpp, LM Studio,
 * MLX on the Mac mini). There is no other provider and no fallback: an unreachable server makes the
 * tasks wait. The endpoint must resolve to loopback, a private network, Tailscale's CGNAT range, or
 * an IP address listed explicitly in XI_INFERENCE_ALLOW. Link-local (cloud metadata) is refused.
 */
/** Each error carries an `LLMErrorCode` (recorded in run histories); the class drives retries. */
export class InferenceUnavailableError extends Error {
  name = "InferenceUnavailableError";
  constructor(message: string, readonly retryAt: number | null = null, readonly code: LLMErrorCode = "unreachable") { super(message); }
}
export class InferenceConfigError extends Error {
  name = "InferenceConfigError";
  constructor(message: string, readonly code: LLMErrorCode = "bad-url") { super(message); }
}
export class InferenceOutputError extends Error {
  name = "InferenceOutputError";
  constructor(message: string, readonly code: LLMErrorCode = "invalid-response") { super(message); }
}

export type ChatRequest = { model: string; system: string; prompt: string };
/** Seam for tests: a deterministic fake implements the same contract. */
export type Inference = { complete(request: ChatRequest): Promise<string> };

const local = new BlockList();
for (const [network, prefix] of [["127.0.0.0", 8], ["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["100.64.0.0", 10]] as const) local.addSubnet(network, prefix, "ipv4");
local.addAddress("::1", "ipv6");
local.addSubnet("fc00::", 7, "ipv6");

export function isLocalAddress(address: string) {
  const family = isIP(address);
  return family !== 0 && local.check(address, family === 4 ? "ipv4" : "ipv6");
}

export type InferenceConfig = { url: string; api: "ollama" | "openai"; defaultModel: string | null; allow: string[]; timeoutMs: number };

/** Null when XI_INFERENCE_URL is unset: evaluation is then simply not planned. */
export function inferenceConfigFromEnv(env: Record<string, string | undefined> = process.env): InferenceConfig | null {
  const url = env.XI_INFERENCE_URL?.trim();
  if (!url) return null;
  const allow = (env.XI_INFERENCE_ALLOW ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (allow.some(value => !isIP(value))) throw new InferenceConfigError("XI_INFERENCE_ALLOW n’accepte que des adresses IP explicites.", "blocked");
  const timeout = Number(env.XI_INFERENCE_TIMEOUT_MS ?? 180_000);
  return { url, api: env.XI_INFERENCE_API === "openai" ? "openai" : "ollama", defaultModel: env.XI_INFERENCE_MODEL?.trim() || null, allow, timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 600_000) : 180_000 };
}

const ollamaReply = z.object({ message: z.object({ content: z.string() }) });
const openAiReply = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1) });

export function createLocalInference(config: InferenceConfig, { resolve }: { resolve?: (host: string) => Promise<{ address: string; family: number }[]> } = {}): Inference {
  let base: URL;
  try { base = new URL(config.url.endsWith("/") ? config.url : config.url + "/"); } catch { throw new InferenceConfigError("XI_INFERENCE_URL invalide."); }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new InferenceConfigError("XI_INFERENCE_URL doit être une URL http(s) sans identifiants.");
  const literal = base.hostname.replace(/^\[|\]$/g, "");
  const allowed = new Set(config.allow);
  const accept = (address: string) => isLocalAddress(address) || allowed.has(address);
  if (isIP(literal) && !accept(literal)) throw new InferenceConfigError("Serveur d’inférence refusé : adresse non locale et non autorisée explicitement.", "blocked");
  const endpoint = new URL(config.api === "ollama" ? "api/chat" : "v1/chat/completions", base).href;
  const fetch = createSafeFetch({ allowAddress: accept, allowAnyPort: true, ...(resolve ? { resolve } : {}) });

  return {
    async complete({ model, system, prompt }) {
      const messages = [{ role: "system", content: system }, { role: "user", content: prompt }];
      // Deterministic decoding: same input, same output, so a resumed task does not drift.
      const body = config.api === "ollama"
        ? { model, messages, stream: false, format: "json", options: { temperature: 0, seed: 0 } }
        : { model, messages, stream: false, temperature: 0, seed: 0, response_format: { type: "json_object" } };
      let response;
      try {
        response = await fetch(endpoint, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", Accept: "application/json" }, timeoutMs: config.timeoutMs, maxBytes: 1_000_000, maxRedirects: 0 });
      } catch (error) {
        if (error instanceof FetchError && (error.code === "blocked-address" || error.code === "blocked-url" || error.code === "redirect")) throw new InferenceConfigError("Serveur d’inférence refusé : il doit rester local.", "blocked");
        const timeout = error instanceof FetchError && error.code === "timeout";
        throw new InferenceUnavailableError(timeout ? "Délai d’inférence dépassé." : "Serveur d’inférence injoignable.", null, timeout ? "timeout" : "unreachable");
      }
      if (response.status !== 200) throw new InferenceUnavailableError(`Serveur d’inférence : HTTP ${response.status}${response.status === 404 ? " (modèle absent ?)" : ""}.`, null, "http");
      let json: unknown;
      try { json = JSON.parse(response.body.toString("utf8")); } catch { throw new InferenceOutputError("Réponse du serveur d’inférence illisible."); }
      const parsed = config.api === "ollama" ? ollamaReply.safeParse(json) : openAiReply.safeParse(json);
      if (!parsed.success) throw new InferenceOutputError("Format de réponse du serveur d’inférence inattendu.");
      return "message" in parsed.data ? parsed.data.message.content : parsed.data.choices[0].message.content ?? "";
    },
  };
}

/** The JSON object of a reply, tolerating code fences or text around it. */
function extractJson(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new InferenceOutputError("Aucun objet JSON dans la réponse.");
  return JSON.parse(text.slice(start, end + 1));
}

/** Asks for JSON matching `schema`; one more attempt on invalid output, then InferenceOutputError. */
export async function askJson<T>(inference: Inference, request: ChatRequest, schema: z.ZodType<T>, attempts = 2): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const text = await inference.complete(attempt === 1 ? request : { ...request, prompt: `${request.prompt}\n\nTa réponse précédente était invalide. Réponds uniquement par un objet JSON conforme au format demandé.` });
    try { return schema.parse(extractJson(text)); }
    catch { if (attempt >= attempts) throw new InferenceOutputError("Réponse du modèle non conforme au format attendu."); }
  }
}
