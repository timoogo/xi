/** Steps that call the model: named in inference logs, each with the budget its answer needs. */
export const INFERENCE_STAGES = ["relevance", "merge", "novelty", "extraction", "draft", "consistency", "concepts", "idea"] as const;
export type InferenceStage = (typeof INFERENCE_STAGES)[number];

/**
 * Minimum generation limit (tokens, Ollama `num_predict`) for each step's JSON answer, at about
 * 3.5 characters per token in French. A configured `maxTokens` below it is raised for that step
 * only, never lowered: an answer cut by the limit is unusable (no JSON), it costs the whole
 * generation time and then fails. Extraction: up to 12 claims, each with its text, kind,
 * attribution and verbatim quotes, about 110 to 140 tokens per claim. Draft: a thread of up to
 * 10 messages of 280 characters with their claim labels. Concepts (Konstruktor, topic discovery): up to
 * 12 concepts of about 55 tokens (label and one quoted sentence) and 8 relations of about 95 tokens. Idea
 * (Konstruktor, creation from an idea): 5 topics with a one-sentence scope and their domains.
 */
export const STAGE_MIN_TOKENS: Record<InferenceStage, number> = {
  relevance: 512,
  merge: 384,
  novelty: 768,
  extraction: 2_048,
  draft: 1_536,
  consistency: 512,
  concepts: 1_536,
  idea: 1_024,
};

export const generationLimit = (maxTokens: number, stage?: InferenceStage) => Math.max(maxTokens, stage ? STAGE_MIN_TOKENS[stage] : 0);
