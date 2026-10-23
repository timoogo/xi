"use client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CHARTER, type Account, type AccountDraft, type AccountRun, type Preset } from "@/lib/accounts/types";
import type { Topic } from "@/lib/topics/types";

type Catalog = { accounts: Account[]; topics: Topic[]; presets: Preset[] };
async function request<T>(url: string, method = "GET", data?: unknown): Promise<T> {
  const response = await fetch(url, { method, cache: "no-store", ...(data ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) } : {}) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error ?? "Requête impossible."); return result;
}
const selectClass = "w-full rounded-md border bg-background px-3 py-2";
export function AccountManager({ owner }: { owner: string }) {
  const [catalog, setCatalog] = useState<Catalog>({ accounts: [], topics: [], presets: [] });
  const [topicId, setTopicId] = useState("");
  const [run, setRun] = useState<AccountRun | null>(null);
  const [editing, setEditing] = useState<Account | null>(null);
  const [draft, setDraft] = useState<AccountDraft | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [presetName, setPresetName] = useState("");
  const refresh = useCallback(async () => { const data = await request<Catalog>("/api/accounts"); setCatalog(data); setTopicId(current => current || data.topics[0]?.id || ""); }, []);
  useEffect(() => { void refresh().catch(e => setError(e.message)); const id = new URL(window.location.href).searchParams.get("run"); if (id) void request<{ run: AccountRun }>(`/api/accounts/runs/${id}`).then(({ run }) => { setRun(run); setDraft(run.draft); }).catch(e => setError(e.message)); }, [refresh]);
  const runId = run?.id;
  useEffect(() => {
    if (!runId) return;
    const source = new EventSource(`/api/accounts/runs/${runId}/events`);
    source.addEventListener("pipeline", event => { const next = JSON.parse((event as MessageEvent).data) as AccountRun; setRun(current => !current || current.id !== next.id || current.events.length > next.events.length || current.state === "completed" ? current : next); });
    return () => source.close();
  }, [runId]);
  useEffect(() => { if (run?.state === "completed") void refresh().catch(e => setError(e.message)); }, [run?.state, refresh]);
  async function act(task: () => Promise<void>) { setBusy(true); setError(""); setNotice(""); try { await task(); } catch (e) { setError(e instanceof Error ? e.message : "Erreur inattendue."); } finally { setBusy(false); } }
  function change(patch: Partial<AccountDraft>) { setDraft(current => current ? { ...current, ...patch } : current); setConfirmed(false); }
  function open(account: Account) {
    setEditing(account); setRun(null); setConfirmed(false); window.history.replaceState(null, "", "/dashboard/accounts");
    const preset = catalog.presets[0];
    setDraft({ handle: account.handle, name: account.name, description: account.description, primaryTopicId: account.editorial?.primaryTopicId ?? catalog.topics[0]?.id ?? "", secondaryTopicIds: account.editorial?.secondaryTopicIds ?? [], presetId: account.editorial?.presetId ?? preset.id, presetVersion: account.editorial?.presetVersion ?? preset.version, settings: account.editorial?.settings ?? preset.settings, active: account.editorial?.active ?? true, modelRef: account.editorial?.modelRef ?? null, validationMode: "human" });
  }
  async function resume(id: string) { const result = await request<{ run: AccountRun }>(`/api/accounts/runs/${id}`, "POST", { action: "resume" }); setRun(result.run); setDraft(result.run.draft); }
  const readonly = !!editing && editing.owner !== owner || !!run?.confirmed;
  const topic = catalog.topics.find(t => t.id === draft?.primaryTopicId);
  const selectedPreset = catalog.presets.find(p => p.id === draft?.presetId && p.version === draft?.presetVersion);
  return <div className="space-y-6 p-4 pb-24">
    <p className="text-sm text-muted-foreground">Les comptes partagent les topics sans en copier le scope. Aucune publication n’est générée.</p>
    <section className="space-y-3 rounded-xl border p-4" aria-labelledby="create-account">
      <h2 id="create-account" className="font-semibold">Créer un compte éditorial</h2>
      <label className="block space-y-1">Topic de départ<select className={selectClass} value={topicId} onChange={e => setTopicId(e.target.value)}><option value="">Choisir un topic</option>{catalog.topics.map(t => <option key={t.id} value={t.id}>{t.name} · {t.tag}</option>)}</select></label>
      {!catalog.topics.length && <p>Créez d’abord un topic depuis la gestion des topics.</p>}
      <Button disabled={busy || !topicId} onClick={() => void act(async () => { const { run } = await request<{ run: AccountRun }>("/api/accounts/runs", "POST", { topicId }); setEditing(null); setDraft(null); setConfirmed(false); setRun(run); window.history.replaceState(null, "", `?run=${run.id}`); await resume(run.id); })}>Proposer un compte</Button>
    </section>
    <p role="alert">{error}</p><p role="status">{notice}</p>
    {run && <section className="space-y-2 rounded-xl border p-4"><h2 className="font-semibold">Parcours de création</h2><p aria-live="polite">État : {run.state === "waiting" ? "En attente de confirmation" : run.state === "completed" ? "Compte créé" : run.state === "failed" ? "Échec — reprise possible" : "En cours"}</p><ol className="list-inside list-decimal text-sm">{run.steps.map((step, n) => <li key={n}>{step.name} — {step.status}{step.error && <span className="text-destructive"> : {step.error}</span>}</li>)}</ol><details><summary>Journal backend</summary><ol className="text-xs">{run.events.map(e => <li key={e.id}>{e.id} · {new Date(e.at).toLocaleTimeString()} · {run.steps[e.step].name} : {e.status}{e.error ? ` — ${e.error}` : ""}</li>)}</ol></details>{(run.state === "failed" || run.state === "running") && <Button disabled={busy} onClick={() => void act(() => resume(run.id))}>Reprendre le parcours</Button>}</section>}
    {draft && <form className="space-y-4 rounded-xl border p-4" onSubmit={event => { event.preventDefault(); void act(async () => {
      if (editing) { await request("/api/accounts", "PATCH", { id: editing.id, revision: editing.editorial?.revision ?? null, draft }); await refresh(); setEditing(null); setDraft(null); setNotice("Compte enregistré."); }
      else if (run) { const result = await request<{ run: AccountRun }>(`/api/accounts/runs/${run.id}`, "POST", { action: "confirm", draft, confirmed }); setRun(result.run); await refresh(); }
    }); }}>
      <h2 className="font-semibold">{editing ? `Configuration de @${editing.handle}` : "Confirmer le nouveau compte"}</h2>
      <fieldset disabled={busy || readonly} className="space-y-4">
        <label className="block">Handle public<Input required value={draft.handle} onChange={e => change({ handle: e.target.value })} /></label>
        <label className="block">Nom du compte<Input required maxLength={160} value={draft.name} onChange={e => change({ name: e.target.value })} /></label>
        <label className="block">Description<Textarea maxLength={4000} value={draft.description} onChange={e => change({ description: e.target.value })} /></label>
        <label className="block">Topic principal<select required className={selectClass} value={draft.primaryTopicId} onChange={e => change({ primaryTopicId: e.target.value, secondaryTopicIds: draft.secondaryTopicIds.filter(id => id !== e.target.value) })}>{catalog.topics.map(t => <option key={t.id} value={t.id}>{t.name} · {t.tag}</option>)}</select></label>
        <fieldset className="space-y-1"><legend>Topics secondaires</legend>{catalog.topics.filter(t => t.id !== draft.primaryTopicId).map(t => <label className="block" key={t.id}><input type="checkbox" checked={draft.secondaryTopicIds.includes(t.id)} onChange={e => change({ secondaryTopicIds: e.target.checked ? [...draft.secondaryTopicIds, t.id] : draft.secondaryTopicIds.filter(id => id !== t.id) })} /> {t.name}</label>)}</fieldset>
        <label className="block">Preset et version<select className={selectClass} value={`${draft.presetId}:${draft.presetVersion}`} onChange={e => { const p = catalog.presets.find(p => `${p.id}:${p.version}` === e.target.value)!; change({ presetId: p.id, presetVersion: p.version, settings: p.settings }); }}>
          {!selectedPreset && <option value={`${draft.presetId}:${draft.presetVersion}`}>Version privée · {draft.presetVersion}</option>}{catalog.presets.map(p => <option key={`${p.id}:${p.version}`} value={`${p.id}:${p.version}`}>{p.name} · v{p.version}</option>)}</select></label>
        <p className="text-xs text-muted-foreground">Changer de version est volontaire et charge ses paramètres. Les personnalisations ci-dessous restent propres au compte.</p>
        <label className="block">Ton<Input required maxLength={300} value={draft.settings.tone} onChange={e => change({ settings: { ...draft.settings, tone: e.target.value } })} /></label>
        <label className="block">Structure<Textarea required maxLength={1000} value={draft.settings.structure} onChange={e => change({ settings: { ...draft.settings, structure: e.target.value } })} /></label>
        <label className="block">Profondeur<select className={selectClass} value={draft.settings.depth} onChange={e => change({ settings: { ...draft.settings, depth: e.target.value as AccountDraft["settings"]["depth"] } })}><option value="court">Court</option><option value="standard">Standard</option><option value="approfondi">Approfondi</option></select></label>
        <label className="block">Public visé<Input required maxLength={300} value={draft.settings.audience} onChange={e => change({ settings: { ...draft.settings, audience: e.target.value } })} /></label>
        <label className="block">Référence fournisseur / modèle (facultative)<Input maxLength={200} value={draft.modelRef ?? ""} onChange={e => change({ modelRef: e.target.value || null })} /></label>
        <label className="block"><input type="checkbox" checked={draft.active} onChange={e => change({ active: e.target.checked })} /> Compte actif</label>
        <p>Validation humaine obligatoire.</p>
        <div className="space-y-2 border-t pt-3"><label className="block">Nom du preset personnalisé<Input value={presetName} maxLength={160} onChange={e => setPresetName(e.target.value)} /></label><Button type="button" variant="outline" disabled={!presetName.trim()} onClick={() => void act(async () => { const { preset } = await request<{ preset: Preset }>("/api/accounts/presets", "POST", { expectedVersion: 0, name: presetName, settings: draft.settings }); await refresh(); change({ presetId: preset.id, presetVersion: preset.version }); setNotice("Preset réutilisable enregistré."); })}>Enregistrer comme nouveau preset</Button>
        {selectedPreset?.owner === owner && <Button type="button" variant="outline" onClick={() => void act(async () => { await request("/api/accounts/presets", "POST", { id: selectedPreset.id, expectedVersion: selectedPreset.version, name: presetName.trim() || selectedPreset.name, settings: draft.settings }); await refresh(); setNotice("Nouvelle version créée. Sélectionnez-la pour l’adopter ; le compte conserve sa version actuelle."); })}>Créer une nouvelle version du preset</Button>}</div>
      </fieldset>
      <aside className="rounded-md bg-muted p-3"><h3 className="font-semibold">Scope hérité — {topic?.tag}</h3><p className="whitespace-pre-wrap">{topic?.scope ?? "Topic indisponible"}</p><p className="text-xs">Mis à jour le {topic?.updatedAt} · référence au topic, sans copie dans le compte.</p><Button type="button" variant="ghost" disabled={busy} onClick={() => void act(refresh)}>Actualiser le scope et le catalogue</Button></aside>
      <p className="text-sm">Charte commune : {CHARTER}</p>
      {!readonly && <><label className="block"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> Je confirme le compte, ses topics, le scope et la charte éditoriale.</label><Button disabled={busy || !confirmed} type="submit">{editing ? "Enregistrer le compte" : "Confirmer la création"}</Button></>}
    </form>}
    <section className="space-y-3"><h2 className="font-semibold">Comptes existants</h2>{!catalog.accounts.length && <p>Aucun compte éditorial.</p>}{catalog.accounts.map(account => <article key={account.id} className="rounded-xl border p-4"><h3 className="font-semibold">{account.name} <span className="font-normal text-muted-foreground">@{account.handle}</span></h3><p>{account.description}</p><p className="text-sm">{account.editorial ? `${account.editorial.active ? "Actif" : "Inactif"} · ${catalog.topics.find(t => t.id === account.editorial?.primaryTopicId)?.tag ?? "Topic absent"} · preset v${account.editorial.presetVersion}` : "Générateur existant · configuration éditoriale à compléter"}</p><Button variant="outline" disabled={busy || !catalog.presets.length} onClick={() => open(account)}>Configurer @{account.handle}</Button></article>)}</section>
  </div>;
}
