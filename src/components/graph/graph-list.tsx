"use client";

import { ChevronDown, ChevronRight, Circle, X } from "lucide-react";
import type { ConnectionsScope, GraphNode, NodeId } from "@/lib/graph/types";
import { edgeAriaLabel, nodeAriaLabel, plural, treeOrder, type DisplayGraph } from "./model";

/** Text alternative of the canvas: the same nodes and edges, as ordinary lists and buttons. */
export function GraphList({ graph, expanded, selected, labelFor, onActivate, onCounter, onLoadMore, onClose }: {
  graph: DisplayGraph;
  expanded: ReadonlySet<NodeId>;
  selected: NodeId | null;
  labelFor: (id: NodeId) => string;
  onActivate: (node: GraphNode) => void;
  onCounter: (scope: ConnectionsScope) => void;
  onLoadMore: (node: GraphNode) => void;
  onClose: () => void;
}) {
  const depthOf = (node: GraphNode) => {
    let depth = 0;
    for (let parent = node.parent; parent && graph.byId.has(parent) && depth < 12; parent = graph.byId.get(parent)!.parent) depth++;
    return depth;
  };
  const counter = "rounded-full border px-2 py-0.5 text-xs tabular-nums hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";
  return (
    <section aria-labelledby="graph-list-title" className="absolute inset-0 z-50 flex flex-col bg-background sm:z-20 sm:inset-y-3 sm:left-3 sm:right-auto sm:w-[360px] sm:rounded-2xl sm:border sm:shadow-lg">
      <header className="flex items-center gap-2 border-b px-4 py-2.5">
        <h2 id="graph-list-title" className="flex-1 text-[15px] font-bold">Liste du graphe</h2>
        <button type="button" onClick={onClose} aria-label="Fermer la liste" className="inline-flex size-8 items-center justify-center rounded-full hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <X aria-hidden="true" className="size-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 text-sm">
        <h3 className="px-2 py-1 text-[13px] font-semibold text-muted-foreground">{plural(graph.nodes.length, "nœud affiché", "nœuds affichés")}</h3>
        <ul>
          {treeOrder(graph.nodes).map((node) => {
            const open = expanded.has(node.id);
            const Icon = node.level === "message" || !node.childCount ? Circle : open ? ChevronDown : ChevronRight;
            return (
              <li key={node.id} className="flex flex-wrap items-center gap-1.5 py-0.5" style={{ paddingLeft: depthOf(node) * 14 }}>
                <button type="button" onClick={() => onActivate(node)} aria-label={nodeAriaLabel(node, open)} aria-expanded={node.level !== "message" && node.childCount ? open : undefined}
                  aria-current={node.id === selected ? "true" : undefined}
                  className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-[current=true]:bg-chart-2/10 aria-[current=true]:font-semibold">
                  <Icon aria-hidden="true" className={node.level === "message" || !node.childCount ? "size-2 shrink-0 fill-current text-muted-foreground" : "size-4 shrink-0"} />
                  <span className="truncate">{node.label}</span>
                </button>
                {node.counts.internal ? <button type="button" className={counter} onClick={() => onCounter({ kind: "internal", node: node.id })} aria-label={`${plural(node.counts.internal, "connexion interne", "connexions internes")} de « ${node.label} »`}>{node.counts.internal} int.</button> : null}
                {node.counts.external ? <button type="button" className={counter} onClick={() => onCounter({ kind: "external", node: node.id })} aria-label={`${plural(node.counts.external, "connexion externe", "connexions externes")} de « ${node.label} »`}>{node.counts.external} ext.</button> : null}
                {open && node.shownChildren < node.childCount ? (
                  <button type="button" className={counter} onClick={() => onLoadMore(node)}>Charger plus ({node.childCount - node.shownChildren})</button>
                ) : null}
              </li>
            );
          })}
        </ul>
        <h3 className="mt-3 px-2 py-1 text-[13px] font-semibold text-muted-foreground">{plural(graph.edges.length, "lien de connexions", "liens de connexions")}</h3>
        {graph.edges.length ? (
          <ul>
            {graph.edges.map((edge) => (
              <li key={edge.id}>
                <button type="button" onClick={() => onCounter({ kind: "between", a: edge.a, b: edge.b })}
                  className="w-full rounded-md px-2 py-1 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
                  <span className="sr-only">{edgeAriaLabel(edge, labelFor)}</span>
                  <span aria-hidden="true" className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate">{labelFor(edge.a)} ↔ {labelFor(edge.b)}</span>
                    <span className="tabular-nums font-semibold">{edge.shown}</span>
                    {edge.needsReview ? <span className="size-2 shrink-0 rounded-full bg-amber-500" /> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="px-2 py-1 text-muted-foreground">Aucun lien entre les nœuds affichés.</p>}
      </div>
    </section>
  );
}
