"use client";
import { Check, CircleDashed, SlidersHorizontal, X, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { Trust, TrustDecision, TrustMatrix, TrustScope } from "@/lib/watch/trust";
import { cn } from "@/lib/utils";

type SourceRow = TrustMatrix["sources"][number];
type Agent = TrustMatrix["agents"][number];
type Filter = "all" | Trust;
/** What a row shows: the trust and where it comes from. */
type Shown = { value: Trust; origin: string };

const STATE: Record<Trust, { label: string; icon: LucideIcon; className: string }> = {
  approved: { label: "Approuvée", icon: Check, className: "text-emerald-700 dark:text-emerald-400" },
  pending: { label: "En attente", icon: CircleDashed, className: "text-muted-foreground" },
  denied: { label: "Refusée", icon: X, className: "text-destructive" },
};
const OPTIONS: Trust[] = ["approved", "pending", "denied"];
const selectClass = "rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60";
const date = (value: string) => new Date(value).toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" });

/**
 * Sources and their trust, one row each. « Tous les ΞAgents »: the selector sets the global
 * decision. One ΞAgent: it shows the trust that agent resolves (denial first, then approval) and
 * sets the agent's own decision, never the global one. Every scope of a source (global, each
 * ΞAgent, each topic) is edited in its « Périmètre » dialog.
 */
export function SourceTrustList({ initial }: { initial: TrustMatrix }) {
  const [matrix, setMatrix] = useState(initial);
  const [agentId, setAgentId] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [scoped, setScoped] = useState<SourceRow | null>(null);
  /** The « Périmètre » button that opened the dialog: focus goes back to it on close. */
  const opener = useRef<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const decisions = useMemo(() => new Map(matrix.decisions.map(entry => [`${entry.sourceId}:${entry.scope}:${entry.scopeId ?? ""}`, entry])), [matrix.decisions]);
  const decisionOf = (sourceId: string, scope: TrustScope, id: string | null) => decisions.get(`${sourceId}:${scope}:${id ?? ""}`) ?? null;
  const agent = matrix.agents.find(item => item.id === agentId) ?? null;
  const handles = useMemo(() => new Map(matrix.agents.map(item => [item.id, `@${item.handle}`])), [matrix.agents]);
  const tags = useMemo(() => new Map(matrix.topics.map(topic => [topic.id, `#${topic.tag}`])), [matrix.topics]);

  /** Same precedence as the pipeline (trust.ts); topic decisions apply per story, so they are shown only when they agree. */
  const shown = (source: SourceRow, forAgent: Agent | null): Shown => {
    const global = decisionOf(source.id, "global", null)?.decision;
    if (!forAgent) return global ? { value: global, origin: "Globale" } : { value: "pending", origin: "Aucune décision" };
    const own = decisionOf(source.id, "agent", forAgent.id)?.decision;
    const handle = `@${forAgent.handle}`;
    if (global === "denied") return { value: "denied", origin: own === "approved" ? "Refus global prioritaire" : "Globale" };
    if (own) return { value: own, origin: `Spécifique à ${handle}` };
    const topics = forAgent.topicIds.flatMap(id => { const entry = decisionOf(source.id, "topic", id); return entry ? [entry] : []; });
    const denied = topics.filter(entry => entry.decision === "denied");
    const approved = topics.filter(entry => entry.decision === "approved");
    if (denied.length && (approved.length || global === "approved")) return { value: global === "approved" ? "approved" : "pending", origin: `Variable selon le topic (refus ${denied.map(entry => tags.get(entry.scopeId!)).join(" ")})` };
    if (denied.length) return { value: "denied", origin: `Héritée du topic ${denied.map(entry => tags.get(entry.scopeId!)).join(" ")}` };
    if (global === "approved") return { value: "approved", origin: "Globale" };
    if (approved.length) return { value: "approved", origin: `Héritée du topic ${approved.map(entry => tags.get(entry.scopeId!)).join(" ")}` };
    return { value: "pending", origin: "Aucune décision" };
  };

  const visible = matrix.sources.filter(source => {
    const text = `${source.publisher} ${source.domain} ${source.url}`.toLowerCase();
    if (query.trim() && !text.includes(query.trim().toLowerCase())) return false;
    return filter === "all" || shown(source, agent).value === filter;
  });

  async function decide(source: SourceRow, scope: TrustScope, scopeId: string | null, decision: Trust) {
    setBusy(true); setNotice(""); setError("");
    try {
      const response = await fetch("/api/watch/trust", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId: source.id, scope, scopeId, decision, ...(scope === "global" ? { revision: source.revision } : {}) }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? "Décision impossible. Réessayez.");
      const fresh = await fetch("/api/watch/trust");
      const next: TrustMatrix | null = fresh.ok ? await fresh.json() : null;
      if (next) { setMatrix(next); setScoped(current => current && (next.sources.find(item => item.id === current.id) ?? null)); }
      const where = scope === "global" ? "pour tous vos ΞAgents" : scope === "agent" ? `pour ${handles.get(scopeId!) ?? "ce ΞAgent"}` : `pour le topic ${tags.get(scopeId!) ?? ""}`;
      const what = decision === "pending" ? `décision retirée ${where}` : `${STATE[decision].label.toLowerCase()} ${where}`;
      // An agent decision never overrides a global denial: said explicitly.
      const prevails = scope !== "global" && decision === "approved" && next?.decisions.some(entry => entry.sourceId === source.id && entry.scope === "global" && entry.decision === "denied");
      setNotice(`${source.publisher} : ${what}.${prevails ? " Le refus global reste prioritaire." : ""}${result.rechecked ? ` ${result.rechecked} actualité(s) en cours de réévaluation.` : ""}`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Décision impossible."); }
    finally { setBusy(false); }
  }

  const scopeLabel = agent ? `pour @${agent.handle}` : "pour tous les ΞAgents";
  return <section aria-labelledby="trust-title" className="space-y-4 p-4">
    <div className="space-y-1">
      <h2 id="trust-title" className="text-lg font-bold">Niveau de confiance des sources</h2>
      <p className="text-sm text-muted-foreground">En attente : collectée et analysée, jamais suffisante seule pour publier. Approuvée : source de référence dans son périmètre. Refusée : plus utilisée comme preuve ni reproposée. Un refus l’emporte toujours sur une approbation.</p>
    </div>
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
      <div className="grid gap-1 text-sm"><label htmlFor="trust-agent">ΞAgent</label>
        <select id="trust-agent" className={selectClass} value={agentId} onChange={event => setAgentId(event.target.value)}>
          <option value="">Tous les ΞAgents</option>
          {matrix.agents.map(item => <option key={item.id} value={item.id}>@{item.handle} — {item.name}</option>)}
        </select>
      </div>
      <div className="grid gap-1 text-sm"><label htmlFor="trust-search">Rechercher</label>
        <Input id="trust-search" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Nom ou domaine" />
      </div>
      <div className="grid gap-1 text-sm"><label htmlFor="trust-state">État</label>
        <select id="trust-state" className={selectClass} value={filter} onChange={event => setFilter(event.target.value as Filter)}>
          <option value="all">Tous</option>
          {OPTIONS.map(value => <option key={value} value={value}>{STATE[value].label}</option>)}
        </select>
      </div>
    </div>
    <p className="text-sm text-muted-foreground">{agent ? `Le sélecteur règle la décision propre à @${agent.handle} ; la décision globale n’est pas modifiée.` : "Le sélecteur règle la décision globale, pour tous vos ΞAgents."} {visible.length} source(s) sur {matrix.sources.length}.</p>
    <div aria-live="polite">{notice && <p role="status" className="text-sm">{notice}</p>}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}</div>

    {!matrix.sources.length ? <p className="text-sm text-muted-foreground">Aucune source. Proposez-en depuis la page d’un ΞAgent : celles que vos ΞAgents découvrent apparaissent ici automatiquement.</p>
      : !visible.length ? <p className="text-sm text-muted-foreground">Aucune source ne correspond à ces critères.</p>
      : <table className="w-full table-fixed border-collapse text-sm">
        <caption className="sr-only">Sources et niveau de confiance {scopeLabel}</caption>
        <thead><tr className="border-b text-left text-muted-foreground">
          <th scope="col" className="py-2 pr-3 font-medium">Source</th>
          <th scope="col" className="w-44 py-2 font-medium sm:w-52">Niveau de confiance</th>
        </tr></thead>
        <tbody>{visible.map(source => {
          const state = shown(source, agent);
          const Icon = STATE[state.value].icon;
          const specific = matrix.decisions.filter(entry => entry.sourceId === source.id && entry.scope !== "global").length;
          return <tr key={source.id} className="border-b align-top last:border-b-0">
            <th scope="row" className="py-3 pr-3 text-left font-normal">
              <Link href={`/dashboard/sources/${source.id}`} className="block font-semibold break-words underline-offset-2 hover:underline focus-visible:underline">{source.publisher}</Link>
              <span className="block break-all text-muted-foreground">{source.domain}</span>
              <span className="block text-xs text-muted-foreground">{source.origin.kind === "agent" ? `Découverte par ${handles.get(source.origin.agentId) ?? "un ΞAgent"}` : "Ajoutée manuellement"}{source.status === "disabled" ? " · collecte désactivée" : ""}</span>
            </th>
            <td className="py-3">
              <div className="flex items-center gap-1.5">
                <Icon aria-hidden="true" className={cn("size-4 shrink-0", STATE[state.value].className)} />
                <select className={cn(selectClass, "min-w-0 flex-1 py-1.5")} disabled={busy} value={state.value}
                  aria-label={`Niveau de confiance de ${source.publisher} ${scopeLabel}`} aria-describedby={`origin-${source.id}`}
                  onChange={event => void decide(source, agent ? "agent" : "global", agent?.id ?? null, event.target.value as Trust)}>
                  {OPTIONS.map(value => <option key={value} value={value}>{STATE[value].label}</option>)}
                </select>
              </div>
              <p id={`origin-${source.id}`} className="mt-1 text-xs text-muted-foreground">{state.origin}{!agent && specific ? ` · ${specific} décision${specific > 1 ? "s" : ""} spécifique${specific > 1 ? "s" : ""}` : ""}</p>
              <Button type="button" variant="ghost" size="sm" className="mt-0.5 h-7 px-2 text-xs" disabled={busy} onClick={event => { opener.current = event.currentTarget; setScoped(source); }} aria-label={`Périmètre des décisions pour ${source.publisher}`}>
                <SlidersHorizontal aria-hidden="true" className="size-3.5" />Périmètre
              </Button>
            </td>
          </tr>;
        })}</tbody>
      </table>}

    <Dialog open={!!scoped} onOpenChange={open => { if (!open) setScoped(null); }}>
      {scoped && <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg" onCloseAutoFocus={event => { event.preventDefault(); opener.current?.focus(); }}>
        <DialogHeader>
          <DialogTitle>Périmètre — {scoped.publisher}</DialogTitle>
          <DialogDescription>Chaque décision vaut pour son périmètre. Un refus, à n’importe quel niveau, l’emporte sur les approbations ; une décision de topic s’applique aux actualités retenues sur ce topic.</DialogDescription>
        </DialogHeader>
        {scopeGroup("Global", [{ scope: "global", id: null, label: "Tous les ΞAgents et topics" }])}
        {scopeGroup("ΞAgents", matrix.agents.map(item => ({ scope: "agent" as const, id: item.id, label: `@${item.handle}` })))}
        {scopeGroup("Topics", matrix.topics.filter(topic => scoped.topicIds.includes(topic.id) || matrix.agents.some(item => item.topicIds.includes(topic.id))).map(topic => ({ scope: "topic" as const, id: topic.id, label: `#${topic.tag}` })))}
      </DialogContent>}
    </Dialog>
  </section>;

  /** One group of the scope dialog (a render helper, not a component: focus survives re-renders). */
  function scopeGroup(title: string, rows: { scope: TrustScope; id: string | null; label: string }[]) {
    if (!rows.length || !scoped) return null;
    const source = scoped;
    return <fieldset className="space-y-2">
      <legend className="text-sm font-semibold">{title}</legend>
      <ul className="divide-y rounded-md border">{rows.map(row => {
        const entry: TrustDecision | null = decisionOf(source.id, row.scope, row.id);
        return <li key={row.id ?? "global"} className="flex flex-wrap items-center justify-between gap-2 p-2 text-sm">
          <span className="min-w-0"><span className="font-medium">{row.label}</span>
            <span className="block text-xs text-muted-foreground">{entry ? `Décision du ${date(entry.at)}` : "Aucune décision"}</span></span>
          <select className={cn(selectClass, "py-1.5")} disabled={busy} value={entry?.decision ?? "pending"}
            aria-label={`Confiance de ${source.publisher} — ${title === "Global" ? "global" : row.label}`}
            onChange={event => void decide(source, row.scope, row.id, event.target.value as Trust)}>
            {OPTIONS.map(value => <option key={value} value={value}>{value === "pending" && row.scope !== "global" ? "Aucune décision" : STATE[value].label}</option>)}
          </select>
        </li>;
      })}</ul>
    </fieldset>;
  }
}
