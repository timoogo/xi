"use client";
import { useId } from "react";
import { mergeInferenceOptions, type AgentLLMDraft } from "@/lib/llm/types";
import { selectClass, type InstanceChoice } from "./format";
import { ModelPicker } from "./model-picker";
import { OptionsFields } from "./options-fields";

const GLOBAL = "";

/** Short text for the « Paramètres avancés » summary of the creation dialog. */
export function llmDraftSummary(draft: AgentLLMDraft, instances: InstanceChoice[] | null) {
  if (draft.unresolvedKey) return `instance « ${draft.unresolvedKey} » à choisir`;
  const instance = draft.instanceId ? instances?.find(item => item.id === draft.instanceId)?.name ?? "instance inconnue" : null;
  if (!instance && !draft.model) return "IA héritée";
  return [instance ?? "instance globale", draft.model || "modèle par défaut"].join(" · ");
}

/**
 * LLM choice of a draft agent: global instance or one of the owner's, model (empty = default),
 * advanced parameters. An instance key imported from YAML that matches none of the owner's
 * instances must be mapped explicitly before deployment.
 */
export function LLMDraftPicker({ value, onChange, instances, defaultInstanceId, error }: {
  value: AgentLLMDraft; onChange: (value: AgentLLMDraft) => void; instances: InstanceChoice[] | null; defaultInstanceId: string | null; error?: string;
}) {
  const id = useId();
  const list = instances ?? [];
  const target = list.find(item => item.id === (value.instanceId ?? defaultInstanceId)) ?? null;
  return <fieldset className="space-y-2 rounded-md border p-2 text-sm" aria-describedby={error ? `${id}-error` : undefined}>
    <legend className="px-1 font-medium">Intelligence artificielle</legend>
    {value.unresolvedKey && <div role="alert" className="space-y-1 rounded-md border border-destructive p-2">
      <p className="font-medium text-destructive">Instance « {value.unresolvedKey} » introuvable sur cette installation.</p>
      <p className="text-xs">Choisissez explicitement l’une de vos instances ou la configuration globale ci-dessous ; le déploiement attend ce choix.</p>
    </div>}
    <div className="grid gap-1">
      <label htmlFor={`${id}-instance`} className="text-xs font-medium">Instance</label>
      <select id={`${id}-instance`} className={selectClass} value={value.unresolvedKey ? "\u0000unresolved" : value.instanceId ?? GLOBAL}
        onChange={event => onChange({ ...value, unresolvedKey: null, instanceId: event.target.value === GLOBAL ? null : event.target.value })}>
        {value.unresolvedKey && <option value={"\u0000unresolved"} disabled>« {value.unresolvedKey} » — à remplacer</option>}
        <option value={GLOBAL}>Configuration globale{defaultInstanceId ? ` (${list.find(item => item.id === defaultInstanceId)?.name ?? "instance par défaut"})` : ""}</option>
        {list.map(item => <option key={item.id} value={item.id}>{item.name}{item.enabled ? "" : " (désactivée)"}</option>)}
        {value.instanceId && !list.some(item => item.id === value.instanceId) && <option value={value.instanceId}>Instance inconnue</option>}
      </select>
      {instances === null && <p className="text-xs text-muted-foreground">Chargement de vos instances…</p>}
    </div>
    <div className="grid gap-1">
      <label htmlFor={`${id}-model`} className="text-xs font-medium">Modèle</label>
      <ModelPicker key={target?.id ?? "none"} id={`${id}-model`} models={target?.models ?? null} value={value.model}
        empty={`modèle par défaut${target?.defaultModel ? ` (${target.defaultModel})` : ""}`} onChange={model => onChange({ ...value, model })} />
    </div>
    <OptionsFields value={value.options} onChange={options => onChange({ ...value, options })} inherited={mergeInferenceOptions(target?.options)} inheritedFrom={target ? `réglages de ${target.name}` : "configuration globale"} />
    {error && <p id={`${id}-error`} className="text-xs text-destructive">{error}</p>}
  </fieldset>;
}
