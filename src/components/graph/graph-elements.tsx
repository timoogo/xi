"use client";

import { memo, type KeyboardEvent } from "react";
import type { ConnectionsScope, GraphNode } from "@/lib/graph/types";
import type { Point } from "./layout";
import { edgeAriaLabel, edgeWidth, nodeAriaLabel, plural, truncate, type DisplayEdge } from "./model";

const activateOnKey = (action: () => void) => (event: KeyboardEvent) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  event.stopPropagation();
  action();
};

const PILL_CHAR = 6.6;

/** A small focusable counter or action drawn in screen space. */
export function SvgPill({ x, y, text, label, onActivate, tone = "muted", review = false }: {
  x: number;
  y: number;
  text: string;
  label: string;
  onActivate: () => void;
  tone?: "muted" | "accent" | "outline";
  review?: boolean;
}) {
  const width = Math.round(text.length * PILL_CHAR + 14 + (review ? 8 : 0));
  return (
    <g role="button" tabIndex={0} aria-label={label} data-graph-control="" transform={`translate(${x},${y})`}
      onClick={(event) => { event.stopPropagation(); onActivate(); }} onKeyDown={activateOnKey(onActivate)}
      className="group/pill cursor-pointer outline-none">
      <title>{label}</title>
      <rect x={-3} y={-12} width={width + 6} height={24} rx={12} className="fill-none stroke-ring opacity-0 group-focus-visible/pill:opacity-100" strokeWidth={2.5} />
      <rect x={0} y={-9} width={width} height={18} rx={9}
        className={tone === "accent" ? "fill-chart-2/15 stroke-chart-2/50 group-hover/pill:fill-chart-2/25" : tone === "outline" ? "fill-background stroke-border group-hover/pill:fill-accent" : "fill-muted stroke-border group-hover/pill:fill-accent"} strokeWidth={1} />
      <text x={7} y={4} className={tone === "accent" ? "fill-chart-2 text-[11px] font-semibold tabular-nums" : "fill-foreground text-[11px] font-medium tabular-nums"}>{text}</text>
      {review ? <circle cx={width - 7} cy={0} r={3} className="fill-amber-500" /> : null}
    </g>
  );
}

const NODE_RADIUS = { generator: 17, publication: 12, message: 6 } as const;

function NodeShape({ node, root, expanded }: { node: GraphNode; root: boolean; expanded: boolean }) {
  if (node.level === "generator") {
    const r = root ? 21 : NODE_RADIUS.generator;
    const unassigned = node.id === "g:unassigned";
    return (
      <>
        <circle r={r} className={unassigned ? "fill-background stroke-muted-foreground" : "fill-background stroke-chart-2"} strokeWidth={2.5} strokeDasharray={unassigned ? "4 3" : undefined} />
        {node.childCount ? <Glyph open={expanded} /> : <circle r={3} className="fill-chart-2" />}
      </>
    );
  }
  if (node.level === "publication") {
    const s = NODE_RADIUS.publication;
    return (
      <>
        {node.publicationType === "thread" ? <rect x={-s + 4} y={-s - 4} width={s * 2} height={s * 2} rx={6} className="fill-background stroke-foreground/35" strokeWidth={1.5} /> : null}
        <rect x={-s} y={-s} width={s * 2} height={s * 2} rx={6} className="fill-background stroke-foreground/70" strokeWidth={2} />
        {node.childCount ? <Glyph open={expanded} small /> : null}
      </>
    );
  }
  return (
    <>
      <circle r={14} className="fill-transparent" />
      <circle r={NODE_RADIUS.message} className="fill-muted-foreground group-hover/node:fill-foreground" />
    </>
  );
}

function Glyph({ open, small = false }: { open: boolean; small?: boolean }) {
  const s = small ? 4.5 : 5.5;
  return (
    <g className="stroke-foreground" strokeWidth={1.8} strokeLinecap="round">
      <line x1={-s} y1={0} x2={s} y2={0} />
      {open ? null : <line x1={0} y1={-s} x2={0} y2={s} />}
    </g>
  );
}

export const nodeRadius = (node: GraphNode, root: boolean) => (node.level === "generator" && root ? 21 : NODE_RADIUS[node.level]);

export const GraphNodeView = memo(function GraphNodeView({ node, at, root, expanded, selected, showLabel, showCounters, onActivate, onCounter, onLoadMore, onFocusNode }: {
  node: GraphNode;
  at: Point;
  root: boolean;
  expanded: boolean;
  selected: boolean;
  showLabel: boolean;
  showCounters: boolean;
  onActivate: (node: GraphNode) => void;
  onCounter: (scope: ConnectionsScope) => void;
  onLoadMore: (node: GraphNode) => void;
  onFocusNode: (id: string) => void;
}) {
  const r = nodeRadius(node, root);
  const label = truncate(node.level === "message" ? `${node.position ?? ""}. ${node.label}` : node.label, node.level === "generator" ? 30 : 34);
  const remaining = node.childCount - node.shownChildren;
  const counters: { text: string; label: string; scope: ConnectionsScope; tone: "accent" | "outline" }[] = [];
  if (node.counts.internal) counters.push({ text: `${node.counts.internal} int.`, label: `${plural(node.counts.internal, "connexion interne", "connexions internes")} de « ${node.label} ». Afficher la liste`, scope: { kind: "internal", node: node.id }, tone: "accent" });
  if (node.counts.external) counters.push({ text: `${node.counts.external} ext.`, label: `${plural(node.counts.external, "connexion externe", "connexions externes")} de « ${node.label} ». Afficher la liste`, scope: { kind: "external", node: node.id }, tone: "outline" });
  let cursor = r + 8;
  return (
    <g transform={`translate(${at.x},${at.y})`}>
      <g role="button" tabIndex={0} data-node-id={node.id} aria-label={nodeAriaLabel(node, expanded)}
        aria-expanded={node.level !== "message" && node.childCount ? expanded : undefined} aria-current={selected ? "true" : undefined}
        onClick={() => onActivate(node)} onKeyDown={activateOnKey(() => onActivate(node))} onFocus={() => onFocusNode(node.id)}
        className="group/node cursor-pointer outline-none">
        <circle r={r + 7} className="fill-none stroke-ring opacity-0 group-focus-visible/node:opacity-100" strokeWidth={3} />
        {selected ? <circle r={r + 4} className="fill-chart-2/10 stroke-foreground" strokeWidth={2} /> : null}
        <NodeShape node={node} root={root} expanded={expanded} />
        {node.counts.needsReview ? <circle cx={-r * 0.75} cy={-r * 0.75} r={3.5} className="fill-amber-500 stroke-background" strokeWidth={1.5} /> : null}
        {showLabel ? (
          <text x={r + 8} y={showCounters && counters.length ? -3 : 4} className={`fill-foreground stroke-background ${node.level === "generator" ? "text-[13px] font-bold" : node.level === "publication" ? "text-[12.5px] font-medium" : "text-[12px]"}`}
            strokeWidth={4} strokeLinejoin="round" style={{ paintOrder: "stroke" }}>{label}</text>
        ) : null}
      </g>
      {showCounters ? counters.map((counter) => {
        const x = cursor;
        cursor += Math.round(counter.text.length * PILL_CHAR + 14) + 4;
        return <SvgPill key={counter.scope.kind} x={x} y={showLabel ? 12 : 0} text={counter.text} label={counter.label} tone={counter.tone} onActivate={() => onCounter(counter.scope)} />;
      }) : null}
      {expanded && remaining > 0 ? (
        <SvgPill x={-r} y={r + 16} text={`Charger plus (${remaining})`} label={`Charger plus d’éléments de « ${node.label} » : ${plural(remaining, "élément restant", "éléments restants")}`} onActivate={() => onLoadMore(node)} />
      ) : null}
    </g>
  );
});

export function StructuralLinkView({ from, to, kind }: { from: Point; to: Point; kind: "parent" | "reply" }) {
  return <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} className="stroke-foreground/15" strokeWidth={1} strokeDasharray={kind === "reply" ? "2 3" : undefined} />;
}

export function edgeTone(edge: DisplayEdge) {
  const contradicts = edge.byType.contradicts ?? 0;
  return contradicts * 2 > edge.total ? "stroke-destructive" : "stroke-chart-2";
}

export function SemanticEdgeLine({ edge, from, to, highlighted, dimmed }: { edge: DisplayEdge; from: Point; to: Point; highlighted: boolean; dimmed: boolean }) {
  return (
    <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} className={edgeTone(edge)} strokeLinecap="round"
      strokeWidth={edgeWidth(edge.shown)} strokeOpacity={highlighted ? 0.95 : dimmed ? 0.25 : 0.6} />
  );
}

export function EdgeCounter({ edge, from, to, labelFor, onOpen }: { edge: DisplayEdge; from: Point; to: Point; labelFor: (id: string) => string; onOpen: () => void }) {
  const text = edge.shown.toLocaleString("fr-FR");
  const width = Math.round(text.length * PILL_CHAR + 14 + (edge.needsReview ? 8 : 0));
  return (
    <SvgPill x={(from.x + to.x) / 2 - width / 2} y={(from.y + to.y) / 2} text={text} review={edge.needsReview > 0}
      label={edgeAriaLabel(edge, labelFor)} onActivate={onOpen} />
  );
}
