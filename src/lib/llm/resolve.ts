import type { LLMStore } from "./store";
import { BUILTIN_INFERENCE_OPTIONS, mergeInferenceOptions, type AgentLLMSettings, type Resolution, type ResolutionSource } from "./types";

/** The operator's environment server (XI_INFERENCE_URL), when its configuration is accepted. */
export type EnvironmentServer = { url: string; api: "ollama" | "openai"; defaultModel: string | null; timeoutMs?: number } | null;
export const ENVIRONMENT_INSTANCE = { id: "environment", key: "environment", name: "Serveur de l’installation" } as const;

/**
 * Which instance, model and parameters an agent (or the owner, `agent: null`) uses. Strict order,
 * no fallback between levels once one is chosen:
 * 1. the agent's explicit instance;
 * 2. the owner's default instance;
 * 3. only when the owner chose no default instance: the operator's environment server;
 * 4. otherwise a "not-configured" problem.
 * A missing or disabled instance is a problem, never a reason to try another one. The model is
 * the agent's choice, else the instance's default; never an arbitrary installed model.
 */
export function resolveLLM({ store, owner, agent, environment }: { store: LLMStore; owner: string; agent: AgentLLMSettings | null; environment: EnvironmentServer }): Resolution {
  if (agent && !agent.valid) return { ok: false, code: "invalid-config", message: "Configuration IA du ΞAgent illisible : réenregistrez-la depuis sa page." };
  const config = agent?.config ?? null;
  const pick = (id: string, source: ResolutionSource): Resolution => {
    const instance = store.get(owner, id);
    const scope = source === "agent" ? "du ΞAgent" : "par défaut";
    if (!instance) return { ok: false, code: "instance-missing", message: `L’instance IA ${scope} n’existe plus : choisissez-en une autre.` };
    if (!instance.enabled) return { ok: false, code: "instance-disabled", message: `L’instance IA ${scope} « ${instance.name} » est désactivée.` };
    const model = config?.model ?? instance.defaultModel;
    if (!model) return { ok: false, code: "no-model", message: `Aucun modèle : choisissez un modèle pour le ΞAgent ou un modèle par défaut pour « ${instance.name} ».` };
    return { ok: true, value: {
      instanceSource: source, modelSource: config?.model ? "agent" : "instance",
      instance: { id: instance.id, key: instance.key, name: instance.name, type: instance.type },
      model, options: mergeInferenceOptions(instance.options, config?.options),
    } };
  };
  if (config?.instanceId) return pick(config.instanceId, "agent");
  const { defaultInstanceId } = store.settings(owner);
  if (defaultInstanceId) return pick(defaultInstanceId, "global");
  if (environment) {
    const model = config?.model ?? environment.defaultModel;
    if (!model) return { ok: false, code: "no-model", message: "Aucun modèle : choisissez un modèle pour le ΞAgent ou définissez XI_INFERENCE_MODEL." };
    return { ok: true, value: {
      instanceSource: "environment", modelSource: config?.model ? "agent" : "instance",
      instance: { ...ENVIRONMENT_INSTANCE, type: environment.api }, model,
      options: mergeInferenceOptions({ timeoutMs: environment.timeoutMs ?? BUILTIN_INFERENCE_OPTIONS.timeoutMs }, config?.options),
    } };
  }
  return { ok: false, code: "not-configured", message: "Aucune instance IA : ajoutez une instance Ollama dans Paramètres → Intelligence artificielle et choisissez-la par défaut." };
}
