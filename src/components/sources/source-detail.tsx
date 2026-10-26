"use client";
import { Check, CircleDashed, ExternalLink, X, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { SourceDetail } from "@/lib/watch/source-admin";
import type { Trust, TrustScope } from "@/lib/watch/trust";
import { cn } from "@/lib/utils";

const TRUST: Record<Trust, { label: string; icon: LucideIcon; className: string }> = {
  approved: { label: "Approuvée", icon: Check, className: "text-emerald-700 dark:text-emerald-400" },
  pending: { label: "En attente", icon: CircleDashed, className: "text-muted-foreground" },
  denied: { label: "Refusée", icon: X, className: "text-destructive" },
};
const OPTIONS: Trust[] = ["approved", "pending", "denied"];
const RELIABILITY = ["élevée", "moyenne", "faible", "inconnue"] as const;
const KIND: Record<string, string> = { feed: "Flux RSS/Atom", json: "API JSON officielle" };
const OUTCOME: Record<string, string> = { ok: "Réussie", "not-modified": "Inchangée", error: "Erreur", robots: "Interdite par robots.txt" };
const HISTORY: Record<string, string> = { proposed: "Proposée", approved: "Approuvée", rejected: "Refusée", disabled: "Collecte désactivée", deleted: "Supprimée", updated: "Modifiée" };
const selectClass = "rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60";
const date = (value: string | null) => value ? new Date(value).toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" }) : null;

function TrustBadge({ value, suffix }: { value: Trust; suffix?: string }) {
  const Icon = TRUST[value].icon;
  return <span className="inline-flex items-center gap-1"><Icon aria-hidden="true" className={cn("size-4", TRUST[value].className)} />{TRUST[value].label}{suffix}</span>;
}
function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section aria-labelledby={id} className="space-y-3 border-b p-4"><h2 id={id} className="text-lg font-bold">{title}</h2>{children}</section>;
}
function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid gap-0.5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-3"><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 break-words">{children}</dd></div>;
}

/**
 * One source: identity, collector, trust (global and per ΞAgent/topic, through /api/watch/trust),
 * editable metadata, latest articles, history and deletion (a catalogue tombstone, not a denial).
 * Each change re-reads the source; unknown values are shown as unknown, never estimated.
 */
export function SourceDetailView({ initial }: { initial: SourceDetail }) {
  const router = useRouter();
  const [detail, setDetail] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const { source, collector } = detail;
  const handles = new Map(detail.agents.map(agent => [agent.id, `@${agent.handle}`]));
  const tags = new Map(detail.topics.map(topic => [topic.id, `#${topic.tag}`]));
  const explicit = (scope: TrustScope, id: string | null) => detail.decisions.find(entry => entry.scope === scope && (entry.scopeId ?? null) === id) ?? null;
  const [edits, setEdits] = useState(() => editable(initial));
  // Topics a source can be attached to: followed by a ΞAgent, or already its own.
  const attachable = detail.topics.filter(topic => source.topicIds.includes(topic.id) || detail.agents.some(agent => agent.topicIds.includes(topic.id)));

  async function reload() {
    const response = await fetch(`/api/watch/sources/${source.id}`);
    if (response.status === 404) { router.push("/dashboard/sources"); return; }
    if (response.ok) { const next: SourceDetail = await response.json(); setDetail(next); setEdits(editable(next)); }
  }
  async function run(request: () => Promise<Response>, success: (result: Record<string, unknown>) => string) {
    setBusy(true); setNotice(""); setError("");
    try {
      const response = await request();
      const result = await response.json().catch(() => ({}));
      if (!response.ok) { if (response.status === 409) await reload(); throw new Error(result.error ?? "Action impossible. Réessayez."); }
      await reload();
      setNotice(success(result));
      return true;
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Action impossible."); return false; }
    finally { setBusy(false); }
  }
  const post = (url: string, data: unknown) => () => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const decide = (action: string, message: string, extra: Record<string, unknown> = {}) => run(post(`/api/watch/sources/${source.id}`, { action, revision: source.revision, ...extra }), () => message);
  const trust = (scope: TrustScope, scopeId: string | null, decision: Trust) => {
    const where = scope === "global" ? "pour tous vos ΞAgents" : scope === "agent" ? `pour ${handles.get(scopeId!)}` : `pour le topic ${tags.get(scopeId!)}`;
    return run(post("/api/watch/trust", { sourceId: source.id, scope, scopeId, decision, ...(scope === "global" ? { revision: source.revision } : {}) }),
      result => `${decision === "pending" ? (scope === "global" ? "Remise en attente" : "Décision révoquée") : TRUST[decision].label} ${where}.${result.rechecked ? ` ${result.rechecked} actualité(s) en réévaluation.` : ""}`);
  };
  async function save(event: FormEvent) {
    event.preventDefault();
    await decide("update", "Métadonnées enregistrées.", { edits: { publisher: edits.publisher, ownerGroup: edits.ownerGroup.trim() || null, orientation: edits.orientation.trim() || null, pollMinutes: edits.pollMinutes, topicIds: edits.topicIds, ...(edits.reliability !== source.reliability.level || !source.reliability.estimated ? { reliability: edits.reliability } : {}) } });
  }
  /** The page has nothing left to show once the source is a tombstone: straight back to the list. */
  async function remove() {
    setBusy(true); setError("");
    try {
      const response = await post(`/api/watch/sources/${source.id}`, { action: "delete", revision: source.revision })();
      if (!response.ok) { if (response.status === 409) await reload(); throw new Error((await response.json().catch(() => ({}))).error ?? "Suppression impossible. Réessayez."); }
      router.push("/dashboard/sources");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Suppression impossible."); setBusy(false); }
  }

  const status = source.status;
  const scopedSelect = (scope: "agent" | "topic", id: string, label: string) => {
    const entry = explicit(scope, id);
    return <div className="flex flex-wrap items-center gap-2">
      <select className={selectClass} disabled={busy} value={entry?.decision ?? "pending"} aria-label={`Décision pour ${label}`}
        onChange={event => void trust(scope, id, event.target.value as Trust)}>
        <option value="pending">Aucune décision (hériter)</option>
        <option value="approved">Approuvée</option>
        <option value="denied">Refusée</option>
      </select>
      {entry && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void trust(scope, id, "pending")} aria-label={`Révoquer la décision pour ${label}`}>Révoquer</Button>}
      {entry && <span className="text-xs text-muted-foreground">le {date(entry.at)}</span>}
    </div>;
  };

  return <div>
    <div aria-live="polite" className="px-4 pt-3 empty:hidden">{notice && <p role="status" className="text-sm">{notice}</p>}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}</div>

    <Section id="identity" title="Source">
      <dl className="grid gap-2 text-sm">
        <Row label="Nom">{source.publisher}</Row>
        <Row label="Domaine">{source.domain}</Row>
        <Row label="Adresse du flux"><a className="underline underline-offset-2 break-all" href={source.url} target="_blank" rel="noopener noreferrer">{source.url}</a></Row>
        {source.site && <Row label="Site"><a className="underline underline-offset-2 break-all" href={source.site} target="_blank" rel="noopener noreferrer">{source.site}</a></Row>}
        <Row label="Type">{KIND[source.kind] ?? source.kind}</Row>
        <Row label="Provenance">{source.origin.kind === "agent" ? `Découverte par ${handles.get(source.origin.agentId) ?? "un ΞAgent"}` : "Ajoutée manuellement"}, le {date(source.createdAt)}</Row>
        <Row label="Fiabilité">{source.reliability.level}{source.reliability.estimated ? " (estimation automatique)" : " (fixée par vous)"}</Row>
        <Row label="Topics">{source.topicIds.map(id => tags.get(id) ?? "topic inconnu").join(" ")}</Row>
      </dl>
    </Section>

    <Section id="collector" title="Collecte">
      <dl className="grid gap-2 text-sm">
        <Row label="État">{collector.collecting ? "Active" : status === "disabled" ? "Désactivée" : "Arrêtée (source refusée)"}</Row>
        <Row label="Fréquence">Toutes les {source.pollMinutes} min</Row>
        <Row label="Dernière collecte">{date(collector.lastFetchAt) ?? "Jamais collectée"}{collector.lastOutcome ? ` — ${OUTCOME[collector.lastOutcome] ?? collector.lastOutcome}` : ""}</Row>
        {collector.collecting && <Row label="Prochaine collecte">{date(collector.nextFetchAt) ?? "Dès le prochain passage du collecteur"}</Row>}
        {collector.consecutiveErrors > 0 && <Row label="Erreurs consécutives">{collector.consecutiveErrors}</Row>}
        {collector.lastError && <Row label="Dernière erreur"><span className="text-destructive">{collector.lastError}</span></Row>}
      </dl>
      {status === "approved" || status === "proposed"
        ? <Button type="button" variant="outline" disabled={busy} onClick={() => void decide("disable", "Collecte désactivée.")}>Désactiver la collecte</Button>
        : status === "disabled" && <Button type="button" variant="outline" disabled={busy} onClick={() => void decide("enable", "Collecte réactivée.")}>Réactiver la collecte{source.reenableAs === "approved" ? " (approuvée)" : " (en attente)"}</Button>}
      <p className="text-xs text-muted-foreground">Désactiver arrête la collecte : la source compte alors comme en attente et ses articles déjà collectés restent analysés. Ce n’est ni un refus ni une suppression.</p>
      {collector.fetches.length > 0 && <details className="text-sm"><summary className="cursor-pointer">Dernières collectes ({collector.fetches.length})</summary>
        <ul className="mt-2 space-y-1">{collector.fetches.map(fetchRow => <li key={fetchRow.at}>
          {date(fetchRow.at)} — {OUTCOME[fetchRow.outcome] ?? fetchRow.outcome}{fetchRow.httpStatus ? ` (HTTP ${fetchRow.httpStatus})` : ""} · {fetchRow.itemsNew} nouveau(x), {fetchRow.itemsSeen} déjà vu(s){fetchRow.error ? <span className="text-destructive"> · {fetchRow.error}</span> : null}
        </li>)}</ul>
      </details>}
    </Section>

    <Section id="trust" title="Confiance">
      <p className="text-sm text-muted-foreground">Un refus, à n’importe quel niveau, l’emporte sur les approbations ; sans décision, une source reste en attente : analysée, jamais suffisante seule pour publier.</p>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label htmlFor="global-trust" className="font-medium">Confiance globale</label>
        <select id="global-trust" className={selectClass} disabled={busy} value={detail.globalTrust} onChange={event => void trust("global", null, event.target.value as Trust)}>
          {OPTIONS.map(value => <option key={value} value={value}>{TRUST[value].label}</option>)}
        </select>
        {status === "disabled" && <span className="text-xs text-muted-foreground">La modifier réactive la collecte.</span>}
      </div>
      {detail.agents.length > 0 ? <table className="w-full table-fixed border-collapse text-sm">
        <caption className="sr-only">Confiance par ΞAgent et par topic</caption>
        <thead><tr className="border-b text-left text-muted-foreground"><th scope="col" className="py-2 pr-2 font-medium">ΞAgent</th><th scope="col" className="w-40 py-2 font-medium">Effective</th></tr></thead>
        <tbody>{detail.effective.map(row => {
          const handle = handles.get(row.agentId)!;
          return <tr key={row.agentId} className="border-b align-top last:border-b-0">
            <th scope="row" className="space-y-1 py-2 pr-2 text-left font-normal">
              <span className="block font-semibold">{handle}</span>
              {scopedSelect("agent", row.agentId, handle)}
            </th>
            <td className="py-2">
              <TrustBadge value={row.trust} />
              <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground" aria-label={`Confiance effective de ${handle} par topic`}>
                {row.topics.map(topic => <li key={topic.topicId}>{tags.get(topic.topicId) ?? "topic"} : {TRUST[topic.trust].label.toLowerCase()}</li>)}
              </ul>
            </td>
          </tr>;
        })}</tbody>
      </table> : <p className="text-sm text-muted-foreground">Aucun ΞAgent en veille : seule la décision globale s’applique.</p>}
      {detail.topics.length > 0 && <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">Décisions par topic</legend>
        <ul className="divide-y rounded-md border">{detail.topics.map(topic => <li key={topic.id} className="flex flex-wrap items-center justify-between gap-2 p-2 text-sm">
          <span className="font-medium">#{topic.tag}</span>{scopedSelect("topic", topic.id, `#${topic.tag}`)}
        </li>)}</ul>
      </fieldset>}
    </Section>

    <Section id="metadata" title="Métadonnées">
      {status === "rejected" ? <p className="text-sm text-muted-foreground">Source refusée : approuvez-la ou remettez-la en attente pour modifier ses métadonnées.</p>
        : <form onSubmit={save} className="grid gap-3 text-sm">
          <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1"><label htmlFor="source-publisher">Nom</label><Input id="source-publisher" required maxLength={200} value={edits.publisher} onChange={event => setEdits({ ...edits, publisher: event.target.value })} /></div>
            <div className="grid gap-1"><label htmlFor="source-group">Groupe propriétaire</label><Input id="source-group" maxLength={200} value={edits.ownerGroup} onChange={event => setEdits({ ...edits, ownerGroup: event.target.value })} placeholder="Inconnu" /></div>
            <div className="grid gap-1"><label htmlFor="source-orientation">Orientation éditoriale</label><Input id="source-orientation" maxLength={200} value={edits.orientation} onChange={event => setEdits({ ...edits, orientation: event.target.value })} placeholder="Non renseignée" /></div>
            <div className="grid gap-1"><label htmlFor="source-reliability">Fiabilité</label>
              <select id="source-reliability" className={selectClass} value={edits.reliability} onChange={event => setEdits({ ...edits, reliability: event.target.value as typeof edits.reliability })}>
                {RELIABILITY.map(level => <option key={level} value={level}>{level}</option>)}
              </select></div>
            <div className="grid gap-1"><label htmlFor="source-poll">Fréquence de collecte (minutes)</label><Input id="source-poll" type="number" required min={15} max={1440} value={edits.pollMinutes} onChange={event => setEdits({ ...edits, pollMinutes: Number(event.target.value) })} /></div>
            <fieldset className="grid gap-1 sm:col-span-2"><legend>Topics</legend>
              <div className="flex flex-wrap gap-3">{attachable.map(topic => <label key={topic.id} className="inline-flex items-center gap-1.5">
                <input type="checkbox" checked={edits.topicIds.includes(topic.id)} onChange={event => setEdits({ ...edits, topicIds: event.target.checked ? [...edits.topicIds, topic.id] : edits.topicIds.filter(id => id !== topic.id) })} />#{topic.tag}
              </label>)}</div>
            </fieldset>
          </fieldset>
          <div><Button type="submit" disabled={busy || !edits.topicIds.length || !edits.publisher.trim()}>Enregistrer</Button></div>
        </form>}
    </Section>

    <Section id="items" title="Dernières actualités collectées">
      {detail.items.length ? <ul className="space-y-2 text-sm">{detail.items.map(item => <li key={item.id}>
        {item.url ? <a className="inline-flex items-start gap-1 font-medium underline-offset-2 hover:underline" href={item.url} target="_blank" rel="noopener noreferrer">{item.title}<ExternalLink aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" /><span className="sr-only"> (nouvel onglet)</span></a> : <span className="font-medium">{item.title}</span>}
        <span className="block text-xs text-muted-foreground">{item.publishedAt ? `Publiée le ${date(item.publishedAt)}` : "Date de publication inconnue"} · collectée le {date(item.fetchedAt)}</span>
      </li>)}</ul> : <p className="text-sm text-muted-foreground">Aucune actualité collectée pour l’instant.</p>}
    </Section>

    <Section id="history" title="Historique des décisions">
      <ol className="space-y-1 text-sm">{[...source.history].reverse().map((entry, index) => <li key={`${entry.at}-${index}`}>
        <span className="font-medium">{entry.action === "updated" && entry.changes?.status === "proposed" ? "Remise en attente" : HISTORY[entry.action] ?? entry.action}</span>
        {" "}— {date(entry.at)}, {entry.by.startsWith("agent:") ? (handles.get(entry.by.slice(6)) ?? "un ΞAgent") : "vous"}
        {entry.note ? <span className="block text-xs text-muted-foreground">{entry.note}</span> : null}
      </li>)}</ol>
      {detail.decisions.some(entry => entry.scope !== "global") && <ul className="space-y-1 text-sm" aria-label="Décisions spécifiques en vigueur">{detail.decisions.filter(entry => entry.scope !== "global").map(entry =>
        <li key={`${entry.scope}-${entry.scopeId}`}>{TRUST[entry.decision].label} pour {entry.scope === "agent" ? handles.get(entry.scopeId!) : `le topic ${tags.get(entry.scopeId!)}`} — {date(entry.at)}</li>)}</ul>}
    </Section>

    <section aria-labelledby="danger" className="space-y-2 p-4">
      <h2 id="danger" className="text-lg font-bold">Supprimer la source</h2>
      <p className="text-sm text-muted-foreground">La suppression retire la source du catalogue : elle n’est plus collectée ni reproposée par vos ΞAgents, ses articles ne servent plus de preuve. Les publications et l’historique sont conservés. Pour seulement ne plus lui faire confiance, refusez-la.</p>
      <Button type="button" variant="destructive" disabled={busy} onClick={() => { setConfirmed(false); setDeleting(true); }}>Supprimer…</Button>
    </section>
    <Dialog open={deleting} onOpenChange={setDeleting}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Supprimer {source.publisher} ?</DialogTitle>
          <DialogDescription>Elle disparaît du catalogue et de la matrice de confiance ; un brouillon qui la cite ne sera pas publié. Vous pourrez la rajouter plus tard par son adresse : elle reviendra en attente.</DialogDescription>
        </DialogHeader>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />Je confirme la suppression de cette source</label>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setDeleting(false)}>Annuler</Button>
          <Button type="button" variant="destructive" disabled={!confirmed || busy} onClick={() => void remove()}>Supprimer définitivement</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}

function editable(detail: SourceDetail) {
  const { source } = detail;
  return { publisher: source.publisher, ownerGroup: source.ownerGroup ?? "", orientation: source.orientation ?? "", pollMinutes: source.pollMinutes, reliability: source.reliability.level, topicIds: source.topicIds };
}
