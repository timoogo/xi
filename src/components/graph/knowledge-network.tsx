"use client";

import { ChevronDown, ExternalLink, List, Loader2, Maximize2, Minus, Plus, Users, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type KeyboardEvent, type Ref } from "react";
import { Button } from "@/components/ui/button";
import type { Viewport } from "@/lib/graph/local-state";
import {
  KNOWLEDGE_LIMITS, knowledgeHref,
  type ConceptProvenance, type KnowledgeAgent, type KnowledgeEdge, type KnowledgeEvidence, type KnowledgeGraph, type KnowledgeNode, type KnowledgeRequest,
} from "@/lib/konstruktor/knowledge-graph";
import { topicHref } from "@/lib/search/query";
import { RELATION_TYPE_LABELS } from "@/lib/topics/network";
import type { TopicRelationType } from "@/lib/topics/relations";
import { cn } from "@/lib/utils";
import { plural, truncate } from "./model";
import { createSimulation, nearestIn, syncTopicLayout, type Direction, type Point } from "./topic-network-layout";
import { clampZoom, usePanZoom, zoomAt } from "./use-pan-zoom";

const RADIUS = 14;
const ARROWS: Record<string, Direction> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
const noDrag = () => {};
const dateFr = (iso: string | null) => iso ? new Date(iso).toLocaleDateString("fr-FR", { dateStyle: "medium", timeZone: "Europe/Paris" }) : "date inconnue";
const typeLabel = (type: string) => RELATION_TYPE_LABELS[type as TopicRelationType]?.label ?? type;

/** « Astronoxi », « Astronoxi et Orbites », « Astronoxi, Orbites et Vega ». */
export function agentList(names: string[]) {
  return names.length < 2 ? names[0] ?? "" : `${names.slice(0, -1).join(", ")} et ${names.at(-1)}`;
}
/** The text's own linking words, read from its subject: « NASA développe X-59 ». Without a subject, the words alone. */
export function linkPhrase(link: { text: string; subject: string | null }, edge: KnowledgeEdge, name: (id: string) => string) {
  if (!link.subject) return `« ${link.text} »`;
  const object = link.subject === edge.source ? edge.target : edge.source;
  return `${name(link.subject)} ${link.text} ${name(object)}`;
}
/** Label drawn on an edge: the text's words pointing to their object on screen, or the relation's type. */
function edgeText(edge: KnowledgeEdge, from: Point, to: Point) {
  const [link] = edge.labels;
  if (!link) return typeLabel(edge.type);
  const more = edge.labels.length > 1 ? ` +${edge.labels.length - 1}` : "";
  const text = truncate(link.text, 26);
  if (!link.subject) return `${text}${more}`;
  const [subject, object] = link.subject === edge.source ? [from, to] : [to, from];
  return object.x >= subject.x ? `${text} →${more}` : `← ${text}${more}`;
}

/** What the data says about a relation, never more: the stored status, then the owner's own mask. */
export function edgeStatus(edge: KnowledgeEdge) {
  if (edge.status === "excluded") return { label: "Exclue", tone: "border-muted-foreground/50 text-muted-foreground" };
  if (edge.hidden) return { label: "Masquée par vous", tone: "border-muted-foreground/50 text-muted-foreground" };
  return edge.status === "accepted" ? { label: "Validée", tone: "border-chart-2/70 text-foreground" } : { label: "Proposée, à examiner", tone: "border-amber-500/70 text-foreground" };
}
const rejected = (edge: KnowledgeEdge) => edge.status === "excluded" || edge.hidden;
const edgeTone = (edge: KnowledgeEdge) => rejected(edge) ? "muted" : edge.status === "proposed" ? "proposed" : edge.type === "opposes" ? "opposes" : "accepted";
const STROKE = { muted: "stroke-muted-foreground", proposed: "stroke-amber-500", opposes: "stroke-destructive", accepted: "stroke-chart-2" } as const;
const FILL = { muted: "fill-muted-foreground", proposed: "fill-amber-500", opposes: "fill-destructive", accepted: "fill-chart-2" } as const;
const origin = (edge: KnowledgeEdge) => edge.origin === "inference" ? `Inférence locale${edge.createdBy.startsWith("local-model:") ? ` (${edge.createdBy.slice(12)})` : ""}` : edge.origin === "agent" ? "Proposée par un ΞAgent" : "Ajoutée par vous";

/** "Connaissances" mode: one ΞAgent's concepts and relations, as recorded after human decisions. Read only. */
export function KnowledgeNetworkView({ graph, className }: { graph: KnowledgeGraph; className?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const { request } = graph;
  const go = useCallback((change: Partial<KnowledgeRequest>) => {
    startTransition(() => router.push(knowledgeHref({ ...request, ...change }), { scroll: false }));
  }, [request, router]);

  const byId = useMemo(() => new Map(graph.nodes.map(node => [node.id, node])), [graph.nodes]);
  const agentName = useMemo(() => { const names = new Map(graph.agents.map(agent => [agent.id, agent.name])); return (id: string) => names.get(id) ?? "ΞAgent"; }, [graph.agents]);
  const several = graph.selected.length > 1;
  // Distinct topics with the same name (a shared and a personal one, say) stay distinct concepts: their tag tells them apart.
  const homonyms = useMemo(() => {
    const seen = new Map<string, number>();
    for (const node of graph.nodes) seen.set(node.name.toLowerCase(), (seen.get(node.name.toLowerCase()) ?? 0) + 1);
    return new Set([...seen].filter(([, count]) => count > 1).map(([name]) => name));
  }, [graph.nodes]);
  const edgeById = useMemo(() => new Map(graph.edges.map(edge => [edge.id, edge])), [graph.edges]);
  const degree = useMemo(() => {
    const count = new Map<string, number>();
    for (const edge of graph.edges) for (const id of [edge.source, edge.target]) count.set(id, (count.get(id) ?? 0) + 1);
    return count;
  }, [graph.edges]);

  // One layout per selection (the component is keyed by it): placed concepts barely move when neighbours are added.
  const [sim] = useState(createSimulation);
  const positions = useMemo(() => {
    syncTopicLayout(sim, graph.nodes.map(node => node.id), graph.edges);
    return new Map<string, Point>([...sim.nodes].map(([id, node]) => [id, { x: node.x, y: node.y }]));
  }, [sim, graph.nodes, graph.edges]);

  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const view = viewport ?? { x: size.width / 2, y: size.height / 2, k: 1 };
  usePanZoom({ svgRef, viewport: view, onViewport: setViewport, nodeDrag: false, onNodeDrag: noDrag });

  const fit = useCallback(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const point of positions.values()) {
      minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
    }
    if (!Number.isFinite(minX) || !size.width) return setViewport({ x: size.width / 2, y: size.height / 2, k: 1 });
    const k = clampZoom(Math.min(1.3, (size.width - 80) / Math.max(1, maxX - minX + 220), (size.height - 80) / Math.max(1, maxY - minY + 80)));
    setViewport({ k, x: size.width / 2 - ((minX + maxX) / 2) * k, y: size.height / 2 - ((minY + maxY) / 2) * k });
  }, [positions, size]);
  const framed = useRef(false);
  useEffect(() => {
    if (framed.current || !size.width || !positions.size) return;
    framed.current = true;
    fit();
  }, [fit, size.width, positions.size]);

  const [selection, setSelection] = useState<{ kind: "node" | "edge"; id: string } | null>(request.focus ? { kind: "node", id: request.focus } : null);
  const node = selection?.kind === "node" ? byId.get(selection.id) ?? null : null;
  const edge = selection?.kind === "edge" ? edgeById.get(selection.id) ?? null : null;
  const [listOpen, setListOpen] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const [panelFocus, setPanelFocus] = useState(0);
  useEffect(() => { if (panelFocus) panelRef.current?.focus(); }, [panelFocus]);

  const screen = (point: Point): Point => ({ x: point.x * view.k + view.x, y: point.y * view.k + view.y });
  const centerOn = useCallback((id: string) => {
    const point = positions.get(id);
    if (!point || !size.width) return;
    setViewport((before) => {
      const k = before?.k ?? 1;
      const at = { x: point.x * k + (before?.x ?? 0), y: point.y * k + (before?.y ?? 0) };
      const inside = before && at.x > 40 && at.y > 40 && at.x < size.width - 40 && at.y < size.height - 40;
      return inside ? before : { k, x: size.width / 2 - point.x * k, y: size.height / 2 - point.y * k };
    });
  }, [positions, size]);
  const selectNode = useCallback((id: string, { moveFocus = false } = {}) => {
    setSelection({ kind: "node", id }); centerOn(id);
    if (moveFocus) setPanelFocus(n => n + 1);
  }, [centerOn]);
  const selectEdge = useCallback((id: string, { moveFocus = false } = {}) => {
    setSelection({ kind: "edge", id });
    if (moveFocus) setPanelFocus(n => n + 1);
  }, []);

  const onNodeKey = (item: KnowledgeNode) => (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectNode(item.id); return; }
    const direction = ARROWS[event.key];
    if (!direction) return;
    event.preventDefault();
    const from = positions.get(item.id);
    const next = from && nearestIn(from, direction, [...positions].filter(([id]) => id !== item.id));
    if (!next) return;
    centerOn(next);
    svgRef.current?.querySelector<SVGGElement>(`[data-concept-id="${next}"]`)?.focus();
  };

  // Concept provenance (publications, quotes, web sources): fetched on selection, agent by agent, cached.
  const [provenance, setProvenance] = useState<Record<string, ConceptProvenance | "error">>({});
  const requested = useRef(new Set<string>());
  useEffect(() => {
    if (!node) return;
    for (const { id: agent } of node.agents) {
      const key = `${agent}:${node.id}`;
      if (requested.current.has(key)) continue;
      requested.current.add(key);
      fetch(`/api/xiagents/${agent}/knowledge/${node.id}`)
        .then(async response => { if (!response.ok) throw new Error(); return await response.json() as ConceptProvenance; })
        .then(data => setProvenance(before => ({ ...before, [key]: data })))
        .catch(() => setProvenance(before => ({ ...before, [key]: "error" })));
    }
  }, [node]);

  const focusId = node?.id ?? null;
  // Concepts kept bright around the selection: the selected concept's neighbours, or a selected relation's two ends.
  const lit = useMemo(() => {
    if (edge) return new Set([edge.source, edge.target]);
    if (!focusId) return null;
    const ids = new Set([focusId]);
    for (const item of graph.edges) if (item.source === focusId) ids.add(item.target); else if (item.target === focusId) ids.add(item.source);
    return ids;
  }, [edge, focusId, graph.edges]);
  const labelsAll = view.k >= 1.15 && graph.edges.length <= 80;
  const chip = "h-9 rounded-full px-3 text-[13px]";
  const empty = !graph.nodes.length;

  return (
    <div className={cn("relative flex min-h-0 flex-col", className)} data-knowledge-network="">
      <div role="toolbar" aria-label="Outils des connaissances" className="relative z-50 flex flex-wrap items-center gap-1.5 border-b bg-background/90 px-3 py-2 backdrop-blur-md sm:px-4">
        {graph.agents.length ? <AgentPicker graph={graph} onChange={change => go({ focus: null, open: [], ...change })} /> : null}
        {graph.selected.length ? (
          <>
            <span className="hidden text-xs text-muted-foreground md:inline">
              {plural(graph.counts.concepts, "concept")} · {plural(graph.counts.accepted, "validée", "validées")} · {plural(graph.counts.proposed, "proposée", "proposées")}
            </span>
            <Button variant="outline" size="sm" aria-pressed={request.excluded} onClick={() => go({ excluded: !request.excluded })} disabled={!graph.counts.excluded && !request.excluded}
              className={cn(chip, request.excluded && "border-muted-foreground/60 bg-muted")} title="Relations exclues ou masquées par vous">
              <span aria-hidden="true" className="h-0 w-4 border-t-2 border-dotted border-muted-foreground" />Exclues<span className="tabular-nums text-muted-foreground">{graph.counts.excluded}</span>
            </Button>
          </>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon" className="size-9 rounded-full" aria-label="Zoom avant" title="Zoom avant" onClick={() => setViewport(zoomAt(view, 1.25, { x: size.width / 2, y: size.height / 2 }))}><Plus aria-hidden="true" /></Button>
          <Button variant="ghost" size="icon" className="size-9 rounded-full" aria-label="Zoom arrière" title="Zoom arrière" onClick={() => setViewport(zoomAt(view, 0.8, { x: size.width / 2, y: size.height / 2 }))}><Minus aria-hidden="true" /></Button>
          <Button variant="ghost" size="icon" className="size-9 rounded-full" aria-label="Recentrer le graphe" title="Recentrer le graphe" onClick={fit}><Maximize2 aria-hidden="true" /></Button>
          <Button variant={listOpen ? "secondary" : "ghost"} size="sm" className={chip} aria-pressed={listOpen} onClick={() => setListOpen(open => !open)} title="Liste textuelle des concepts et des relations">
            <List aria-hidden="true" /><span className="hidden min-[420px]:inline">Liste</span>
          </Button>
        </div>
      </div>

      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden bg-[radial-gradient(circle,var(--border)_1px,transparent_1px)] [background-size:24px_24px]">
        <svg ref={svgRef} width={size.width} height={size.height} role="group" className="block touch-none select-none" style={{ cursor: "grab" }}
          aria-label={`Connaissances de ${agentList(graph.selected.map(agent => agent.name)) || "l’ΞAgent"} : ${plural(graph.nodes.length, "concept")}, ${plural(graph.edges.length, "relation")}. Tab ou les flèches pour parcourir les concepts, Entrée pour sélectionner.`}>
          <defs>
            {(Object.keys(FILL) as (keyof typeof FILL)[]).map(tone => (
              <marker key={tone} id={`knowledge-arrow-${tone}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" className={FILL[tone]} />
              </marker>
            ))}
          </defs>
          <g>
            {graph.edges.map((item) => {
              const a = positions.get(item.source), b = positions.get(item.target);
              if (!a || !b) return null;
              const from = screen(a), to = screen(b);
              const length = Math.max(1, Math.hypot(to.x - from.x, to.y - from.y));
              // Stop at the node's edge so the arrowhead stays visible.
              const end = { x: to.x - ((to.x - from.x) / length) * (RADIUS + 4), y: to.y - ((to.y - from.y) / length) * (RADIUS + 4) };
              const isSelected = edge?.id === item.id;
              const near = focusId === item.source || focusId === item.target || isSelected;
              const dim = (focusId || edge) && !near;
              const tone = edgeTone(item);
              return (
                <g key={item.id} data-edge-id={item.id} data-status={item.status} data-hidden={item.hidden ? "" : undefined} onClick={() => selectEdge(item.id)} className="cursor-pointer">
                  <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="transparent" strokeWidth={14} />
                  <line x1={from.x} y1={from.y} x2={end.x} y2={end.y} className={STROKE[tone]} strokeLinecap="round"
                    strokeWidth={isSelected ? 4 : 2.5} strokeOpacity={dim ? 0.2 : rejected(item) ? 0.55 : 0.85}
                    strokeDasharray={rejected(item) ? "2 5" : item.status === "proposed" ? "6 5" : undefined}
                    markerEnd={item.directed ? `url(#knowledge-arrow-${tone})` : undefined} />
                  {near || labelsAll ? (
                    <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 5} textAnchor="middle" aria-hidden="true"
                      className={cn("fill-muted-foreground stroke-background text-[11px]", isSelected && "fill-foreground font-semibold")} strokeWidth={4} strokeLinejoin="round" style={{ paintOrder: "stroke" }}>
                      {edgeText(item, from, to)}{item.correction ? " (corrigée)" : ""}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </g>
          <g>
            {graph.nodes.map((item) => {
              const at = positions.get(item.id);
              if (!at) return null;
              const { x, y } = screen(at);
              const isSelected = item.id === focusId;
              const faded = lit !== null && !lit.has(item.id);
              return (
                <g key={item.id} transform={`translate(${x},${y})`} opacity={faded ? 0.45 : 1}>
                  <g role="button" tabIndex={0} data-concept-id={item.id} data-node-id={item.id} aria-pressed={isSelected}
                    aria-label={[`${item.name}, #${item.tag}`, item.personal ? "topic personnel" : "topic partagé", several ? `connu de ${agentList(item.agents.map(agent => agentName(agent.id)))}` : null, plural(item.publications, "publication source", "publications sources"), plural(degree.get(item.id) ?? 0, "relation affichée", "relations affichées"), item.hiddenNeighbours ? plural(item.hiddenNeighbours, "voisin non affiché", "voisins non affichés") : null].filter(Boolean).join(", ")}
                    onClick={() => selectNode(item.id)} onKeyDown={onNodeKey(item)} className="group/node cursor-pointer outline-none">
                    <title>{`${item.name} (#${item.tag})`}</title>
                    <circle r={RADIUS + 8} className="fill-none stroke-ring opacity-0 group-focus-visible/node:opacity-100" strokeWidth={3} />
                    {isSelected ? <circle r={RADIUS + 5} className="fill-chart-2/10 stroke-foreground" strokeWidth={2} /> : null}
                    <circle r={RADIUS} className="fill-chart-2 stroke-chart-2" fillOpacity={item.personal ? 0.35 : 0.9} strokeWidth={2} strokeDasharray={item.personal ? "4 3" : undefined} />
                    <text y={4} textAnchor="middle" className="fill-foreground text-[10px] font-bold" aria-hidden="true">{item.publications}</text>
                    {several && item.agents.length > 1 ? (
                      <g transform={`translate(${RADIUS - 1},${-RADIUS + 1})`} aria-hidden="true" data-shared-by={item.agents.length}>
                        <circle r={7} className="fill-background stroke-foreground" strokeWidth={1.5} />
                        <text y={3} textAnchor="middle" className="fill-foreground text-[9px] font-bold">{item.agents.length}</text>
                      </g>
                    ) : null}
                    <text x={RADIUS + 8} y={4} className={cn("fill-foreground stroke-background text-[12.5px]", isSelected ? "font-bold" : "font-medium")} strokeWidth={4} strokeLinejoin="round" style={{ paintOrder: "stroke" }}>
                      {truncate(item.name, 28)}{homonyms.has(item.name.toLowerCase()) ? ` · #${truncate(item.tag, 20)}` : ""}{item.hiddenNeighbours ? ` +${item.hiddenNeighbours}` : ""}
                    </text>
                  </g>
                </g>
              );
            })}
          </g>
        </svg>

        <div className="pointer-events-none absolute left-3 top-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-col items-start gap-2 sm:max-w-md">
          {pending ? (
            <p className="inline-flex items-center gap-2 rounded-full border bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow-sm">
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" />Chargement des connaissances…
            </p>
          ) : null}
          {graph.truncated ? (
            <p className="rounded-xl border border-amber-500/40 bg-background/95 px-3 py-1.5 text-xs shadow-sm">
              {graph.nodes.length} concepts affichés sur {graph.counts.concepts} : explorez un concept pour afficher ses voisins.
            </p>
          ) : null}
        </div>
        <p role="status" aria-live="polite" className="sr-only">{pending ? "Chargement des connaissances" : `${plural(graph.nodes.length, "concept affiché", "concepts affichés")}, ${plural(graph.edges.length, "relation", "relations")}`}</p>

        {empty && !pending ? <EmptyState graph={graph} /> : null}
        {empty ? null : <Legend several={several} />}

        {listOpen ? (
          <KnowledgeList graph={graph} byId={byId} agentName={agentName} onClose={() => setListOpen(false)}
            onNode={(id) => { setListOpen(false); selectNode(id, { moveFocus: true }); }}
            onEdge={(id) => { setListOpen(false); selectEdge(id, { moveFocus: true }); }} />
        ) : null}

        {node ? (
          <ConceptPanel ref={panelRef} node={node} graph={graph} byId={byId} agentName={agentName} provenance={provenance} open={request.open.includes(node.id)}
            onClose={() => setSelection(null)} onNode={(id) => selectNode(id, { moveFocus: true })} onEdge={(id) => selectEdge(id, { moveFocus: true })}
            onExplore={() => go({ open: [...request.open.filter(id => id !== node.id), node.id].slice(-KNOWLEDGE_LIMITS.open) })}
            onCollapse={() => go({ open: request.open.filter(id => id !== node.id) })} />
        ) : edge ? (
          <RelationPanel ref={panelRef} edge={edge} byId={byId} agentName={agentName} several={several} onClose={() => setSelection(null)} onNode={(id) => selectNode(id, { moveFocus: true })} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Which agents to show: one, several or all, each toggled on its own. The selection lives in the URL, like the rest of
 * the graph's state; at least one agent stays selected.
 */
function AgentPicker({ graph, onChange }: { graph: KnowledgeGraph; onChange: (change: Partial<KnowledgeRequest>) => void }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const selected = new Set(graph.selected.map(agent => agent.id));
  const all = graph.request.all || (graph.agents.length > 1 && selected.size === graph.agents.length);
  const summary = !graph.selected.length ? "ΞAgent introuvable" : graph.request.all ? `Tous les ΞAgents (${graph.agents.length})`
    : graph.selected.length === 1 ? graph.selected[0].name : `${graph.selected[0].name} +${graph.selected.length - 1}`;
  const toggle = (agent: KnowledgeAgent) => {
    const next = graph.agents.filter(item => item.id === agent.id ? !selected.has(item.id) : selected.has(item.id)).map(item => item.id);
    if (next.length) onChange({ agents: next, all: false });
  };
  const option = "flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 hover:bg-accent has-[:disabled]:cursor-default has-[:disabled]:opacity-70";
  return (
    <details ref={ref} className="group relative" onKeyDown={event => { if (event.key === "Escape" && ref.current?.open) { ref.current.open = false; ref.current.querySelector("summary")?.focus(); } }}>
      <summary aria-label={`ΞAgents affichés : ${agentList(graph.selected.map(agent => agent.name)) || "aucun"}`}
        className="inline-flex h-9 cursor-pointer list-none items-center gap-2 rounded-full border bg-background px-3 text-[13px] font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <Users aria-hidden="true" className="size-4" /><span className="max-w-[9rem] truncate sm:max-w-[14rem]">{summary}</span>
        <ChevronDown aria-hidden="true" className="size-4 transition-transform group-open:rotate-180" />
      </summary>
      <fieldset className="absolute left-0 top-full z-50 mt-1 w-72 max-w-[calc(100vw-1.5rem)] rounded-xl border bg-background p-2 text-sm shadow-lg">
        <legend className="sr-only">ΞAgents à afficher</legend>
        {graph.agents.length > 1 ? (
          <label className={cn(option, "font-semibold")}>
            <input type="checkbox" className="size-4" checked={all} onChange={() => onChange(all ? { agents: [graph.agents[0].id], all: false } : { agents: [], all: true })} />
            Tous les ΞAgents
          </label>
        ) : null}
        <div className="max-h-72 overflow-y-auto border-t pt-1">
          {graph.agents.map(agent => (
            <label key={agent.id} className={option}>
              <input type="checkbox" className="size-4" checked={selected.has(agent.id)} disabled={selected.has(agent.id) && selected.size === 1} onChange={() => toggle(agent)} />
              <span className="min-w-0 truncate">{agent.name}</span><span className="ml-auto truncate text-xs text-muted-foreground">@{agent.handle}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </details>
  );
}

function Legend({ several }: { several: boolean }) {
  const item = "flex items-center gap-2";
  return (
    <details className="absolute bottom-3 left-3 z-10 max-w-[calc(100%-1.5rem)] rounded-xl border bg-background/95 px-3 py-1.5 text-xs shadow-sm">
      <summary className="cursor-pointer py-1 font-semibold">Légende</summary>
      <ul className="space-y-1 pb-1">
        <li className={item}><span aria-hidden="true" className="size-3 rounded-full bg-chart-2" />Concept rattaché à un topic partagé</li>
        <li className={item}><span aria-hidden="true" className="size-3 rounded-full border-2 border-dashed border-chart-2 bg-chart-2/35" />Concept rattaché à un topic personnel</li>
        <li>Chiffre : publications {several ? "des ΞAgents affichés" : "de l’ΞAgent"} dont il est extrait</li>
        {several ? <li className={item}><span aria-hidden="true" className="inline-flex size-4 items-center justify-center rounded-full border border-foreground text-[9px] font-bold">2</span>Concept connu de plusieurs ΞAgents affichés</li> : null}
        <li>Texte d’une relation : les mots de la publication, orientés vers leur objet ; sinon sa nature</li>
        <li className={item}><span aria-hidden="true" className="w-5 border-t-2 border-chart-2" />Relation validée</li>
        <li className={item}><span aria-hidden="true" className="w-5 border-t-2 border-dashed border-amber-500" />Relation proposée, à examiner</li>
        <li className={item}><span aria-hidden="true" className="w-5 border-t-2 border-dotted border-muted-foreground" />Relation exclue ou masquée (sur demande)</li>
        <li>Flèche : relation orientée ; sans flèche : symétrique</li>
        <li>« +n » : voisins pas encore affichés</li>
      </ul>
    </details>
  );
}

function EmptyState({ graph }: { graph: KnowledgeGraph }) {
  const [title, text, link] = !graph.agents.length
    ? ["Aucun ΞAgent", "Créez un ΞAgent : Konstruktor analysera ses publications pour construire ses connaissances.", { href: "/dashboard/xiagents", label: "Voir les ΞAgents" }]
    : !graph.selected.length ? ["ΞAgent introuvable", "Cet ΞAgent n’existe pas ou ne vous appartient pas. Choisissez l’un des vôtres.", null]
      : ["Aucune connaissance", `Konstruktor n’a encore extrait aucun concept des publications de ${agentList(graph.selected.map(agent => agent.name))}. Lancez un pipeline de réindexation pour l’analyser.`, { href: `/dashboard/konstruktor/pipelines?agent=${graph.selected[0].id}`, label: "Ouvrir les pipelines" }];
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <div className="max-w-sm text-center">
        <p className="text-lg font-extrabold">{title}</p>
        <p className="mt-1 text-[15px] text-muted-foreground">{text}</p>
        {link ? <Link href={link.href} className="mt-3 inline-block text-sm font-semibold text-primary hover:underline">{link.label}</Link> : null}
      </div>
    </div>
  );
}

const panelClass = "absolute inset-x-0 bottom-0 z-30 flex max-h-[65%] flex-col rounded-t-2xl border-t bg-background shadow-lg outline-none sm:inset-x-auto sm:bottom-auto sm:right-3 sm:top-3 sm:max-h-[calc(100%-1.5rem)] sm:w-[380px] sm:rounded-2xl sm:border";
const action = "inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";
const linkButton = "rounded font-semibold hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";
const heading = "text-[13px] font-semibold text-muted-foreground";

function PanelHeader({ id, title, subtitle, onClose, label }: { id: string; title: string; subtitle: string; onClose: () => void; label: string }) {
  return (
    <header className="flex items-start gap-2 border-b px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <h2 id={id} className="truncate text-[15px] font-bold">{title}</h2>
        <p className="text-[13px] text-muted-foreground">{subtitle}</p>
      </div>
      <button type="button" onClick={onClose} aria-label={label} className="inline-flex size-9 items-center justify-center rounded-full hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <X aria-hidden="true" className="size-4" />
      </button>
    </header>
  );
}

function StatusBadge({ edge }: { edge: KnowledgeEdge }) {
  const status = edgeStatus(edge);
  return <span className={cn("ml-1.5 inline-block rounded-full border px-1.5 text-xs", status.tone)}>{status.label}</span>;
}

function ConceptPanel({ ref, node, graph, byId, agentName, provenance, open, onClose, onNode, onEdge, onExplore, onCollapse }: {
  ref: Ref<HTMLElement>; node: KnowledgeNode; graph: KnowledgeGraph; byId: Map<string, KnowledgeNode>; agentName: (id: string) => string;
  provenance: Record<string, ConceptProvenance | "error">; open: boolean;
  onClose: () => void; onNode: (id: string) => void; onEdge: (id: string) => void; onExplore: () => void; onCollapse: () => void;
}) {
  // Symmetric relations are stored in a normalized order: only oriented ones are outgoing or incoming.
  const outgoing = graph.edges.filter(edge => edge.directed && edge.source === node.id);
  const incoming = graph.edges.filter(edge => edge.directed && edge.target === node.id);
  const symmetric = graph.edges.filter(edge => !edge.directed && (edge.source === node.id || edge.target === node.id));
  const relationList = (edges: KnowledgeEdge[], side: "source" | "target" | "other") => edges.length ? (
    <ul className="mt-1 space-y-1.5">
      {edges.map(edge => {
        const other = byId.get(side !== "other" ? edge[side] : edge.source === node.id ? edge.target : edge.source)!;
        const labels = RELATION_TYPE_LABELS[edge.type];
        return (
          <li key={edge.id}>
            <button type="button" className={cn(linkButton, "font-normal text-muted-foreground")} onClick={() => onEdge(edge.id)}>{side === "source" ? labels.incoming : labels.outgoing}</button>{" "}
            <button type="button" className={linkButton} onClick={() => onNode(other.id)}>{other.name}</button>
            <StatusBadge edge={edge} />
          </li>
        );
      })}
    </ul>
  ) : <p className="mt-1 text-muted-foreground">Aucune parmi les concepts affichés.</p>;
  return (
    <aside ref={ref} tabIndex={-1} aria-labelledby="concept-panel-title" data-panel="concept" className={panelClass}>
      <PanelHeader id="concept-panel-title" title={node.name} subtitle={`#${node.tag} · ${node.personal ? "topic personnel, visible par vous seul" : "topic partagé du catalogue"}`} onClose={onClose} label="Fermer la fiche du concept" />
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm">
        <div className="flex flex-wrap gap-2">
          <Link href={topicHref(node.tag)} className={action}><ExternalLink aria-hidden="true" className="size-3.5" />Ouvrir la fiche du topic</Link>
          {open ? <button type="button" className={action} onClick={onCollapse}>Replier ses voisins</button>
            : node.hiddenNeighbours ? <button type="button" className={action} onClick={onExplore}>Explorer ses voisins ({node.hiddenNeighbours})</button> : null}
        </div>
        {node.description ? <p>{node.description}</p> : null}
        <section aria-labelledby="concept-out"><h3 id="concept-out" className={heading}>Relations sortantes ({outgoing.length})</h3>{relationList(outgoing, "target")}</section>
        <section aria-labelledby="concept-in"><h3 id="concept-in" className={heading}>Relations entrantes ({incoming.length})</h3>{relationList(incoming, "source")}</section>
        <section aria-labelledby="concept-sym"><h3 id="concept-sym" className={heading}>Relations symétriques ({symmetric.length})</h3>{relationList(symmetric, "other")}</section>
        {graph.selected.length > 1 ? <p data-known-by="">Connu de {agentList(node.agents.map(agent => agentName(agent.id)))}.</p> : null}
        {node.agents.map(({ id: agent, publications }) => {
          const data = provenance[`${agent}:${node.id}`];
          return (
            <section key={agent} aria-labelledby={`concept-sources-${agent}`} aria-busy={data === undefined} data-agent-provenance={agent}>
              <h3 id={`concept-sources-${agent}`} className={heading}>Extrait de {plural(publications, "publication", "publications")} de {agentName(agent)}</h3>
              {data === undefined ? <p className="mt-1 inline-flex items-center gap-2 text-muted-foreground"><Loader2 aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" />Chargement des publications…</p>
                : data === "error" ? <p role="alert" className="mt-1 text-destructive">Publications indisponibles.</p> : (
                  <ol className="mt-1 space-y-3">
                    {data.publications.map(item => (
                      <li key={item.id} data-provenance={item.id} className="rounded-lg border p-2.5">
                        <Link href={`/dashboard/publications/${item.id}`} className="font-semibold hover:underline">{truncate(item.title, 140)}</Link>
                        <p className="text-xs text-muted-foreground">{dateFr(item.publishedAt)} · {item.visibility === "public" ? "publique" : item.visibility === "private" ? "privée" : "abonnés"}</p>
                        {item.quotes.map((quote, index) => <blockquote key={index} className="mt-1.5 border-l-2 border-chart-2 pl-2 text-[13px]">« {quote} »</blockquote>)}
                        {item.sources.length ? (
                          <ul className="mt-1.5 space-y-0.5 text-xs">
                            {item.sources.map((source, index) => <li key={index}>
                              {source.url ? <a href={source.url} target="_blank" rel="noreferrer noopener" className="underline">{source.title}</a> : source.title}
                              {source.publisher ? <span className="text-muted-foreground"> · {source.publisher}</span> : null}
                            </li>)}
                          </ul>
                        ) : <p className="mt-1.5 text-xs text-muted-foreground">Aucune source web citée.</p>}
                      </li>
                    ))}
                  </ol>
                )}
              {data && data !== "error" && data.total > data.publications.length
                ? <p className="mt-1 text-xs text-muted-foreground">{data.publications.length} publications affichées sur {data.total}.</p> : null}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function RelationPanel({ ref, edge, byId, agentName, several, onClose, onNode }: {
  ref: Ref<HTMLElement>; edge: KnowledgeEdge; byId: Map<string, KnowledgeNode>; agentName: (id: string) => string; several: boolean; onClose: () => void; onNode: (id: string) => void;
}) {
  const source = byId.get(edge.source)!, target = byId.get(edge.target)!;
  const name = (id: string) => byId.get(id)?.name ?? "concept";
  const quote = (item: KnowledgeEvidence) => (
    <>
      {item.excerpt ? <blockquote className="border-l-2 border-chart-2 pl-2 text-[13px]">« {item.excerpt} »</blockquote> : null}
      {item.label ? <p className="text-xs text-muted-foreground">Lien dans le texte : {linkPhrase({ text: item.label, subject: item.subject }, edge, name)}</p> : null}
      <Link href={`/dashboard/publications/${item.publication}`} className="text-xs font-semibold text-primary hover:underline">Ouvrir la publication</Link>
    </>
  );
  return (
    <aside ref={ref} tabIndex={-1} aria-labelledby="relation-panel-title" data-panel="relation" className={panelClass}>
      <PanelHeader id="relation-panel-title" title={typeLabel(edge.type)} subtitle={edge.directed ? "Relation orientée" : "Relation symétrique"} onClose={onClose} label="Fermer la fiche de la relation" />
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm">
        <p className="text-[15px]">
          <button type="button" className={linkButton} onClick={() => onNode(source.id)}>{source.name}</button>
          <span className="mx-1.5 text-muted-foreground">{edge.directed ? "→" : "↔"} {RELATION_TYPE_LABELS[edge.type].outgoing.toLowerCase()} {edge.directed ? "→" : "↔"}</span>
          <button type="button" className={linkButton} onClick={() => onNode(target.id)}>{target.name}</button>
        </p>
        {edge.labels.length ? (
          <section aria-labelledby="relation-labels" data-labels="">
            <h3 id="relation-labels" className={heading}>Ce que dit le texte</h3>
            <ul className="mt-1 space-y-0.5">{edge.labels.map((link, index) => <li key={index}>{linkPhrase(link, edge, name)}</li>)}</ul>
          </section>
        ) : null}
        <p>Statut :<StatusBadge edge={edge} />{several ? <span className="block text-xs text-muted-foreground">Vos décisions valent pour tous vos ΞAgents qui la connaissent.</span> : null}</p>
        {edge.correction ? <p data-correction="">Type corrigé par vous le {dateFr(edge.correction.at)} : « {typeLabel(edge.correction.from)} » → « {typeLabel(edge.correction.to)} »{edge.correction.reason ? ` (${edge.correction.reason})` : ""}.</p> : null}
        {edge.decision ? <p>{edge.decision.action === "excluded" ? "Exclue" : edge.decision.action === "accepted" ? "Validée" : "Restaurée"} par vous le {dateFr(edge.decision.at)}{edge.decision.reason ? ` : ${edge.decision.reason}` : ""}.</p> : null}
        <p className="text-xs text-muted-foreground">
          {[origin(edge), `créée le ${dateFr(edge.createdAt)}`, edge.confidence !== null ? `confiance ${Math.round(edge.confidence * 100)} %` : null].filter(Boolean).join(" · ")}
        </p>
        <section aria-labelledby="relation-justification"><h3 id="relation-justification" className={heading}>Justification</h3><p className="mt-1">{edge.justification}</p></section>
        {edge.provenance.map(({ agent, evidence, count }) => (
          <section key={agent} aria-labelledby={`relation-evidence-${agent}`} data-agent-evidence={agent}>
            <h3 id={`relation-evidence-${agent}`} className={heading}>Preuves dans les publications de {agentName(agent)} ({count}){several ? <StatusBadge edge={edge} /> : null}</h3>
            <ul className="mt-1 space-y-2">{evidence.map((item, index) => <li key={index}>{quote(item)}</li>)}</ul>
            {count > evidence.length ? <p className="mt-1 text-xs text-muted-foreground">{evidence.length} preuves affichées sur {count}.</p> : null}
          </section>
        ))}
        <p className="text-xs text-muted-foreground">Valider, corriger ou exclure : sur la fiche du topic.</p>
      </div>
    </aside>
  );
}

function KnowledgeList({ graph, byId, agentName, onNode, onEdge, onClose }: {
  graph: KnowledgeGraph; byId: Map<string, KnowledgeNode>; agentName: (id: string) => string; onNode: (id: string) => void; onEdge: (id: string) => void; onClose: () => void;
}) {
  const several = graph.selected.length > 1;
  const name = (id: string) => byId.get(id)?.name ?? "concept";
  const nodes = [...graph.nodes].sort((a, b) => a.name.localeCompare(b.name, "fr"));
  const item = "w-full rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";
  return (
    <section aria-labelledby="knowledge-list-title" className="absolute inset-0 z-40 flex flex-col bg-background sm:inset-y-3 sm:left-3 sm:right-auto sm:w-[360px] sm:rounded-2xl sm:border sm:shadow-lg">
      <header className="flex items-center gap-2 border-b px-4 py-2.5">
        <h2 id="knowledge-list-title" className="flex-1 text-[15px] font-bold">Liste des connaissances</h2>
        <button type="button" onClick={onClose} aria-label="Fermer la liste" className="inline-flex size-9 items-center justify-center rounded-full hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"><X aria-hidden="true" className="size-4" /></button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 text-sm">
        <h3 className="px-2 py-1 text-[13px] font-semibold text-muted-foreground">{plural(nodes.length, "concept affiché", "concepts affichés")}</h3>
        <ul>{nodes.map(node => <li key={node.id}><button type="button" className={item} onClick={() => onNode(node.id)}>
          <span className="font-medium">{node.name}</span> <span className="text-muted-foreground">#{node.tag}</span>
          <span className="block text-xs text-muted-foreground">{[node.personal ? "topic personnel" : "topic partagé", several ? agentList(node.agents.map(agent => agentName(agent.id))) : null, plural(node.publications, "publication"), node.hiddenNeighbours ? plural(node.hiddenNeighbours, "voisin non affiché", "voisins non affichés") : null].filter(Boolean).join(" · ")}</span>
        </button></li>)}</ul>
        <h3 className="mt-3 px-2 py-1 text-[13px] font-semibold text-muted-foreground">{plural(graph.edges.length, "relation")}</h3>
        {graph.edges.length ? <ul>{graph.edges.map(edge => <li key={edge.id}><button type="button" className={item} onClick={() => onEdge(edge.id)}>
          <span className="font-medium">{byId.get(edge.source)?.name}</span> <span className="text-muted-foreground">{RELATION_TYPE_LABELS[edge.type].outgoing.toLowerCase()}</span> <span className="font-medium">{byId.get(edge.target)?.name}</span>
          {edge.labels.length ? <span className="block text-[13px]">{edge.labels.map(link => linkPhrase(link, edge, name)).join(" ; ")}</span> : null}
          <span className="block text-xs text-muted-foreground">{[edgeStatus(edge).label, edge.correction ? "type corrigé" : null, several ? agentList(edge.provenance.map(item => agentName(item.agent))) : null].filter(Boolean).join(" · ")}</span>
        </button></li>)}</ul> : <p className="px-2 py-1 text-muted-foreground">Aucune relation entre les concepts affichés.</p>}
      </div>
    </section>
  );
}
