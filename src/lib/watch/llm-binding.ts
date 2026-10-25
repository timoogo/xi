import type { WatchAgent } from "../accounts/types";
import type { AgentLLMSettings, LLMErrorCode, ResolutionProblemCode, ResolvedLLM } from "../llm/types";
import { InferenceConfigError, type Inference } from "./inference";

/**
 * What a watch task needs to call the model of one agent: an `Inference` bound to the resolved
 * instance, model and options (llm/server.ts `bind`), or the configuration problem, reported as
 * is in the run history. Handlers never see a URL or build a client themselves.
 */
export type LLMBinding =
  | { ok: true; inference: Inference; resolved: ResolvedLLM }
  | { ok: false; code: ResolutionProblemCode | LLMErrorCode; message: string };
export type BindLLM = (agent: WatchAgent) => LLMBinding;

/** The agent's `llm` key, or for agents saved before it, their legacy model reference as a model override. */
export function agentLLMSettings(agent: Pick<WatchAgent, "modelRef"> & { llm?: AgentLLMSettings }): AgentLLMSettings {
  return agent.llm ?? { config: { instanceId: null, model: agent.modelRef, options: {} }, revision: null, valid: true, legacy: !!agent.modelRef };
}

/** "qwen3:8b sur Ollama — Raspberry Pi (configuration globale)" for logs and results. */
export function describeLLM(resolved: ResolvedLLM) {
  const source = resolved.instanceSource === "agent" ? "instance du ΞAgent" : resolved.instanceSource === "global" ? "configuration globale" : "serveur de l’installation";
  return `${resolved.model} sur ${resolved.instance.name} (${source}${resolved.modelSource === "agent" ? ", modèle choisi pour le ΞAgent" : ""})`;
}

/** Whether planning inference tasks is useful: bound, or a real configuration problem to surface in the history. */
export const shouldPlanInference = (binding: LLMBinding) => binding.ok || binding.code !== "not-configured";

/** Binding a refused instance URL throws InferenceConfigError: reported as a configuration problem, like any other. */
export function bindSafely(llm: BindLLM, agent: WatchAgent): LLMBinding {
  try { return llm(agent); }
  catch (error) {
    if (!(error instanceof InferenceConfigError)) throw error;
    const code = (error as { code?: unknown }).code;
    return { ok: false, code: typeof code === "string" ? code as LLMErrorCode : "invalid-config", message: error.message };
  }
}
