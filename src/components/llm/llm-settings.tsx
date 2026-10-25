"use client";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { mergeInferenceOptions, type InferenceOptions, type InstanceDependencies, type InstanceInput, type InstancesResponse, type LLMInstance } from "@/lib/llm/types";
import { InstanceCard, type InstanceAction } from "./instance-card";
import { ModelPicker } from "./model-picker";
import { OptionsFields } from "./options-fields";
import { request, RequestError, selectClass } from "./format";

/** Portable key derived from a name (accents dropped, lower case, dashes). */
export const keyFromName = (name: string) => name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

type Form = { name: string; key: string; keyEdited: boolean; baseUrl: string; enabled: boolean; defaultModel: string; options: InferenceOptions };
const emptyForm = (): Form => ({ name: "", key: "", keyEdited: false, baseUrl: "", enabled: true, defaultModel: "", options: {} });
const formOf = (instance: LLMInstance): Form => ({ name: instance.name, key: instance.key, keyEdited: true, baseUrl: instance.baseUrl, enabled: instance.enabled, defaultModel: instance.defaultModel ?? "", options: instance.options });
const inputOf = (form: Form): InstanceInput => ({ type: "ollama", name: form.name.trim(), key: form.key.trim(), baseUrl: form.baseUrl.trim(), enabled: form.enabled, defaultModel: form.defaultModel.trim() || null, options: form.options });

type Removal = { instance: LLMInstance; dependencies: InstanceDependencies; reassignTo: string };

/**
 * Settings → Intelligence artificielle: the owner's Ollama instances (global to the account),
 * the default one, discovery of their models and explicit connection tests. Nothing contacts a
 * server unless the owner asks (test, refresh); no model is ever downloaded from here.
 */
export function LLMSettings({ initial }: { initial: InstancesResponse }) {
  const [data, setData] = useState(initial);
  const [editing, setEditing] = useState<{ id: string | null; form: Form } | null>(null);
  const [removal, setRemoval] = useState<Removal | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const defaultId = data.settings.defaultInstanceId;

  async function act(key: string, task: () => Promise<string>) {
    setBusy(key); setNotice(""); setError("");
    try { setNotice(await task()); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Opération impossible."); }
    finally { setBusy(null); }
  }
  const reload = async () => setData(await request<InstancesResponse>("/api/llm/instances"));
  const replace = (instance: LLMInstance) => setData(current => ({ ...current, instances: current.instances.map(item => item.id === instance.id ? instance : item) }));

  async function setDefault(id: string | null) {
    await act("default", async () => {
      try {
        const { settings } = await request<{ settings: InstancesResponse["settings"] }>("/api/llm/settings", "PUT", { revision: data.settings.revision, defaultInstanceId: id });
        setData(current => ({ ...current, settings }));
      } catch (caught) { if (caught instanceof RequestError && caught.status === 409) await reload(); throw caught; }
      return id ? `Instance par défaut : ${data.instances.find(item => item.id === id)?.name}.` : "Aucune instance par défaut.";
    });
  }

  async function onAction(instance: LLMInstance, action: InstanceAction) {
    if (action === "edit") { setRemoval(null); setEditing({ id: instance.id, form: formOf(instance) }); return; }
    if (action === "default") return setDefault(instance.id);
    if (action === "check") return act(instance.id, async () => {
      // The server records the result even when the connection fails.
      try {
        const { instance: checked } = await request<{ instance: LLMInstance }>(`/api/llm/instances/${instance.id}/check`, "POST", {});
        replace(checked);
        return checked.status.state === "ok" ? `${checked.name} : connexion réussie, ${checked.models?.length ?? 0} modèle(s) trouvé(s).` : `${checked.name} : connexion impossible.`;
      } catch (caught) { await reload().catch(() => {}); throw caught; }
    });
    if (action === "toggle") return act(instance.id, async () => {
      const { instance: saved } = await request<{ instance: LLMInstance }>(`/api/llm/instances/${instance.id}`, "PATCH", { revision: instance.revision, ...inputOf({ ...formOf(instance), enabled: !instance.enabled }) });
      replace(saved);
      return saved.enabled ? `${saved.name} réactivée.` : `${saved.name} désactivée : les ΞAgents qui l’utilisent signaleront un problème de configuration.`;
    });
    if (action === "delete") return act(instance.id, async () => {
      setEditing(null);
      const dependencies = await request<InstanceDependencies>(`/api/llm/instances/${instance.id}/dependencies`);
      setRemoval({ instance, dependencies, reassignTo: "" });
      return "";
    });
  }

  async function remove(target: Removal) {
    await act(target.instance.id, async () => {
      const needsChoice = target.dependencies.agents.length > 0 || target.dependencies.isDefault;
      try {
        const result = await request<{ deleted: boolean; reassigned: number }>(`/api/llm/instances/${target.instance.id}`, "DELETE", { confirm: true, ...(needsChoice ? { reassignTo: target.reassignTo } : {}) });
        setRemoval(null); await reload();
        return `${target.instance.name} supprimée${result.reassigned ? `, ${result.reassigned} ΞAgent(s) réassigné(s)` : ""}.`;
      } catch (caught) {
        // New dependencies appeared since the confirmation: show them and ask again.
        if (caught instanceof RequestError && caught.status === 409 && caught.data.dependencies) setRemoval({ ...target, dependencies: caught.data.dependencies as InstanceDependencies, reassignTo: "" });
        throw caught;
      }
    });
  }

  async function save(id: string | null, form: Form) {
    await act("form", async () => {
      const input = inputOf(form);
      const current = id ? data.instances.find(item => item.id === id) : null;
      try {
        const { instance } = id ? await request<{ instance: LLMInstance }>(`/api/llm/instances/${id}`, "PATCH", { revision: current?.revision, ...input })
          : await request<{ instance: LLMInstance }>("/api/llm/instances", "POST", input);
        setEditing(null); await reload();
        return id ? `${instance.name} enregistrée.` : `${instance.name} ajoutée. Testez la connexion pour découvrir ses modèles.`;
      } catch (caught) { if (caught instanceof RequestError && caught.status === 409 && id) await reload(); throw caught; }
    });
  }

  const enabled = data.instances.filter(item => item.enabled);
  return <section aria-labelledby="llm-title" className="space-y-4 border-b p-4">
    <div className="space-y-1">
      <h2 id="llm-title" className="text-lg font-bold">Intelligence artificielle</h2>
      <p className="text-sm text-muted-foreground">Serveurs Ollama utilisés par vos ΞAgents pour analyser, vérifier et rédiger. Cette configuration est propre à votre compte ; chaque ΞAgent en hérite ou la personnalise. Les requêtes partent uniquement du serveur Ξ, vers votre réseau local.</p>
    </div>
    <div aria-live="polite" className="text-sm">{notice && <p role="status">{notice}</p>}{error && <p role="alert" className="text-destructive">{error}</p>}</div>

    <DefaultChoice instances={enabled} value={defaultId} disabled={busy !== null} onChange={setDefault} />
    {data.environment.configured && <p className="rounded-md border p-2 text-sm">
      <span className="font-medium">Serveur de l’installation</span> (configuré par l’opérateur, lecture seule){data.environment.defaultModel ? ` · modèle ${data.environment.defaultModel}` : " · aucun modèle par défaut"}.
      {" "}{defaultId ? "Non utilisé : votre instance par défaut le remplace." : "Utilisé tant que vous n’avez choisi aucune instance par défaut."}
      {data.environment.error && <span className="block text-destructive">Configuration refusée : {data.environment.error}</span>}
    </p>}

    {!data.instances.length && <p className="text-sm">Aucune instance configurée. Ajoutez votre serveur Ollama (par exemple sur un Raspberry Pi ou un Mac du réseau local).</p>}
    <div className="space-y-3">
      {data.instances.map(instance => <InstanceCard key={instance.id} instance={instance} isDefault={instance.id === defaultId} busy={busy !== null} onAction={action => void onAction(instance, action)}>
        {busy === instance.id && <p role="status" className="text-sm">Opération en cours…</p>}
        {editing?.id === instance.id && <InstanceForm form={editing.form} onChange={form => setEditing({ id: instance.id, form })} onCancel={() => setEditing(null)} onSubmit={() => void save(instance.id, editing.form)} busy={busy !== null} models={instance.models} editing />}
        {removal?.instance.id === instance.id && <RemovalPanel removal={removal} instances={enabled.filter(item => item.id !== instance.id)} busy={busy !== null} onChange={setRemoval} onCancel={() => setRemoval(null)} onConfirm={() => void remove(removal)} />}
      </InstanceCard>)}
    </div>
    {editing?.id === null ? <InstanceForm form={editing.form} onChange={form => setEditing({ id: null, form })} onCancel={() => setEditing(null)} onSubmit={() => void save(null, editing.form)} busy={busy !== null} models={null} />
      : <Button type="button" variant="outline" disabled={busy !== null} onClick={() => { setRemoval(null); setEditing({ id: null, form: emptyForm() }); }}>Ajouter une instance Ollama</Button>}
  </section>;
}

function DefaultChoice({ instances, value, disabled, onChange }: { instances: LLMInstance[]; value: string | null; disabled: boolean; onChange: (id: string | null) => void }) {
  const id = useId();
  return <div className="grid gap-1 sm:max-w-md">
    <label htmlFor={id} className="text-sm font-medium">Instance par défaut</label>
    <select id={id} className={selectClass} value={value ?? ""} disabled={disabled} aria-describedby={`${id}-hint`} onChange={event => onChange(event.target.value || null)}>
      <option value="">Aucune</option>
      {instances.map(instance => <option key={instance.id} value={instance.id}>{instance.name}{instance.defaultModel ? ` — ${instance.defaultModel}` : " — sans modèle par défaut"}</option>)}
      {value && !instances.some(item => item.id === value) && <option value={value}>Instance indisponible (désactivée ou supprimée)</option>}
    </select>
    <p id={`${id}-hint`} className="text-xs text-muted-foreground">Utilisée par les ΞAgents qui héritent de la configuration globale, avec son modèle par défaut.</p>
  </div>;
}

export function InstanceForm({ form, onChange, onSubmit, onCancel, busy, models, editing = false }: {
  form: Form; onChange: (form: Form) => void; onSubmit: () => void; onCancel: () => void; busy: boolean; models: LLMInstance["models"]; editing?: boolean;
}) {
  const id = useId();
  const set = (patch: Partial<Form>) => onChange({ ...form, ...patch });
  return <form className="space-y-3 rounded-md border p-3" aria-label={editing ? `Modifier ${form.name}` : "Nouvelle instance Ollama"} onSubmit={event => { event.preventDefault(); onSubmit(); }}>
    <p className="text-sm font-medium">{editing ? "Modifier l’instance" : "Nouvelle instance Ollama"}</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="grid gap-1"><label htmlFor={`${id}-name`} className="text-xs font-medium">Nom</label>
        <Input id={`${id}-name`} required maxLength={120} value={form.name} placeholder="Ollama — Raspberry Pi" onChange={event => set({ name: event.target.value, ...(form.keyEdited ? {} : { key: keyFromName(event.target.value) }) })} /></div>
      <div className="grid gap-1"><label htmlFor={`${id}-key`} className="text-xs font-medium">Clé (référence portable, YAML)</label>
        <Input id={`${id}-key`} required maxLength={60} pattern="[a-z0-9][a-z0-9\-]*" value={form.key} aria-describedby={`${id}-key-hint`} onChange={event => set({ key: event.target.value, keyEdited: true })} />
        <p id={`${id}-key-hint`} className="text-xs text-muted-foreground">Minuscules, chiffres et tirets ; reprise par les exports YAML.</p></div>
      <div className="grid gap-1 sm:col-span-2"><label htmlFor={`${id}-url`} className="text-xs font-medium">URL du serveur</label>
        <Input id={`${id}-url`} required type="url" maxLength={500} inputMode="url" value={form.baseUrl} placeholder="http://192.168.1.10:11434" aria-describedby={`${id}-url-hint`} onChange={event => set({ baseUrl: event.target.value })} />
        <p id={`${id}-url-hint`} className="text-xs text-muted-foreground">Adresse du réseau local (http ou https, sans identifiants). Les adresses publiques sont refusées sauf autorisation de l’opérateur.</p></div>
      <div className="grid gap-1 sm:col-span-2"><label htmlFor={`${id}-model`} className="text-xs font-medium">Modèle par défaut</label>
        <ModelPicker id={`${id}-model`} models={models} value={form.defaultModel} empty="aucun modèle par défaut" disabled={busy} describedBy={`${id}-model-hint`} onChange={defaultModel => set({ defaultModel })} />
        <p id={`${id}-model-hint`} className="text-xs text-muted-foreground">{models ? "Modèles découverts lors du dernier test." : "Enregistrez puis testez la connexion pour choisir parmi les modèles installés ; vous pouvez aussi saisir un nom."}</p></div>
    </div>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.enabled} onChange={event => set({ enabled: event.target.checked })} />Activée</label>
    <OptionsFields value={form.options} onChange={options => set({ options })} inherited={mergeInferenceOptions()} inheritedFrom="valeurs par défaut de Ξ" disabled={busy} />
    <div className="flex flex-wrap gap-2">
      <Button type="submit" size="sm" disabled={busy || !form.name.trim() || !form.key.trim() || !form.baseUrl.trim()}>{editing ? "Enregistrer" : "Ajouter"}</Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Annuler</Button>
    </div>
  </form>;
}

/** Deletion with its dependencies in view; a choice is required as soon as an agent depends on it. */
export function RemovalPanel({ removal, instances, busy, onChange, onConfirm, onCancel }: {
  removal: Removal; instances: LLMInstance[]; busy: boolean; onChange: (removal: Removal) => void; onConfirm: () => void; onCancel: () => void;
}) {
  const { dependencies, instance } = removal;
  const needsChoice = dependencies.agents.length > 0 || dependencies.isDefault;
  const name = `removal-${instance.id}`;
  const choices: [string, string][] = [
    ...instances.map((item): [string, string] => [item.id, `Réassigner à « ${item.name} »`]),
    ["global", "Repasser ces ΞAgents en héritage de la configuration globale"],
    ["none", "Les laisser en erreur de configuration (à corriger plus tard)"],
  ];
  return <div role="alertdialog" aria-labelledby={`${name}-title`} aria-describedby={`${name}-desc`} className="space-y-2 rounded-md border border-destructive p-3 text-sm">
    <p id={`${name}-title`} className="font-medium">Supprimer « {instance.name} » ?</p>
    <div id={`${name}-desc`} className="space-y-1">
      {!needsChoice && <p>Aucun ΞAgent n’utilise cette instance. La suppression est définitive.</p>}
      {dependencies.isDefault && <p>C’est votre instance par défaut : les ΞAgents qui héritent n’auront plus de configuration globale.</p>}
      {dependencies.agents.length > 0 && <>
        <p>ΞAgents concernés ({dependencies.agents.length}) :</p>
        <ul className="list-inside list-disc">{dependencies.agents.map(agent => <li key={agent.id}>{agent.name} (@{agent.handle}) — {agent.reason === "explicit" ? "instance choisie explicitement" : "hérite de l’instance par défaut"}</li>)}</ul>
      </>}
    </div>
    {needsChoice && <fieldset className="space-y-1"><legend className="font-medium">Que faire de ces ΞAgents ?</legend>
      {choices.map(([value, label]) => <label key={value} className="flex items-center gap-2"><input type="radio" name={name} value={value} checked={removal.reassignTo === value} onChange={() => onChange({ ...removal, reassignTo: value })} />{label}</label>)}
    </fieldset>}
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="destructive" disabled={busy || (needsChoice && !removal.reassignTo)} onClick={onConfirm}>Confirmer la suppression</Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Annuler</Button>
    </div>
  </div>;
}
