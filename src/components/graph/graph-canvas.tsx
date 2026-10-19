"use client";

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import type { LayoutMode, Viewport } from "@/lib/graph/local-state";
import type { ConnectionsScope, GraphNode, NodeId } from "@/lib/graph/types";
import { EdgeCounter, GraphNodeView, SemanticEdgeLine, StructuralLinkView, nodeRadius } from "./graph-elements";
import { createSimulation, freePositions, hierarchicalLayout, moveNode, syncSimulation, tick, type Point } from "./layout";
import { plural, treeOrder, type DisplayGraph } from "./model";
import { clampZoom, usePanZoom, zoomAt } from "./use-pan-zoom";

export type GraphCanvasHandle = {
  zoomBy: (factor: number) => void;
  /** Fits every displayed node in the view. */
  fit: () => void;
  /** Centres the view on a node, optionally at a given zoom. */
  centerOn: (id: NodeId, k?: number) => void;
};

const TRANSITION_MS = 450;
const TICKS_PER_FRAME = 3;
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

type Transition = { from: Map<NodeId, Point>; start: number; viewFrom: Viewport | null; viewTo: Viewport | null };

/**
 * SVG rendering in screen space: positions are world coordinates × zoom + pan, so node sizes and labels keep a
 * constant, legible size while zooming spreads or gathers the layout. The side panel overlays this element, so it
 * never resizes it: opening the panel cannot move a node.
 */
export function GraphCanvas({ ref, graph, mode, viewport, onViewport, selected, expanded, reducedMotion, labelFor, onActivate, onCounter, onLoadMore, fitOnSettle = false }: {
  ref?: Ref<GraphCanvasHandle>;
  /** Fits the view once, when the first layout settles (no viewport restored for this device). */
  fitOnSettle?: boolean;
  graph: DisplayGraph;
  mode: LayoutMode;
  viewport: Viewport | null;
  onViewport: (viewport: Viewport) => void;
  selected: NodeId | null;
  expanded: ReadonlySet<NodeId>;
  reducedMotion: boolean;
  labelFor: (id: NodeId) => string;
  onActivate: (node: GraphNode) => void;
  onCounter: (scope: ConnectionsScope) => void;
  onLoadMore: (node: GraphNode) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [, setFrame] = useState(0);
  const sim = useRef(createSimulation());
  const transition = useRef<Transition | null>(null);
  const raf = useRef<number | null>(null);
  const pendingFit = useRef(fitOnSettle);
  const fitRef = useRef<() => void>(() => {});
  const [focused, setFocused] = useState<NodeId | null>(null);

  const hierarchical = useMemo(() => hierarchicalLayout(graph.nodes), [graph.nodes]);
  const view = viewport ?? { x: size.width / 2, y: size.height / 2, k: 1 };
  const latest = useRef({ mode, view, onViewport, hierarchical, reducedMotion });
  useEffect(() => {
    latest.current = { mode, view, onViewport, hierarchical, reducedMotion };
  });

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!viewport && size.width) onViewport({ x: size.width / 2, y: size.height / 2, k: 1 });
  }, [viewport, size, onViewport]);

  const target = useCallback((id: NodeId): Point | undefined => {
    if (latest.current.mode === "hierarchical") return latest.current.hierarchical.get(id);
    const node = sim.current.nodes.get(id);
    return node ? { x: node.x, y: node.y } : undefined;
  }, []);

  const position = useCallback((id: NodeId): Point | undefined => {
    const to = target(id);
    const current = transition.current;
    if (!to || !current) return to;
    const from = current.from.get(id);
    if (!from) return to;
    const t = ease(Math.min(1, (performance.now() - current.start) / TRANSITION_MS));
    return { x: lerp(from.x, to.x, t), y: lerp(from.y, to.y, t) };
  }, [target]);

  const loop = useCallback(() => {
    if (raf.current !== null) return;
    const step = () => {
      raf.current = null;
      let active = false;
      if (latest.current.mode === "free") {
        for (let i = 0; i < TICKS_PER_FRAME; i++) active = tick(sim.current) || active;
      }
      const current = transition.current;
      if (current) {
        const t = Math.min(1, (performance.now() - current.start) / TRANSITION_MS);
        if (current.viewFrom && current.viewTo) {
          const e = ease(t);
          latest.current.onViewport({ x: lerp(current.viewFrom.x, current.viewTo.x, e), y: lerp(current.viewFrom.y, current.viewTo.y, e), k: lerp(current.viewFrom.k, current.viewTo.k, e) });
        }
        if (t >= 1) transition.current = null;
        else active = true;
      }
      if (!active && pendingFit.current && sim.current.nodes.size) {
        pendingFit.current = false;
        fitRef.current();
      }
      setFrame((frame) => frame + 1);
      if (active) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  }, []);

  // Reset the handle too: a remount (Strict Mode, Fast Refresh) would otherwise see a stale frame and never animate.
  useEffect(() => () => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
  }, []);

  // New nodes enter the simulation next to their parent; existing ones barely move.
  useEffect(() => {
    syncSimulation(sim.current, graph);
    if (latest.current.mode !== "free") return void setFrame((frame) => frame + 1);
    if (latest.current.reducedMotion) {
      while (tick(sim.current)) { /* settle synchronously, no animation */ }
      if (pendingFit.current && sim.current.nodes.size) {
        pendingFit.current = false;
        fitRef.current();
      }
      setFrame((frame) => frame + 1);
    } else loop();
  }, [graph, loop]);

  const viewportCentering = useCallback((id: NodeId | null, positions: (id: NodeId) => Point | undefined, zoom?: number): Viewport | null => {
    const point = id ? positions(id) : undefined;
    if (!point || !size.width) return null;
    const k = clampZoom(zoom ?? latest.current.view.k);
    return { k, x: size.width / 2 - point.x * k, y: size.height / 2 - point.y * k };
  }, [size]);

  // Mode switch: animate from the displayed positions and keep the selected node in the centre.
  const previousMode = useRef(mode);
  useEffect(() => {
    if (previousMode.current === mode) return;
    const snapshot = new Map<NodeId, Point>();
    const before = previousMode.current === "hierarchical" ? latest.current.hierarchical : freePositions(sim.current);
    for (const [id, point] of before) snapshot.set(id, point);
    previousMode.current = mode;
    if (mode === "free") {
      while (sim.current.alpha > 0.05 && tick(sim.current)) { /* finish a pending settle before showing it */ }
    }
    const centred = viewportCentering(selected, (id) => (mode === "hierarchical" ? latest.current.hierarchical.get(id) : sim.current.nodes.get(id)));
    if (reducedMotion) {
      transition.current = null;
      if (centred) onViewport(centred);
      setFrame((frame) => frame + 1);
      return;
    }
    transition.current = { from: snapshot, start: performance.now(), viewFrom: centred ? latest.current.view : null, viewTo: centred };
    loop();
    // Only the mode change starts a transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const onNodeDrag = useCallback((id: NodeId, world: Point, done: boolean) => {
    moveNode(sim.current, id, world, !done);
    setFrame((frame) => frame + 1);
  }, []);
  usePanZoom({ svgRef, viewport: view, onViewport, nodeDrag: mode === "free", onNodeDrag });

  const fit = useCallback(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of graph.nodes) {
      const point = position(node.id);
      if (!point) continue;
      minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
    }
    if (!Number.isFinite(minX) || !size.width) return onViewport({ x: size.width / 2, y: size.height / 2, k: 1 });
    const k = clampZoom(Math.min(1.4, (size.width - 160) / Math.max(1, maxX - minX + 200), (size.height - 120) / Math.max(1, maxY - minY + 80)));
    onViewport({ k, x: size.width / 2 - ((minX + maxX) / 2) * k, y: size.height / 2 - ((minY + maxY) / 2) * k });
  }, [graph.nodes, onViewport, position, size]);
  useEffect(() => { fitRef.current = fit; });

  useImperativeHandle(ref, () => ({
    zoomBy(factor) {
      const current = latest.current.view;
      onViewport(zoomAt(current, factor, { x: size.width / 2, y: size.height / 2 }));
    },
    fit,
    centerOn(id, k) {
      const centred = viewportCentering(id, position, k);
      if (centred) onViewport(centred);
    },
  }), [fit, onViewport, position, size, viewportCentering]);

  const screen = (id: NodeId): Point | undefined => {
    const point = position(id);
    return point ? { x: point.x * view.k + view.x, y: point.y * view.k + view.y } : undefined;
  };
  const ordered = useMemo(() => treeOrder(graph.nodes), [graph.nodes]);
  const points = new Map<NodeId, Point>();
  for (const node of ordered) {
    const point = screen(node.id);
    if (point) points.set(node.id, point);
  }
  const hierarchicalMode = mode === "hierarchical";
  const showLabel = (node: GraphNode) => node.id === selected || node.id === focused || hierarchicalMode
    || node.level === "generator" || (node.level === "publication" ? view.k >= 0.55 : view.k >= 1.4);
  const showCounters = (node: GraphNode) => node.id === selected || node.id === focused || (node.level === "message" ? view.k >= 1.6 : view.k >= 0.5);
  const highlighted = selected ?? focused;

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden">
      <svg ref={svgRef} width={size.width} height={size.height} role="group"
        onBlur={(event) => { if (!svgRef.current?.contains(event.relatedTarget as Node | null)) setFocused(null); }}
        aria-label={`Graphe : ${plural(graph.nodes.length, "nœud")}, ${plural(graph.edges.length, "lien")} de connexions. Utilisez Tab pour parcourir les nœuds, Entrée pour déplier.`}
        className="block touch-none select-none" style={{ cursor: "grab" }}>
        <g aria-hidden="true">
          {graph.links.map((link) => {
            const from = points.get(link.from);
            const to = points.get(link.to);
            return from && to ? <StructuralLinkView key={link.id} from={from} to={to} kind={link.kind} /> : null;
          })}
          {graph.edges.map((edge) => {
            const from = points.get(edge.a);
            const to = points.get(edge.b);
            if (!from || !to) return null;
            const touches = highlighted === edge.a || highlighted === edge.b;
            return <SemanticEdgeLine key={edge.id} edge={edge} from={from} to={to} highlighted={touches} dimmed={!!highlighted && !touches} />;
          })}
        </g>
        <g>
          {ordered.map((node) => {
            const at = points.get(node.id);
            if (!at) return null;
            const root = !node.parent || !graph.byId.has(node.parent);
            return (
              <GraphNodeView key={node.id} node={node} at={at} root={root} expanded={expanded.has(node.id)} selected={node.id === selected}
                showLabel={showLabel(node)} showCounters={showCounters(node)} onActivate={onActivate} onCounter={onCounter} onLoadMore={onLoadMore}
                onFocusNode={setFocused} />
            );
          })}
        </g>
        <g>
          {graph.edges.map((edge) => {
            const from = points.get(edge.a);
            const to = points.get(edge.b);
            if (!from || !to) return null;
            const nodeA = graph.byId.get(edge.a);
            const nodeB = graph.byId.get(edge.b);
            const clearance = (nodeA ? nodeRadius(nodeA, false) : 10) + (nodeB ? nodeRadius(nodeB, false) : 10) + 36;
            if (Math.hypot(to.x - from.x, to.y - from.y) < clearance) return null;
            return <EdgeCounter key={edge.id} edge={edge} from={from} to={to} labelFor={labelFor} onOpen={() => onCounter({ kind: "between", a: edge.a, b: edge.b })} />;
          })}
        </g>
      </svg>
    </div>
  );
}
