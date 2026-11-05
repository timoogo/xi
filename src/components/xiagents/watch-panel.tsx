"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { WatchDiagnostics } from "@/lib/watch/diagnostics";
import type { Resolution } from "@/lib/llm/types";
import { resolutionText } from "@/components/llm/format";
import { PublicationsSettings } from "./publications-settings";
import { WatchDrafts } from "./watch-drafts";
import { CANDIDATE, LANE, OUTCOME } from "./labels";

type Topic = { id: string; tag: string; name: string };
type SourceView = WatchDiagnostics["sources"][number];
const selectClass = "rounded-md border bg-background px-3 py-2";
const date = (value: string | null) => (value ? new Date(value).toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" }) : "—");
const STATUS: Record<string, string> = { proposed: "En attente (collectée, insuffisante seule)", approved: "Approuvée", rejected: "Refusée", disabled: "Désactivée", deleted: "Supprimée" };
const JOB: Record<string, string> = { "publication-window": "Fenêtre de publication", "editorial-diffusion": "Diffusion de la queue éditoriale", "weekly-review": "Bilan hebdomadaire", "collect-source": "Collecte", "discover-sources": "Découverte de sources", "evaluate-story": "Évaluation d’une actualité", "draft-candidate": "Rédaction d’un brouillon", "publish-alert": "Alerte immédiate" };
const JOB_STATE: Record<string, string> = { pending: "Planifiée", running: "En cours", done: "Terminée", failed: "Échec" };
const NOVELTY: Record<string, string> = { new: "nouveau sujet", development: "nouveau développement", duplicate: "déjà traité" };
const CLAIM_KIND: Record<string, string> = { fact: "Fait", attributed: "Déclaration attribuée", hypothesis: "Hypothèse", interpretation: "Interprétation" };
const CLAIM_STATUS: Record<string, string> = { corroborated: "corroboré", primary: "source primaire", "single-source": "une seule voix", "pending-trust": "source en attente d’approbation", qualified: "présenté comme tel", contradicted: "contredit", unsupported: "non étayé, écarté" };
const score = (value: number | null) => (value === null ? "—" : value.toFixed(2));
const HISTORY: Record<string, string> = { proposed: "Proposée", approved: "Approuvée", rejected: "Rejetée", disabled: "Désactivée", deleted: "Supprimée", updated: "Modifiée" };

async function send(url: string, method: "POST" | "PATCH", data: unknown) {
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? "Opération impossible. Réessayez.");
  return result;
}

export function WatchPanel({ agentId, data, topics, agentTopicIds }: { agentId: string; data: WatchDiagnostics; topics: Topic[]; agentTopicIds: string[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function act(task: () => Promise<unknown>, success: string) {
    setBusy(true); setError(""); setNotice("");
    try { await task(); setNotice(success); router.refresh(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Opération impossible."); }
    finally { setBusy(false); }
  }
  const topicName = (id: string) => topics.find(topic => topic.id === id)?.tag ?? "Topic indisponible";
  const pending = data.sources.filter(source => source.status === "proposed");
  const active = data.sources.filter(source => source.status === "approved");
  const others = data.sources.filter(source => source.status === "disabled" || source.status === "rejected");
  // Resolved instance and model of this agent, when the diagnostics provide it (`llm`).
  const llm = (data as WatchDiagnostics & { llm?: Resolution }).llm;
  const status = !data.watch.valid ? "Configuration illisible : veille désactivée" : !data.watch.policy.enabled ? "Désactivée" : data.watch.policy.paused ? "En pause" : data.running ? "Active" : "Inactive (ΞAgent désactivé)";

  return <section aria-labelledby="xiagent-watch-title" className="space-y-6 border-b p-4">
    <p className="text-sm">État : <strong>{status}</strong> · Publication automatique : <strong>{data.autoPublish ? "autorisée" : "désactivée"}</strong>{data.nextWindow && <> · Prochaine fenêtre : {date(data.nextWindow)}</>}</p>
    <p className="text-sm">Mode autonome : <strong>{data.watch.policy.autoPublish ? `activé (${data.watch.policy.visibility === "public" ? "public" : "privé"})` : "désactivé"}</strong> · Opérateur : publication automatique {data.autoPublish ? "autorisée" : "non autorisée (XI_WATCH_AUTOPUBLISH)"}, publique {data.allowPublic ? "autorisée" : "non autorisée (XI_WATCH_AUTOPUBLISH_PUBLIC)"}{data.watch.publicConfirmedAt && <> · publication publique confirmée le {date(data.watch.publicConfirmedAt)}</>}</p>
    {data.publishBlocks.length > 0 && <p className="text-sm">Aucun brouillon ne peut être publié automatiquement : {data.publishBlocks.join(" ")}</p>}
    <p className="text-sm">Worker : {data.worker.lastTickAt ? <>dernier passage {date(data.worker.lastTickAt)}{data.worker.stale && <strong className="text-destructive"> — aucun passage depuis plus de 30 min</strong>}</> : <strong className="text-destructive">aucun passage enregistré</strong>}{data.worker.lastError && <span className="text-destructive"> · dernière erreur {date(data.worker.lastErrorAt)} : {data.worker.lastError}</span>}{data.failedJobs > 0 && <span className="text-destructive"> · {data.failedJobs} tâche(s) en échec</span>}</p>
    {llm ? <p className="text-sm">Inférence locale : {llm.ok ? <strong>{resolutionText(llm)}</strong> : <strong className="text-destructive"><span aria-hidden="true">⚠ </span>{resolutionText(llm)}</strong>}. Aucun service d’IA distant n’est utilisé.</p>
      : <p className="text-sm">Inférence locale : <strong>{data.inference.error ? "configuration refusée" : data.inference.configured ? "configurée" : "non configurée"}</strong>{data.inference.configured && <> · modèle par défaut {data.inference.model ?? "aucun (référence du ΞAgent requise)"}</>}{data.inference.error && <span className="text-destructive"> — {data.inference.error}</span>}. Aucun service d’IA distant n’est utilisé.</p>}
    <div aria-live="polite">{notice && <p role="status" className="text-sm">{notice}</p>}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}</div>

    <PolicyForm key={data.watch.revision ?? "initial"} agentId={agentId} watch={data.watch} busy={busy} act={act} />
    <PublicationsSettings key={`publications-${data.watch.revision ?? "initial"}`} agentId={agentId} data={data} busy={busy} act={act} send={send} />

    <section aria-labelledby="sources-title" className="space-y-3">
      <h3 id="sources-title" className="font-semibold">Sources</h3>
      <p className="text-sm text-muted-foreground">Les sources en attente sont collectées et analysées, mais seules les sources approuvées peuvent établir une information. Les décisions par ΞAgent ou par topic se prennent dans la <Link className="underline" href="/dashboard/sources">page Sources</Link>.{data.invalidSources > 0 && ` ${data.invalidSources} fichier(s) source illisible(s) ignoré(s).`}</p>
      <ProposeForm agentId={agentId} busy={busy} act={act} />
      <SourceList title={`En attente d’approbation (${pending.length})`} sources={pending} empty="Aucune proposition." {...{ busy, act, topicName, topics, agentTopicIds }} />
      <SourceList title={`Actives (${active.length})`} sources={active} empty="Aucune source active." {...{ busy, act, topicName, topics, agentTopicIds }} />
      {others.length > 0 && <SourceList title={`Rejetées ou désactivées (${others.length})`} sources={others} empty="" {...{ busy, act, topicName, topics, agentTopicIds }} />}
    </section>

    <section aria-labelledby="collects-title" className="space-y-2">
      <h3 id="collects-title" className="font-semibold">Dernières collectes</h3>
      {!data.fetchLog.length ? <p className="text-sm text-muted-foreground">Aucune collecte pour l’instant.</p> :
        <ul className="divide-y rounded-lg border text-sm">{data.fetchLog.map((entry, i) => <li key={i} className="flex flex-wrap gap-x-3 gap-y-1 p-2">
          <span>{date(entry.at)}</span><span className="font-medium break-all">{entry.publisher}</span>
          <span className={entry.outcome === "error" || entry.outcome === "robots" ? "text-destructive" : ""}>{OUTCOME[entry.outcome] ?? entry.outcome}{entry.httpStatus ? ` · HTTP ${entry.httpStatus}` : ""}</span>
          <span>{entry.itemsNew} nouveau(x), {entry.itemsSeen} déjà vu(s)</span><span>{entry.durationMs} ms</span>
          {entry.error && entry.error !== `HTTP ${entry.httpStatus}` && <span className="w-full break-words text-destructive">{entry.error}</span>}
        </li>)}</ul>}
    </section>

    <section aria-labelledby="stories-title" className="space-y-2">
      <h3 id="stories-title" className="font-semibold">Actualités détectées</h3>
      <p className="text-sm text-muted-foreground">Regroupement automatique par événement. Les reprises d’une même dépêche, d’un même éditeur ou groupe comptent comme une seule voix ; pertinence et vérification viendront ensuite.</p>
      {!data.stories.length ? <p className="text-sm text-muted-foreground">Aucune actualité collectée.</p> :
        <ul className="space-y-2">{data.stories.map(story => <li key={story.id} className="rounded-lg border p-3">
          <details>
            <summary className="cursor-pointer"><span className="font-medium break-words">{story.title}</span>
              <span className="block text-sm text-muted-foreground">{story.itemCount} article(s) · {story.publisherCount} éditeur(s) · {story.independentCount} confirmation(s) indépendante(s) · publiée {date(story.firstPublishedAt)} · vue {date(story.lastSeenAt)}</span></summary>
            <ol className="mt-2 space-y-1 text-sm">{story.items.map(item => <li key={item.id} className="break-words">
              <span className="text-muted-foreground">Voix {item.lineage + 1} · </span><span className="font-medium">{item.publisher}</span> — <a className="underline" href={item.url} target="_blank" rel="noopener noreferrer nofollow">{item.title}</a>
              <span className="text-muted-foreground"> · {date(item.publishedAt)}{item.credits.length ? ` · crédit ${item.credits.join(", ").toUpperCase()}` : ""}{item.sightings > 1 ? ` · vu dans ${item.sightings} flux` : ""}</span>
            </li>)}</ol>
          </details>
        </li>)}</ul>}
    </section>

    <WatchDrafts agentId={agentId} drafts={data.drafts} busy={busy} act={act} />

    <section aria-labelledby="candidates-title" className="space-y-2">
      <h3 id="candidates-title" className="font-semibold">Candidats éditoriaux</h3>
      <p className="text-sm text-muted-foreground">Évalués par le modèle local, décidés par des règles vérifiables : une citation absente des sources est écartée, une information à une seule voix reste en attente. Rien n’est rédigé ni publié à ce stade.</p>
      {!data.candidates.length ? <p className="text-sm text-muted-foreground">Aucun candidat évalué.</p> :
        <ul className="space-y-2">{data.candidates.map(candidate => <li key={candidate.storyId} className="rounded-lg border p-3 text-sm" aria-label={`Candidat ${candidate.title}`}>
          <details>
            <summary className="cursor-pointer"><span className="font-medium break-words">{candidate.title}</span>
              <span className="block text-muted-foreground">{CANDIDATE[candidate.status] ?? candidate.status}{candidate.lane ? ` · ${LANE[candidate.lane]}` : ""} · sujet {candidate.topicId ? topicName(candidate.topicId) : "—"} · pertinence {score(candidate.relevance)} · nouveauté {score(candidate.novelty)}{candidate.noveltyKind ? ` (${NOVELTY[candidate.noveltyKind]})` : ""} · importance {score(candidate.importance)}</span>
              {candidate.reason && <span className="block break-words">{candidate.reason}</span>}
              <span className="block break-words text-xs">{candidate.blocker.step === "publiée" ? "Publiée." : <>Arrêt à l’étape « {candidate.blocker.step} » : {candidate.blocker.reason}</>}</span></summary>
            <div className="mt-2 space-y-2">
              {candidate.relevanceJustification && <p className="break-words">Pertinence : {candidate.relevanceJustification}{candidate.outOfScope.length ? ` Hors périmètre : ${candidate.outOfScope.join(" ; ")}.` : ""}</p>}
              {candidate.noveltyJustification && <p className="break-words">Nouveauté : {candidate.noveltyJustification}{candidate.newFacts.length ? ` Faits nouveaux : ${candidate.newFacts.join(" ; ")}.` : ""}</p>}
              {(candidate.relatedPublicationId || candidate.relatedStory) && <p>Continuité : {candidate.relatedPublicationId ? <a className="underline" href={`/dashboard/publications/${candidate.relatedPublicationId}`}>publication précédente</a> : `actualité « ${candidate.relatedStory!.title ?? "fusionnée"} »`} (lien préparé, non créé).</p>}
              {candidate.importanceFactors.length > 0 && <div><p className="font-medium">Importance {score(candidate.importance)}</p><ul className="list-disc pl-5">{candidate.importanceFactors.map(factor => <li key={factor.label}>{factor.label} : {factor.value.toFixed(2)} × {factor.weight} = {factor.contribution.toFixed(2)}</li>)}</ul>{candidate.impactReasons.length > 0 && <p className="text-muted-foreground break-words">Impact : {candidate.impactReasons.join(" ; ")}</p>}<p className="text-muted-foreground">{candidate.importanceNote}</p></div>}
              {candidate.sources.length > 0 && <div><p className="font-medium">Sources utilisées</p><ul className="list-disc pl-5">{candidate.sources.map((source, i) => <li key={i} className="break-words">Voix {source.lineage + 1} · {source.publisher}{source.official ? " (source officielle)" : ""}{source.trust && source.trust !== "approved" ? ` (${source.trust === "pending" ? "en attente d’approbation" : "refusée"})` : ""} — <a className="underline" href={source.url} target="_blank" rel="noopener noreferrer nofollow">article</a></li>)}</ul></div>}
              {candidate.claims.length > 0 && <div><p className="font-medium">Faits extraits</p><ol className="space-y-1 pl-5" style={{ listStyle: "decimal" }}>{candidate.claims.map((claim, i) => <li key={i} className="break-words">
                <span className="font-medium">{CLAIM_KIND[claim.kind] ?? claim.kind}{claim.attribution ? ` (${claim.attribution})` : ""}</span> — {claim.text} <span className={claim.status === "unsupported" || claim.status === "contradicted" ? "text-destructive" : "text-muted-foreground"}>[{CLAIM_STATUS[claim.status] ?? claim.status} : {claim.reason}{claim.rejectedQuotes ? ` ${claim.rejectedQuotes} citation(s) rejetée(s).` : ""}]</span>
                {claim.quotes.length > 0 && <ul className="pl-4 text-muted-foreground">{claim.quotes.map((quote, j) => <li key={j}>« {quote.quote} » — {quote.publisher}</li>)}</ul>}
              </li>)}</ol></div>}
              {candidate.model && <p className="text-muted-foreground">Modèle local : {candidate.model} · mis à jour {date(candidate.updatedAt)}</p>}
            </div>
          </details>
        </li>)}</ul>}
    </section>

    <section aria-labelledby="jobs-title" className="space-y-2">
      <h3 id="jobs-title" className="font-semibold">Tâches</h3>
      {!data.jobs.length ? <p className="text-sm text-muted-foreground">Aucune tâche planifiée.</p> :
        <ul className="divide-y rounded-lg border text-sm">{data.jobs.map((job, i) => <li key={i} className="flex flex-wrap gap-x-3 gap-y-1 p-2">
          <span className="font-medium">{JOB[job.kind] ?? job.kind}{job.source ? ` · ${job.source}` : ""}</span>
          <span>{JOB_STATE[job.state] ?? job.state}</span><span>Exécution : {date(job.runAfter)}</span><span>Essais : {job.attempts}/{job.maxAttempts}</span>
          {job.result && <span className="text-muted-foreground break-words">{Object.entries(job.result).map(([key, value]) => `${key} : ${String(value)}`).join(" · ")}</span>}
          {job.lastError && <span className="w-full break-words text-destructive">{job.lastError}</span>}
        </li>)}</ul>}
    </section>
  </section>;
}

type Act = (task: () => Promise<unknown>, success: string) => Promise<void>;

function PolicyForm({ agentId, watch, busy, act }: { agentId: string; watch: WatchDiagnostics["watch"]; busy: boolean; act: Act }) {
  const [policy, setPolicy] = useState(watch.policy);
  const save = (next: typeof policy, success: string) => act(() => send(`/api/xiagents/${agentId}/watch`, "PATCH", { revision: watch.revision, policy: next }), success);
  const number = (key: "testMaxPerDay" | "alertThreshold" | "nightThreshold", label: string, min: number, max: number, step = 1) =>
    <label className="grid gap-1 text-sm">{label}<Input type="number" min={min} max={max} step={step} required value={policy[key]} onChange={event => setPolicy({ ...policy, [key]: Number(event.target.value) })} /></label>;
  return <section aria-labelledby="policy-title" className="space-y-3">
    <h3 id="policy-title" className="font-semibold">Paramètres de veille</h3>
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); void save(policy, "Paramètres de veille enregistrés."); }}>
      <fieldset disabled={busy} className="space-y-3">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={policy.enabled} onChange={event => setPolicy({ ...policy, enabled: event.target.checked })} /> Veille activée</label>
        <div className="grid gap-3 sm:grid-cols-3">
          {number("testMaxPerDay", "Plafond de publications de test (24 h)", 1, 100)}
          {number("alertThreshold", "Seuil d’importance des alertes majeures", 0.5, 1, 0.05)}
          {number("nightThreshold", "Seuil d’importance de la fenêtre nocturne", 0, 0.95, 0.05)}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit">Enregistrer les paramètres</Button>
          <a href="#xiagent-control" className="inline-flex items-center px-2 text-sm underline">Pause et reprise : section Pilotage</a>
        </div>
      </fieldset>
    </form>
  </section>;
}

function ProposeForm({ agentId, busy, act }: { agentId: string; busy: boolean; act: Act }) {
  const [url, setUrl] = useState("");
  return <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); void act(async () => { await send(`/api/xiagents/${agentId}/sources`, "POST", { url }); setUrl(""); }, "Source proposée : elle attend votre approbation."); }}>
    <label className="grid min-w-0 flex-1 gap-1 text-sm">Adresse d’un site ou d’un flux RSS/Atom<Input type="url" required maxLength={2_000} value={url} disabled={busy} onChange={event => setUrl(event.target.value)} placeholder="https://" /></label>
    <Button type="submit" disabled={busy}>Proposer une source</Button>
  </form>;
}

function SourceList({ title, sources, empty, ...props }: { title: string; sources: SourceView[]; empty: string; busy: boolean; act: Act; topicName: (id: string) => string; topics: Topic[]; agentTopicIds: string[] }) {
  return <div className="space-y-2">
    <h4 className="text-sm font-semibold">{title}</h4>
    {!sources.length ? <p className="text-sm text-muted-foreground">{empty}</p> : <ul className="space-y-2">{sources.map(source => <SourceCard key={source.id} source={source} {...props} />)}</ul>}
  </div>;
}

function SourceCard({ source, busy, act, topicName, agentTopicIds }: { source: SourceView; busy: boolean; act: Act; topicName: (id: string) => string; topics: Topic[]; agentTopicIds: string[] }) {
  const [editing, setEditing] = useState<"approve" | "update" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [edits, setEdits] = useState({ publisher: source.publisher, ownerGroup: source.ownerGroup ?? "", orientation: source.orientation ?? "", reliability: source.reliability.level, pollMinutes: source.pollMinutes, topicIds: source.topicIds, note: "" });
  const decide = (action: string, success: string, withEdits = false) => act(() => send(`/api/watch/sources/${source.id}`, "POST", {
    action, revision: source.revision, ...(edits.note.trim() ? { note: edits.note.trim() } : {}),
    ...(withEdits ? { edits: { publisher: edits.publisher, ownerGroup: edits.ownerGroup.trim() || null, orientation: edits.orientation.trim() || null, reliability: edits.reliability, pollMinutes: edits.pollMinutes, topicIds: edits.topicIds } } : {}),
  }), success);
  const toggleTopic = (id: string, checked: boolean) => setEdits({ ...edits, topicIds: checked ? [...edits.topicIds, id] : edits.topicIds.filter(topic => topic !== id) });
  const proposer = source.proposedBy.startsWith("agent:") ? "proposée par le ΞAgent" : "proposée manuellement";
  return <li className="space-y-2 rounded-lg border p-3 text-sm" aria-label={`Source ${source.publisher}`}>
    <p><span className="font-semibold break-words">{source.publisher}</span> · {STATUS[source.status]} · {source.kind === "json" ? "API JSON" : "Flux RSS/Atom"} · {proposer}</p>
    <p className="break-all"><a className="underline" href={source.url} target="_blank" rel="noopener noreferrer nofollow">{source.url}</a></p>
    <p>Sujets : {source.topicIds.map(topicName).join(" · ")}</p>
    <p>Fiabilité {source.reliability.estimated ? "estimée" : "évaluée"} : <strong>{source.reliability.level}</strong>{source.reliability.reasons.length ? ` — ${source.reliability.reasons.join(" ")}` : ""}</p>
    <p>Orientation éditoriale : {source.orientation ?? "non évaluée"}{source.ownerGroup ? ` · Groupe : ${source.ownerGroup}` : ""} · Collecte toutes les {source.pollMinutes} min</p>
    {source.state && <p className="text-muted-foreground">Dernière collecte : {date(source.state.lastFetchAt)} ({source.state.lastOutcome ? OUTCOME[source.state.lastOutcome] ?? source.state.lastOutcome : "—"}) · Prochaine : {source.status === "approved" || source.status === "proposed" ? date(source.state.nextFetchAt) : "—"}{source.state.consecutiveErrors ? ` · ${source.state.consecutiveErrors} erreur(s) consécutive(s)` : ""}</p>}
    {editing && <fieldset disabled={busy} className="grid gap-2 rounded-md border p-2">
      <legend className="px-1 font-medium">{editing === "approve" ? "Vérifier avant approbation" : "Modifier la source"}</legend>
      <label className="grid gap-1">Éditeur<Input required maxLength={200} value={edits.publisher} onChange={event => setEdits({ ...edits, publisher: event.target.value })} /></label>
      <label className="grid gap-1">Groupe propriétaire (sources non indépendantes)<Input maxLength={200} value={edits.ownerGroup} onChange={event => setEdits({ ...edits, ownerGroup: event.target.value })} /></label>
      <label className="grid gap-1">Orientation éditoriale connue<Input maxLength={200} value={edits.orientation} onChange={event => setEdits({ ...edits, orientation: event.target.value })} placeholder="Non évaluée" /></label>
      <label className="grid gap-1">Fiabilité<select className={selectClass} value={edits.reliability} onChange={event => setEdits({ ...edits, reliability: event.target.value as typeof edits.reliability })}>{["élevée", "moyenne", "faible", "inconnue"].map(level => <option key={level} value={level}>{level}</option>)}</select></label>
      <label className="grid gap-1">Fréquence de collecte (minutes)<Input type="number" min={15} max={1_440} value={edits.pollMinutes} onChange={event => setEdits({ ...edits, pollMinutes: Number(event.target.value) })} /></label>
      <fieldset className="space-y-1"><legend>Sujets attribués</legend>{[...new Set([...agentTopicIds, ...source.topicIds])].map(id => <label key={id} className="flex items-center gap-2"><input type="checkbox" checked={edits.topicIds.includes(id)} onChange={event => toggleTopic(id, event.target.checked)} />{topicName(id)}</label>)}</fieldset>
      <label className="grid gap-1">Note de décision (facultative)<Input maxLength={1_000} value={edits.note} onChange={event => setEdits({ ...edits, note: event.target.value })} /></label>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={!edits.topicIds.length || !edits.publisher.trim()} onClick={() => void decide(editing, editing === "approve" ? "Source approuvée." : "Source modifiée.", true)}>{editing === "approve" ? "Confirmer l’approbation" : "Enregistrer"}</Button>
        <Button type="button" variant="outline" onClick={() => setEditing(null)}>Annuler</Button>
      </div>
    </fieldset>}
    {!editing && <div className="flex flex-wrap gap-2">
      {["proposed", "rejected", "disabled"].includes(source.status) && <Button type="button" size="sm" disabled={busy} onClick={() => setEditing("approve")}>{source.status === "disabled" ? "Réactiver" : "Approuver"}</Button>}
      {source.status !== "rejected" && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void decide("reject", "Source refusée.")}>Refuser</Button>}
      {source.status === "approved" && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void decide("disable", "Source désactivée.")}>Désactiver</Button>}
      {["proposed", "approved", "disabled"].includes(source.status) && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setEditing("update")}>Modifier</Button>}
      {!confirmDelete ? <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirmDelete(true)}>Supprimer</Button>
        : <><Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => void decide("delete", "Source supprimée ; son historique est conservé.")}>Confirmer la suppression</Button><Button type="button" size="sm" variant="outline" onClick={() => setConfirmDelete(false)}>Annuler</Button></>}
    </div>}
    <details><summary className="cursor-pointer text-muted-foreground">Historique des décisions ({source.history.length})</summary>
      <ol className="mt-1 space-y-1">{source.history.map((entry, i) => <li key={i} className="break-words">{date(entry.at)} · {HISTORY[entry.action] ?? entry.action} par {entry.by.startsWith("agent:") ? "le ΞAgent" : "vous"}{entry.note ? ` — ${entry.note}` : ""}{entry.changes ? ` (${Object.keys(entry.changes).join(", ")})` : ""}</li>)}</ol>
    </details>
  </li>;
}
