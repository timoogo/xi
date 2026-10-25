"use client";
import { useId, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { agentLLMMode, INHERIT_LLM, mergeInferenceOptions, type AgentLLMConfig, type AgentLLMMode, type AgentLLMView, type EnvironmentInstance, type ModelTestResult } from "@/lib/llm/types";
import { errorLabel, MODE_LABELS, request, RequestError, selectClass, SOURCE_LABELS, type InstanceChoice } from "./format";
import { ModelPicker } from "./model-picker";
import { OptionsFields } from "./options-fields";

/** Summary of what an agent will use; pure, shared by the panel and the tests. */
export function AgentLLMSummary({ view }: { view: AgentLLMView }) {
  const { settings, resolution } = view;
  const mode = MODE_LABELS[agentLLMMode(settings.config)];
  return <div className="space-y-1 text-sm">
    {resolution.ok ? <dl className="grid gap-x-3 gap-y-1 sm:grid-cols-[auto_1fr]">
      <dt className="text-muted-foreground">Instance</dt><dd className="break-words">{resolution.value.instance.name} <span className="text-xs text-muted-foreground">({SOURCE_LABELS[resolution.value.instanceSource]})</span></dd>
      <dt className="text-muted-foreground">Modèle</dt><dd className="break-all">{resolution.value.model}{resolution.value.modelSource === "instance" && <span className="text-xs text-muted-foreground"> (modèle par défaut de l’instance)</span>}</dd>
      <dt className="text-muted-foreground">Configuration</dt><dd>{mode}{settings.legacy && " (référence de modèle d’une version précédente)"}</dd>
    </dl> : <div role="alert" className="space-y-1 rounded-md border border-destructive p-2">
      <p className="font-medium text-destructive"><span aria-hidden="true">⚠ </span>Problème de configuration : {errorLabel(resolution.code)}</p>
      <p>{resolution.message}</p>
      <p className="text-xs">Configuration : {mode}. Évaluation et rédaction restent en attente, visiblement dans l’historique, sans basculer vers un autre serveur ou modèle.</p>
    </div>}
    {!settings.valid && <p className="text-destructive">La configuration enregistrée est illisible : choisissez-en une nouvelle.</p>}
  </div>;
}

/**
 * « Intelligence artificielle » card of an agent: which instance and model its runs will use,
 * an explicit model test (never automatic, never publishes nor edits), and the three choices:
 * inherit, another model on the global instance, or another instance.
 */
export function AgentLLMPanel({ agentId, initial, instances, defaultInstanceId, environment }: {
  agentId: string; initial: AgentLLMView; instances: InstanceChoice[]; defaultInstanceId: string | null; environment: EnvironmentInstance;
}) {
  const [view, setView] = useState(initial);
  const [editing, setEditing] = useState<AgentLLMConfig | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [test, setTest] = useState<ModelTestResult | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function runTest() {
    setBusy("test"); setTest(null); setError(""); setNotice("");
    try { setTest(await request<ModelTestResult>(`/api/xiagents/${agentId}/llm/test`, "POST", {})); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Test impossible."); }
    finally { setBusy(null); }
  }
  async function save(config: AgentLLMConfig) {
    setBusy("save"); setError(""); setNotice("");
    try {
      setView(await request<AgentLLMView>(`/api/xiagents/${agentId}/llm`, "PUT", { revision: view.settings.revision, config }));
      setEditing(null); setTest(null); setNotice("Configuration IA enregistrée. Elle s’applique aux prochaines tâches.");
    } catch (caught) {
      if (caught instanceof RequestError && caught.status === 409) {
        setView(await request<AgentLLMView>(`/api/xiagents/${agentId}/llm`).catch(() => view));
        setError("La configuration a été modifiée ailleurs : elle a été rechargée, vérifiez-la avant d’enregistrer de nouveau.");
      } else setError(caught instanceof Error ? caught.message : "Enregistrement impossible.");
    } finally { setBusy(null); }
  }

  return <section aria-labelledby="agent-llm-title" className="space-y-3 border-b p-4">
    <h2 id="agent-llm-title" className="text-lg font-bold">Intelligence artificielle</h2>
    <AgentLLMSummary view={view} />
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="outline" disabled={busy !== null || !view.resolution.ok} onClick={() => void runTest()}>{busy === "test" ? "Test en cours…" : "Tester le modèle"}</Button>
      {!editing && <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => { setEditing(view.settings.valid ? view.settings.config : INHERIT_LLM); setNotice(""); }}>Modifier</Button>}
      <Link href="/dashboard/settings#llm-title" className="self-center text-sm underline">Configuration globale</Link>
    </div>
    <div aria-live="polite" className="text-sm">
      {test && <ModelTestOutcome result={test} />}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
    {editing && <AgentLLMForm value={editing} onChange={setEditing} instances={instances} defaultInstanceId={defaultInstanceId} environment={environment} busy={busy !== null} onCancel={() => setEditing(null)} onSubmit={() => void save(editing)} />}
  </section>;
}

export function ModelTestOutcome({ result }: { result: ModelTestResult }) {
  if (result.ok) return <div role="status" className="space-y-1 rounded-md border p-2">
    <p><span aria-hidden="true">✓ </span><strong>Test réussi</strong> · {result.instance} · {result.model} · {result.latencyMs} ms</p>
    <p className="break-words text-muted-foreground">Réponse : « {result.reply.slice(0, 300)} »</p>
    <p className="text-xs text-muted-foreground">Requête courte de test : rien n’a été publié ni modifié.</p>
  </div>;
  return <p role="alert" className="text-destructive"><span aria-hidden="true">✗ </span><strong>Échec du test</strong> — {errorLabel(result.code)} : {result.message}{result.latencyMs !== null ? ` (${result.latencyMs} ms)` : ""}</p>;
}

function AgentLLMForm({ value, onChange, instances, defaultInstanceId, environment, busy, onSubmit, onCancel }: {
  value: AgentLLMConfig; onChange: (value: AgentLLMConfig) => void; instances: InstanceChoice[]; defaultInstanceId: string | null; environment: EnvironmentInstance;
  busy: boolean; onSubmit: () => void; onCancel: () => void;
}) {
  const id = useId();
  const [mode, setMode] = useState<AgentLLMMode>(agentLLMMode(value));
  const globalInstance = instances.find(item => item.id === defaultInstanceId) ?? null;
  const globalLabel = globalInstance ? `${globalInstance.name}${globalInstance.defaultModel ? ` — ${globalInstance.defaultModel}` : " — sans modèle par défaut"}${globalInstance.enabled ? "" : " (désactivée)"}`
    : environment.configured ? `serveur de l’installation${environment.defaultModel ? ` — ${environment.defaultModel}` : ""}` : "aucune instance par défaut";
  const chosen = value.instanceId ? instances.find(item => item.id === value.instanceId) ?? null : null;
  const target = mode === "instance" ? chosen : globalInstance;
  function pick(next: AgentLLMMode) {
    setMode(next);
    if (next === "inherit") onChange({ ...value, instanceId: null, model: null });
    if (next === "model") onChange({ ...value, instanceId: null });
    if (next === "instance") onChange({ ...value, instanceId: value.instanceId ?? instances.find(item => item.enabled && item.id !== defaultInstanceId)?.id ?? instances[0]?.id ?? null });
  }
  const incomplete = (mode === "model" && !value.model) || (mode === "instance" && !value.instanceId);
  const options: [AgentLLMMode, string, string][] = [
    ["inherit", "Hériter de la configuration globale", `Utilise ${globalLabel}.`],
    ["model", "Choisir un autre modèle", "Même instance que la configuration globale, autre modèle installé."],
    ["instance", "Choisir une autre instance", "Une autre instance Ollama et son modèle."],
  ];
  return <form className="space-y-3 rounded-md border p-3 text-sm" aria-label="Modifier la configuration IA du ΞAgent" onSubmit={event => { event.preventDefault(); onSubmit(); }}>
    <fieldset className="space-y-2"><legend className="font-medium">Modèle utilisé par ce ΞAgent</legend>
      {options.map(([key, label, hint]) => <label key={key} className="flex items-start gap-2">
        <input type="radio" className="mt-1" name={`${id}-mode`} checked={mode === key} disabled={key === "instance" && !instances.length} onChange={() => pick(key)} />
        <span>{label}<span className="block text-xs text-muted-foreground">{key === "instance" && !instances.length ? "Ajoutez d’abord une instance dans les paramètres." : hint}</span></span>
      </label>)}
    </fieldset>
    {mode === "instance" && <div className="grid gap-1">
      <label htmlFor={`${id}-instance`} className="text-xs font-medium">Instance</label>
      <select id={`${id}-instance`} className={selectClass} value={value.instanceId ?? ""} onChange={event => onChange({ ...value, instanceId: event.target.value || null, model: null })}>
        {!chosen && <option value={value.instanceId ?? ""}>{value.instanceId ? "Instance supprimée — choisissez-en une autre" : "Choisissez une instance"}</option>}
        {instances.map(item => <option key={item.id} value={item.id}>{item.name}{item.enabled ? "" : " (désactivée)"}</option>)}
      </select>
    </div>}
    {mode !== "inherit" && <div className="grid gap-1">
      <label htmlFor={`${id}-model`} className="text-xs font-medium">Modèle</label>
      <ModelPicker key={target?.id ?? "none"} id={`${id}-model`} models={target?.models ?? null} value={value.model ?? ""} disabled={busy}
        empty={mode === "instance" ? `modèle par défaut de l’instance${target?.defaultModel ? ` (${target.defaultModel})` : ""}` : undefined}
        describedBy={`${id}-model-hint`} onChange={model => onChange({ ...value, model: model.trim() || null })} />
      <p id={`${id}-model-hint`} className="text-xs text-muted-foreground">{target?.models ? `Modèles découverts sur ${target.name}.` : "Liste non découverte : testez la connexion de l’instance dans les paramètres, ou saisissez le nom exact."}</p>
    </div>}
    <OptionsFields value={value.options} onChange={next => onChange({ ...value, options: next })} inherited={mergeInferenceOptions(target?.options)} inheritedFrom={target ? `réglages de ${target.name}` : "valeurs par défaut"} disabled={busy} />
    <div className="flex flex-wrap gap-2">
      <Button type="submit" size="sm" disabled={busy || incomplete}>Enregistrer</Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Annuler</Button>
    </div>
  </form>;
}
