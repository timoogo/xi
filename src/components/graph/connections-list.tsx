"use client";

import { ArrowDown, Loader2, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { fetchConnections, GraphApiError, isAbortError } from "@/lib/graph/client";
import { GRAPH_LIMITS, SEMANTIC_TYPES, type ConnectionItem, type ConnectionsFilters, type ConnectionsScope, type MessageRef, type MessageSummary } from "@/lib/graph/types";
import { cn } from "@/lib/utils";
import { plural, TYPE_LABELS } from "./model";

const dateFormat = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" });
export const formatDay = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : dateFormat.format(date);
};

type Page = { items: ConnectionItem[]; total: number; nextCursor: string | null };

export function ReviewBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 px-1.5 text-[11px] text-amber-700 dark:text-amber-300" title="Signalée comme à réexaminer">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-amber-500" />À réexaminer
    </span>
  );
}

export function MessageButton({ summary, current, onOpen, prefix }: { summary: MessageSummary; current: boolean; onOpen: (ref: MessageRef) => void; prefix?: string }) {
  return (
    <button type="button" onClick={() => onOpen(summary.ref)} aria-current={current ? "true" : undefined}
      aria-label={`${prefix ? `${prefix} : ` : ""}ouvrir le message ${summary.position} « ${summary.excerpt} »`}
      className="block w-full rounded-lg border bg-background px-3 py-2 text-left text-[13.5px] leading-snug hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-[current=true]:border-chart-2/60">
      <span className="mb-0.5 block text-[11px] font-medium text-muted-foreground">Message {summary.position}</span>
      <span className="line-clamp-2">{summary.excerpt || "Message sans texte"}</span>
    </button>
  );
}

/** Paginated relations of a scope, newest first, with the filters of the API. */
export function ConnectionsList({ scope, filters, onFilters, generators, currentRef, onOpenMessage }: {
  scope: ConnectionsScope;
  filters: ConnectionsFilters;
  onFilters: (filters: ConnectionsFilters) => void;
  generators: { id: string; label: string }[];
  currentRef: MessageRef | null;
  onOpenMessage: (ref: MessageRef) => void;
}) {
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const key = JSON.stringify({ scope, filters });

  useEffect(() => {
    const abort = new AbortController();
    controller.current?.abort();
    controller.current = abort;
    setLoading(true);
    setError(null);
    setPage(null);
    const { scope: s, filters: f } = JSON.parse(key) as { scope: ConnectionsScope; filters: ConnectionsFilters };
    fetchConnections({ scope: s, filters: f, limit: GRAPH_LIMITS.connectionsPageSize }, abort.signal)
      .then((response) => setPage(response))
      .catch((reason) => { if (!isAbortError(reason)) setError(reason instanceof GraphApiError ? reason.message : "Impossible de charger les connexions."); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [key, attempt]);

  function loadMore() {
    if (!page?.nextCursor || loading) return;
    const abort = new AbortController();
    controller.current = abort;
    setLoading(true);
    fetchConnections({ scope, filters, cursor: page.nextCursor, limit: GRAPH_LIMITS.connectionsPageSize }, abort.signal)
      .then((next) => setPage((current) => current && { items: [...current.items, ...next.items.filter((item) => !current.items.some((known) => known.id === item.id))], total: next.total, nextCursor: next.nextCursor }))
      .catch((reason) => { if (!isAbortError(reason)) setError(reason instanceof GraphApiError ? reason.message : "Impossible de charger la suite."); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
  }

  const types = filters.types ?? [];
  const activeFilters = types.length + (filters.generator ? 1 : 0) + (filters.from ? 1 : 0) + (filters.to ? 1 : 0) + (filters.needsReview ? 1 : 0);
  const set = (patch: Partial<ConnectionsFilters>) => {
    const next: ConnectionsFilters = { ...filters, ...patch };
    for (const name of Object.keys(next) as (keyof ConnectionsFilters)[]) {
      const value = next[name];
      if (value === undefined || value === "" || value === false || (Array.isArray(value) && !value.length)) delete next[name];
    }
    onFilters(next);
  };
  const field = "h-8 w-full rounded-md border bg-background px-2 text-[13px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

  return (
    <div className="space-y-3">
      <details className="group rounded-xl border px-3 py-2" open={activeFilters > 0 ? true : undefined}>
        <summary className="flex cursor-pointer list-none items-center gap-2 text-[13px] font-medium [&::-webkit-details-marker]:hidden">
          <SlidersHorizontal aria-hidden="true" className="size-4" />Filtres{activeFilters ? <span className="rounded-full bg-chart-2/15 px-1.5 text-chart-2 tabular-nums">{activeFilters}</span> : null}
        </summary>
        <div className="mt-3 space-y-3">
          <fieldset>
            <legend className="mb-1.5 text-xs text-muted-foreground">Type de relation</legend>
            <div className="flex flex-wrap gap-1.5">
              {SEMANTIC_TYPES.map((type) => {
                const on = types.includes(type);
                return (
                  <button key={type} type="button" aria-pressed={on} onClick={() => set({ types: on ? types.filter((other) => other !== type) : [...types, type] })}
                    className={cn("h-7 rounded-full border px-2.5 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50", on ? "border-chart-2 bg-chart-2/15 font-semibold text-chart-2" : "hover:bg-accent")}>
                    {TYPE_LABELS[type]}
                  </button>
                );
              })}
            </div>
          </fieldset>
          {generators.length ? (
            <label className="block text-xs text-muted-foreground">Générateur
              <select value={filters.generator ?? ""} onChange={(event) => set({ generator: event.target.value || undefined })} className={cn(field, "mt-1 text-foreground")}>
                <option value="">Tous les générateurs</option>
                {generators.map((generator) => <option key={generator.id} value={generator.id}>{generator.label}</option>)}
              </select>
            </label>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-muted-foreground">Du
              <input type="date" value={filters.from ?? ""} max={filters.to} onChange={(event) => set({ from: event.target.value || undefined })} className={cn(field, "mt-1 text-foreground")} />
            </label>
            <label className="text-xs text-muted-foreground">Au
              <input type="date" value={filters.to ?? ""} min={filters.from} onChange={(event) => set({ to: event.target.value || undefined })} className={cn(field, "mt-1 text-foreground")} />
            </label>
          </div>
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={!!filters.needsReview} onChange={(event) => set({ needsReview: event.target.checked || undefined })} className="size-4 accent-[var(--chart-2)]" />
            Seulement les relations à réexaminer
          </label>
          {activeFilters ? <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onFilters({})}>Effacer les filtres</Button> : null}
        </div>
      </details>

      <p role="status" className="text-[13px] text-muted-foreground">
        {page ? plural(page.total, "relation validée", "relations validées") : loading ? "Chargement des connexions…" : null}
      </p>
      {error ? (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-[13px]">
          {error} <button type="button" className="font-semibold underline" onClick={() => setAttempt((n) => n + 1)}>Réessayer</button>
        </div>
      ) : null}
      {page && !page.items.length && !loading ? <p className="text-[13px] text-muted-foreground">Aucune relation ne correspond à ces critères.</p> : null}

      {page?.items.length ? (
        <ol className="space-y-3" aria-label="Relations">
          {page.items.map((item) => (
            <li key={item.id} className="rounded-xl border bg-muted/30 p-2.5">
              <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs">
                <span className="rounded-full bg-chart-2/15 px-2 py-0.5 font-semibold text-chart-2">{TYPE_LABELS[item.type]}</span>
                {item.needsReview ? <ReviewBadge /> : null}
                <time dateTime={item.createdAt} className="ml-auto text-muted-foreground">{formatDay(item.createdAt)}</time>
              </div>
              <p className="sr-only">{`Relation « ${TYPE_LABELS[item.type]} » de la source vers la cible`}</p>
              <MessageButton summary={item.source} current={item.source.ref === currentRef} onOpen={onOpenMessage} prefix="Source" />
              <div aria-hidden="true" className="flex items-center gap-1.5 py-1 pl-3 text-[11px] text-muted-foreground">
                <ArrowDown className="size-3.5" />source → cible
              </div>
              <MessageButton summary={item.target} current={item.target.ref === currentRef} onOpen={onOpenMessage} prefix="Cible" />
            </li>
          ))}
        </ol>
      ) : null}
      {page?.nextCursor ? (
        <Button variant="outline" size="sm" className="w-full rounded-full" disabled={loading} onClick={loadMore}>
          {loading ? <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : null}Charger plus
        </Button>
      ) : null}
    </div>
  );
}
