"use client";

import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { fetchView, GraphApiError, isAbortError, normalizeViewRequest } from "@/lib/graph/client";
import {
  createLocalStateSaver, defaultLocalState, goBack, goForward, loadLocalState, pushHistory,
  type GraphLocalState, type LayoutMode, type Viewport,
} from "@/lib/graph/local-state";
import { GRAPH_LIMITS, nodeLevel, type ConnectionsFilters, type ConnectionsScope, type GraphNode, type MessageRef, type NodeId, type NodeLevel, type SemanticType, type ViewRequest, type ViewResponse } from "@/lib/graph/types";
import { cn } from "@/lib/utils";
import { ConnectionsPanel } from "./connections-panel";
import { GraphCanvas, type GraphCanvasHandle } from "./graph-canvas";
import { GraphList } from "./graph-list";
import { GraphToolbar } from "./graph-toolbar";
import { AUTO_EXPAND_ZOOM, autoLevel, descendantsOf, generatorUuidOf, LEVEL_LABELS, messageRefOf, projectView } from "./model";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
function useReducedMotion() {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(REDUCED_MOTION);
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => true,
  );
}

/** Zoom at which the children of a level appear in automatic detail mode. */
const REVEAL_ZOOM: Partial<Record<NodeLevel, number>> = { generator: 0.6, publication: 0.9 };
const childrenShown = (level: NodeLevel, displayed: NodeLevel) => level === "generator" ? true : level === "publication" ? displayed === "message" : false;

/** Owns the explorer state: restores it from IndexedDB, fetches the view and wires the canvas, toolbar and panel. */
export function GraphExplorer({ userId, className }: { userId: string; className?: string }) {
  const [state, setState] = useState<GraphLocalState>(defaultLocalState);
  const [restored, setRestored] = useState(false);
  // A device without a saved viewport gets the whole graph framed once the first layout settles.
  const [fitOnSettle, setFitOnSettle] = useState(false);
  const saver = useMemo(() => createLocalStateSaver(userId), [userId]);
  const reducedMotion = useReducedMotion();
  const canvas = useRef<GraphCanvasHandle>(null);

  useEffect(() => {
    let alive = true;
    loadLocalState(userId).then((stored) => {
      if (!alive) return;
      if (stored) setState(stored);
      setFitOnSettle(!stored?.viewport);
      setRestored(true);
    });
    return () => { alive = false; };
  }, [userId]);
  useEffect(() => { if (restored) saver.save(state); }, [state, restored, saver]);
  useEffect(() => {
    const flush = () => saver.flush();
    const onHidden = () => { if (document.visibilityState === "hidden") saver.flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHidden);
      saver.flush();
    };
  }, [saver]);

  const patch = useCallback((update: Partial<GraphLocalState> | ((current: GraphLocalState) => Partial<GraphLocalState>)) => {
    setState((current) => ({ ...current, ...(typeof update === "function" ? update(current) : update) }));
  }, []);

  // Detail level: locked, or derived from the zoom with hysteresis.
  const k = state.viewport?.k ?? 1;
  const [auto, setAuto] = useState<NodeLevel>(() => autoLevel(k, "message"));
  useEffect(() => { setAuto((previous) => autoLevel(k, previous)); }, [k]);
  const level = state.lockedLevel ?? auto;

  // Expansions whose children are not displayed are not requested (the user's set itself is kept).
  const requestKey = useMemo(() => JSON.stringify(normalizeViewRequest({
    expanded: state.expanded.filter((entry) => childrenShown(nodeLevel(entry.id) ?? "message", level)),
  })), [state.expanded, level]);

  const [view, setView] = useState<ViewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!restored) return;
    const abort = new AbortController();
    setLoading(true);
    fetchView(JSON.parse(requestKey) as ViewRequest, { signal: abort.signal, force: retry > 0 })
      .then((response) => { setView(response); setError(null); })
      .catch((reason) => { if (!isAbortError(reason)) setError(reason instanceof GraphApiError ? reason.message : "Le graphe n’a pas pu être chargé."); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [requestKey, restored, retry]);

  const graph = useMemo(() => projectView(view, level, state.filters.types), [view, level, state.filters.types]);
  const expandedIds = useMemo(() => new Set(state.expanded.map((entry) => entry.id)), [state.expanded]);
  const displayedExpanded = useMemo(() => new Set([...expandedIds].filter((id) => childrenShown(nodeLevel(id) ?? "message", level))), [expandedIds, level]);
  const allNodes = useMemo(() => new Map((view?.nodes ?? []).map((node) => [node.id, node])), [view]);
  const labelFor = useCallback((id: NodeId) => allNodes.get(id)?.label ?? (nodeLevel(id) === "message" ? "Message" : "Nœud masqué"), [allNodes]);
  const generators = useMemo(() => (view?.nodes ?? []).flatMap((node) => {
    const uuid = node.level === "generator" ? generatorUuidOf(node.id) : null;
    return uuid ? [{ id: uuid, label: node.label }] : [];
  }), [view]);

  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const expand = useCallback((id: NodeId) => {
    if (expandedIds.has(id)) return true;
    if (state.expanded.length >= GRAPH_LIMITS.maxExpanded) {
      setNotice(`Au plus ${GRAPH_LIMITS.maxExpanded} éléments dépliés à la fois : repliez une branche pour en déplier une autre.`);
      return false;
    }
    patch((current) => ({ expanded: [...current.expanded, { id }] }));
    return true;
  }, [expandedIds, state.expanded.length, patch]);

  const collapse = useCallback((id: NodeId) => {
    const below = descendantsOf(id, view?.nodes ?? []);
    patch((current) => ({ expanded: current.expanded.filter((entry) => entry.id !== id && !below.has(entry.id)) }));
  }, [view, patch]);

  const [focusToken, setFocusToken] = useState(0);
  const openMessage = useCallback((ref: MessageRef) => {
    patch((current) => ({ history: pushHistory(current.history, ref), panel: { ...current.panel, open: true, view: "message" } }));
    setFocusToken((n) => n + 1);
  }, [patch]);
  const openConnections = useCallback((scope: ConnectionsScope) => {
    patch((current) => ({
      panel: { open: true, view: "connections", connections: { scope, filters: current.filters.types.length ? { types: [...current.filters.types] } : {} } },
      selected: scope.kind === "between" ? current.selected : scope.node,
    }));
    setFocusToken((n) => n + 1);
  }, [patch]);

  const activate = useCallback((node: GraphNode) => {
    patch({ selected: node.id });
    const ref = messageRefOf(node.id);
    if (ref) return openMessage(ref);
    if (!node.childCount) return;
    if (!childrenShown(node.level, level)) {
      // Children hidden by the detail level: in Auto, zoom in on the node; when locked, say why nothing appears.
      if (!expand(node.id)) return;
      if (state.lockedLevel) setNotice(`Détail verrouillé sur les ${LEVEL_LABELS[state.lockedLevel].toLowerCase()} : choisissez « Auto » ou un niveau plus fin pour voir le contenu.`);
      else canvas.current?.centerOn(node.id, REVEAL_ZOOM[node.level]);
      return;
    }
    if (displayedExpanded.has(node.id)) collapse(node.id);
    else expand(node.id);
  }, [patch, openMessage, level, expand, collapse, displayedExpanded, state.lockedLevel]);

  const loadMore = useCallback((node: GraphNode) => {
    patch((current) => ({
      expanded: current.expanded.map((entry) => entry.id === node.id
        ? { id: entry.id, limit: Math.min(GRAPH_LIMITS.maxChildLimit, (entry.limit ?? GRAPH_LIMITS.defaultChildLimit) + GRAPH_LIMITS.defaultChildLimit) }
        : entry),
    }));
  }, [patch]);

  // Zooming in past a threshold expands the selected node (automatic detail only).
  const previousK = useRef(k);
  useEffect(() => {
    const before = previousK.current;
    previousK.current = k;
    if (state.lockedLevel || before >= AUTO_EXPAND_ZOOM || k < AUTO_EXPAND_ZOOM || !state.selected) return;
    const node = allNodes.get(state.selected);
    if (node && node.level !== "message" && node.childCount && !expandedIds.has(node.id)) expand(node.id);
  }, [k, state.lockedLevel, state.selected, allNodes, expandedIds, expand]);

  const onViewport = useCallback((viewport: Viewport) => patch({ viewport }), [patch]);
  const [listOpen, setListOpen] = useState(false);

  return (
    <div className={cn("relative flex min-h-0 flex-col", className)}>
      <GraphToolbar
        mode={state.mode} onMode={(mode: LayoutMode) => patch({ mode })}
        lockedLevel={state.lockedLevel} effectiveLevel={level} onLock={(lockedLevel) => patch({ lockedLevel })}
        types={state.filters.types} onTypes={(types: SemanticType[]) => patch({ filters: { types } })}
        listOpen={listOpen} onList={() => setListOpen((open) => !open)}
        onZoom={(factor) => canvas.current?.zoomBy(factor)} onFit={() => canvas.current?.fit()}
      />
      <div className="relative min-h-0 flex-1 bg-[radial-gradient(circle,var(--border)_1px,transparent_1px)] [background-size:24px_24px]">
        {restored ? (
          <GraphCanvas ref={canvas} graph={graph} mode={state.mode} viewport={state.viewport} onViewport={onViewport}
            selected={state.selected} expanded={displayedExpanded} reducedMotion={reducedMotion} labelFor={labelFor}
            onActivate={activate} onCounter={openConnections} onLoadMore={loadMore} fitOnSettle={fitOnSettle} />
        ) : null}

        <div className="pointer-events-none absolute left-3 top-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-col items-start gap-2 sm:max-w-md">
          {loading || !restored ? (
            <p className="inline-flex items-center gap-2 rounded-full border bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow-sm">
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" />Chargement du graphe…
            </p>
          ) : null}
          {view?.truncated ? (
            <p className="rounded-xl border border-amber-500/40 bg-background/95 px-3 py-1.5 text-xs shadow-sm">
              Affichage limité à {GRAPH_LIMITS.maxNodes} nœuds : repliez des branches pour voir le reste.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="pointer-events-auto rounded-xl border border-destructive/40 bg-background/95 px-3 py-1.5 text-xs shadow-sm">
              {error} <button type="button" className="font-semibold underline" onClick={() => setRetry((n) => n + 1)}>Réessayer</button>
            </p>
          ) : null}
          {notice ? <p className="rounded-xl border bg-background/95 px-3 py-1.5 text-xs shadow-sm">{notice}</p> : null}
        </div>
        <p role="status" aria-live="polite" className="sr-only">{notice ?? (loading ? "Chargement du graphe" : `${graph.nodes.length} nœuds affichés`)}</p>

        {view && !view.nodes.length && !loading ? (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <div className="max-w-sm text-center">
              <p className="text-lg font-extrabold">Le graphe est vide</p>
              <p className="mt-1 text-[15px] text-muted-foreground">Aucun générateur ni aucune publication ne vous est accessible pour l’instant. Publiez un message ou rattachez une publication à un générateur pour le voir apparaître ici.</p>
            </div>
          </div>
        ) : null}

        {listOpen ? (
          <GraphList graph={graph} expanded={displayedExpanded} selected={state.selected} labelFor={labelFor}
            onActivate={activate} onCounter={openConnections} onLoadMore={loadMore} onClose={() => setListOpen(false)} />
        ) : null}

        {state.panel.open ? (
          <ConnectionsPanel
            panel={state.panel} history={state.history} focusToken={focusToken} generators={generators} labelFor={labelFor}
            onClose={() => patch((current) => ({ panel: { ...current.panel, open: false } }))}
            onBack={() => patch((current) => current.panel.view === "message" ? { history: goBack(current.history) } : { panel: { ...current.panel, view: "message" } })}
            onForward={() => patch((current) => ({ history: goForward(current.history) }))}
            onShowConnections={() => patch((current) => ({ panel: { ...current.panel, view: "connections" } }))}
            onOpenMessage={openMessage}
            onFilters={(filters: ConnectionsFilters) => patch((current) => current.panel.connections ? { panel: { ...current.panel, connections: { ...current.panel.connections, filters } } } : {})}
          />
        ) : null}
      </div>
    </div>
  );
}
