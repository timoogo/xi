import type { Inference } from "../watch/inference";
import type { Fetcher } from "../watch/net";
import { generationLimit } from "../watch/stages";
import type { DestinationPolicy } from "./network";
import { createOllamaClient } from "./ollama";
import type { LLMProviderType, ResolvedInferenceOptions } from "./types";

/**
 * An `Inference` bound to one resolved provider instance and its parameters (see resolve.ts).
 * Engine code only sees `complete({ model, system, prompt })`, which asks for a JSON answer: the
 * caller still validates it with its schema (`askJson`).
 */
export function bindInference({ type, baseUrl, policy, options, fetch }: { type: LLMProviderType; baseUrl: string; policy: DestinationPolicy; options: ResolvedInferenceOptions; fetch?: Fetcher }): Inference {
  switch (type) {
    case "ollama": {
      const client = createOllamaClient({ baseUrl, policy, fetch });
      // Each editorial step gets at least the budget its JSON answer needs (stages.ts).
      return { complete: ({ model, system, prompt, stage }) => client.chat({ model, system, prompt, options: { ...options, maxTokens: generationLimit(options.maxTokens, stage) }, json: true }) };
    }
  }
}
