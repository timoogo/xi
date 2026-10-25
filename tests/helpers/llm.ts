import { BUILTIN_INFERENCE_OPTIONS } from "../../src/lib/llm/types";
import type { Inference } from "../../src/lib/watch/inference";
import { agentLLMSettings, type BindLLM } from "../../src/lib/watch/llm-binding";

/**
 * Test binding: a fake `Inference` stands in for the resolved instance; the model is the agent's
 * own (legacy `modelRef` or `llm.model`), else `defaultModel`, else "not configured".
 */
export const bindTo = (inference: Inference | null, defaultModel: string | null = null): BindLLM => agent => {
  const own = agentLLMSettings(agent).config.model;
  const model = own ?? defaultModel;
  if (!inference || !model) return { ok: false, code: "not-configured", message: "Inférence locale non configurée." };
  return { ok: true, inference, resolved: { instanceSource: "global", modelSource: own ? "agent" : "instance", instance: { id: "test", key: "test", name: "Instance de test", type: "ollama" }, model, options: BUILTIN_INFERENCE_OPTIONS } };
};
