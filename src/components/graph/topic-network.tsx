"use client";

import { ExternalLink, List, Loader2, Maximize2, Minus, Plus, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type KeyboardEvent, type Ref } from "react";
import { Button } from "@/components/ui/button";
import { toggleTopicKnowledge } from "@/lib/apis/topics";
import type { Viewport } from "@/lib/graph/local-state";
import { topicHref } from "@/lib/search/query";
import {
  LAYER_LABELS, NETWORK_LAYERS, NETWORK_LIMITS, RELATION_TYPE_LABELS, networkHref,
  type NetworkLayer, type NetworkNode, type NetworkRequest, type TopicNetwork,
} from "@/lib/topics/network";
import type { NetworkEdge } from "@/lib/topics/relations";
import { cn } from "@/lib/utils";
import { plural, truncate } from "./model";
import { createSimulation, nearestIn, syncTopicLayout, type Direction, type Point } from "./topic-network-layout";
import { clampZoom, usePanZoom, zoomAt } from "./use-pan-zoom";

const RADIUS = 15;
const ARROWS: Record<string, Direction> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
const noDrag = () => {};

/** Relation as read from `from`: type label, provenance and status, never a justification (those stay on the topic page). */
export function edgeLabel(edge: NetworkEdge, from: string) {
  if (edge.type === "parent") return edge.source === from ? "Spécialise" : "Englobe";
  const labels = RELATION_TYPE_LABELS[edge.type];
  return edge.source === from ? labels.outgoing : labels.incoming;
}
export function edgeProvenance(edge: NetworkEdge) {
  const origin = edge.origin === "hierarchy" ? "Tag hiérarchique" : edge.origin === "declared" ? "Déclarée dans la fiche du topic"
    : edge.origin === "agent" ? "Proposée par un ΞAgent" : edge.origin === "inference" ? "Inférence locale" : edge.byViewer ? "Ajoutée par vous" : "Ajoutée par un membre";
  return [
    origin, edge.status === "proposed" ? "proposée, non validée" : "validée", edge.scope === "personal" ? "personnelle" : null,
    edge.confidence !== null ? `confiance ${Math.round(edge.confidence * 100)} %` : null,
  ].filter(Boolean).join(" · ");
}
const edgeClass = (edge: NetworkEdge) => edge.status === "proposed" ? "stroke-amber-500" : edge.kind === "hierarchy" ? "stroke-foreground/35"
  : edge.type === "opposes" ? "stroke-destructive" : "stroke-chart-2";

function nodeAriaLabel(node: NetworkNode, layers: ReadonlySet<NetworkLayer>, degree: number) {
  return [
    `${node.name}, #${node.tag}`, node.personal ? "topic personnel" : null,
    layers.has("knowledge") && node.known ? "dans mes connaissances" : null,
    layers.has("interests") && node.interest ? "centre d’intérêt" : null,
    layers.has("experts") && node.experts.length ? plural(node.experts.length, "ΞAgent expert", "ΞAgents experts") : null,
    plural(degree, "relation affichée", "relations affichées"),
    node.hiddenNeighbours ? plural(node.hiddenNeighbours, "voisin non affiché", "voisins non affichés") : null,
  ].filter(Boolean).join(", ");
}

/** "Réseau Topics" mode: topics as nodes, relations as edges, three superposable layers, progressive exploration. */
export function TopicNetworkView({ network, className }: { network: TopicNetwork; className?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const { request } = network;
  const layers = useMemo(() => new Set(request.layers), [request.layers]);
  const href = networkHref(request);
  const go = useCallback((change: Partial<NetworkRequest>) => {
    startTransition(() => router.push(networkHref({ ...request, ...change }), { scroll: false }));
  }, [request, router]);

  const byId = useMemo(() => new Map(network.nodes.map(node => [node.id, node])), [network.nodes]);
  const degree = useMemo(() => {
    const count = new Map<string, number>();
    for (const edge of network.edges) for (const id of [edge.source, edge.target]) count.set(id, (count.get(id) ?? 0) + 1);
    return count;
  }, [network.edges]);

  // Stable layout: kept across explorations (same component instance), settled synchronously.
  const [sim] = useState(createSimulation);
  const positions = useMemo(() => {
    syncTopicLayout(sim, network.nodes.map(node => node.id), network.edges);
    return new Map<string, Point>([...sim.nodes].map(([id, node]) => [id, { x: node.x, y: node.y }]));
  }, [sim, network.nodes, network.edges]);

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
  // Framed once the first layout and size are known; afterwards the view only moves on request.
  const framed = useRef(false);
  useEffect(() => {
    if (framed.current || !size.width || !positions.size) return;
    framed.current = true;
    fit();
  }, [fit, size.width, positions.size]);

  const [selected, setSelected] = useState<string | null>(request.focus);
  const current = selected && byId.has(selected) ? byId.get(selected)! : null;
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

  const select = useCallback((id: string, { moveFocus = false } = {}) => {
    setSelected(id);
    centerOn(id);
    if (moveFocus) setPanelFocus((n) => n + 1);
  }, [centerOn]);

  const onNodeKey = (node: NetworkNode) => (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select(node.id);
      return;
    }
    const direction = ARROWS[event.key];
    if (!direction) return;
    event.preventDefault();
    const from = positions.get(node.id);
    const next = from && nearestIn(from, direction, [...positions].filter(([id]) => id !== node.id));
    if (!next) return;
    centerOn(next);
    svgRef.current?.querySelector<SVGGElement>(`[data-topic-id="${next}"]`)?.focus();
  };

  const explore = (id: string) => go({ open: [...request.open.filter(other => other !== id), id].slice(-NETWORK_LIMITS.open) });
  const collapse = (id: string) => go({ open: request.open.filter(other => other !== id) });
  const toggleLayer = (layer: NetworkLayer) => go({ layers: layers.has(layer) ? request.layers.filter(other => other !== layer) : [...request.layers, layer] });

  const highlighted = current?.id ?? null;
  const chip = "h-9 rounded-full px-3 text-[13px]";
  const empty = !network.nodes.length;

  return (
    <div className={cn("relative flex min-h-0 flex-col", className)} data-topic-network="">
      <div role="toolbar" aria-label="Outils du réseau des topics" className="flex flex-wrap items-center gap-1.5 border-b bg-background/90 px-3 py-2 backdrop-blur-md sm:px-4">
        <div role="group" aria-label="Couches affichées" className="flex flex-wrap gap-1.5">
          {NETWORK_LAYERS.map((layer) => (
            <Button key={layer} variant="outline" size="sm" aria-pressed={layers.has(layer)} onClick={() => toggleLayer(layer)}
              className={cn(chip, layers.has(layer) && "border-chart-2/70 bg-chart-2/10 text-foreground")}>
              <LayerMark layer={layer} />{LAYER_LABELS[layer]}<span className="tabular-nums text-muted-foreground">{network.counts[layer]}</span>
            </Button>
          ))}
        </div>
        <Button variant="outline" size="sm" aria-pressed={request.proposed} onClick={() => go({ proposed: !request.proposed })}
          className={cn(chip, request.proposed && "border-amber-500/70 bg-amber-500/10")} title="Relations proposées, pas encore validées">
          <span aria-hidden="true" className="h-0 w-4 border-t-2 border-dashed border-amber-500" />Propositions
          {!request.proposed ? <span className="tabular-nums text-muted-foreground">{network.proposals}</span> : null}
        </Button>
        {request.focus ? <Button variant="ghost" size="sm" className={chip} onClick={() => go({ focus: null })}>Retirer le topic ciblé</Button> : null}
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon" className="size-9 rounded-full" aria-label="Zoom avant" title="Zoom avant" onClick={() => setViewport(zoomAt(view, 1.25, { x: size.width / 2, y: size.height / 2 }))}><Plus aria-hidden="true" /></Button>
          <Button variant="ghost" size="icon" className="size-9 rounded-full" aria-label="Zoom arrière" title="Zoom arrière" onClick={() => setViewport(zoomAt(view, 0.8, { x: size.width / 2, y: size.height / 2 }))}><Minus aria-hidden="true" /></Button>
          <Button variant="ghost" size="icon" className="size-9 rounded-full" aria-label="Recentrer le réseau" title="Recentrer le réseau" onClick={fit}><Maximize2 aria-hidden="true" /></Button>
          <Button variant={listOpen ? "secondary" : "ghost"} size="sm" className={chip} aria-pressed={listOpen} onClick={() => setListOpen((open) => !open)} title="Liste textuelle des topics et des relations">
            <List aria-hidden="true" /><span className="hidden min-[420px]:inline">Liste</span>
          </Button>
        </div>
      </div>

      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden bg-[radial-gradient(circle,var(--border)_1px,transparent_1px)] [background-size:24px_24px]">
        <svg ref={svgRef} width={size.width} height={size.height} role="group" className="block touch-none select-none" style={{ cursor: "grab" }}
          aria-label={`Réseau des topics : ${plural(network.nodes.length, "topic")}, ${plural(network.edges.length, "relation")}. Tab ou les flèches pour parcourir les topics, Entrée pour sélectionner.`}>
          <g aria-hidden="true">
            {network.edges.map((edge) => {
              const a = positions.get(edge.source), b = positions.get(edge.target);
              if (!a || !b) return null;
              const from = screen(a), to = screen(b);
              const touches = highlighted === edge.source || highlighted === edge.target;
              return <line key={edge.id} data-edge-id={edge.id} data-status={edge.status} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className={edgeClass(edge)} strokeLinecap="round"
                strokeWidth={edge.kind === "hierarchy" ? 1.5 : 2.5} strokeDasharray={edge.status === "proposed" ? "6 5" : edge.kind === "declared" ? "1 0" : undefined}
                strokeOpacity={touches ? 0.95 : highlighted ? 0.25 : 0.7} />;
            })}
          </g>
          <g>
            {network.nodes.map((node) => {
              const at = positions.get(node.id);
              if (!at) return null;
              const { x, y } = screen(at);
              const isSelected = node.id === current?.id;
              const known = layers.has("knowledge") && node.known;
              const interest = layers.has("interests") && node.interest;
              const experts = layers.has("experts") ? node.experts.length : 0;
              return (
                <g key={node.id} transform={`translate(${x},${y})`}>
                  <g role="button" tabIndex={0} data-topic-id={node.id} data-node-id={node.id} aria-label={nodeAriaLabel(node, layers, degree.get(node.id) ?? 0)}
                    aria-pressed={isSelected} onClick={() => select(node.id)} onKeyDown={onNodeKey(node)} className="group/node cursor-pointer outline-none">
                    <title>{`${node.name} (#${node.tag})`}</title>
                    <circle r={RADIUS + 8} className="fill-none stroke-ring opacity-0 group-focus-visible/node:opacity-100" strokeWidth={3} />
                    {isSelected ? <circle r={RADIUS + 5} className="fill-chart-2/10 stroke-foreground" strokeWidth={2} /> : null}
                    {interest ? <circle r={RADIUS + 3.5} className="fill-none stroke-chart-4" strokeWidth={2.5} /> : null}
                    <circle r={RADIUS} className={known ? "fill-chart-2 stroke-chart-2" : "fill-background stroke-foreground/70"} strokeWidth={2} strokeDasharray={node.personal ? "4 3" : undefined} />
                    {node.origin === "focus" ? <circle r={4} className="fill-foreground" /> : null}
                    {experts ? (
                      <g transform={`translate(${RADIUS * 0.8},${-RADIUS * 0.8})`}>
                        <rect x={-2} y={-8} width={experts > 9 ? 26 : 20} height={16} rx={8} className="fill-chart-3 stroke-background" strokeWidth={1.5} />
                        <text x={experts > 9 ? 11 : 8} y={4} textAnchor="middle" className="fill-background text-[10px] font-bold">Ξ{experts}</text>
                      </g>
                    ) : null}
                    <text x={RADIUS + 9} y={4} className={cn("fill-foreground stroke-background text-[12.5px]", isSelected ? "font-bold" : "font-medium")} strokeWidth={4} strokeLinejoin="round" style={{ paintOrder: "stroke" }}>
                      {truncate(node.name, 30)}{node.hiddenNeighbours ? ` +${node.hiddenNeighbours}` : ""}
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
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" />Chargement du réseau…
            </p>
          ) : null}
          {network.truncated ? (
            <p className="rounded-xl border border-amber-500/40 bg-background/95 px-3 py-1.5 text-xs shadow-sm">
              Affichage limité ({NETWORK_LIMITS.seeds} topics de départ, {NETWORK_LIMITS.neighbours} voisins par exploration) : explorez un topic pour en voir davantage.
            </p>
          ) : null}
        </div>
        <p role="status" aria-live="polite" className="sr-only">{pending ? "Chargement du réseau" : `${plural(network.nodes.length, "topic affiché", "topics affichés")}, ${plural(network.edges.length, "relation", "relations")}`}</p>

        {empty && !pending ? <EmptyState request={request} counts={network.counts} /> : null}
        {empty ? null : <Legend layers={layers} />}

        {listOpen ? (
          <NetworkList network={network} byId={byId} selected={current?.id ?? null} onClose={() => setListOpen(false)}
            onSelect={(id) => { setListOpen(false); select(id, { moveFocus: true }); }} />
        ) : null}

        {current ? (
          <TopicPanel ref={panelRef} node={current} network={network} byId={byId} layers={layers} back={href}
            onClose={() => setSelected(null)} onSelect={(id) => select(id, { moveFocus: true })}
            onExplore={() => explore(current.id)} onCollapse={() => collapse(current.id)} />
        ) : null}
      </div>
    </div>
  );
}

function LayerMark({ layer }: { layer: NetworkLayer }) {
  if (layer === "knowledge") return <span aria-hidden="true" className="size-3 rounded-full bg-chart-2" />;
  if (layer === "interests") return <span aria-hidden="true" className="size-3 rounded-full border-2 border-chart-4" />;
  return <span aria-hidden="true" className="rounded-full bg-chart-3 px-1 text-[9px] font-bold leading-3 text-background">Ξ</span>;
}

function Legend({ layers }: { layers: ReadonlySet<NetworkLayer> }) {
  const item = "flex items-center gap-2";
  return (
    <details className="absolute bottom-3 left-3 z-10 max-w-[calc(100%-1.5rem)] rounded-xl border bg-background/95 px-3 py-1.5 text-xs shadow-sm">
      <summary className="cursor-pointer py-1 font-semibold">Légende</summary>
      <ul className="space-y-1 pb-1">
        {layers.has("knowledge") ? <li className={item}><LayerMark layer="knowledge" />Topic de mes connaissances</li> : null}
        {layers.has("interests") ? <li className={item}><LayerMark layer="interests" />Centre d’intérêt (abonnement)</li> : null}
        {layers.has("experts") ? <li className={item}><LayerMark layer="experts" />ΞAgents experts (spécialité déclarée ou publications)</li> : null}
        <li className={item}><span aria-hidden="true" className="size-3 rounded-full border-2 border-dashed border-foreground/70" />Topic personnel</li>
        <li className={item}><span aria-hidden="true" className="w-5 border-t-2 border-foreground/35" />Hiérarchie</li>
        <li className={item}><span aria-hidden="true" className="w-5 border-t-2 border-chart-2" />Relation validée</li>
        <li className={item}><span aria-hidden="true" className="w-5 border-t-2 border-destructive" />Opposition validée</li>
        <li className={item}><span aria-hidden="true" className="w-5 border-t-2 border-dashed border-amber-500" />Relation proposée</li>
        <li>« +n » : voisins pas encore affichés</li>
      </ul>
    </details>
  );
}

function EmptyState({ request, counts }: { request: NetworkRequest; counts: Record<NetworkLayer, number> }) {
  const none = !request.layers.length;
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <div className="max-w-sm text-center">
        <p className="text-lg font-extrabold">{none ? "Aucune couche active" : "Aucun topic à afficher"}</p>
        <p className="mt-1 text-[15px] text-muted-foreground">
          {none ? "Activez « Mes connaissances », « Mes centres d’intérêt » ou « ΞAgents experts » pour afficher leurs topics."
            : request.layers.every((layer) => !counts[layer])
              ? "Vos couches actives sont vides : déclarez une connaissance ou abonnez-vous depuis la fiche d’un topic. Lire ou rechercher un topic ne l’ajoute pas à vos connaissances."
              : "Aucun des topics de ces couches ne vous est accessible."}
        </p>
        <Link href="/dashboard/topics" className="mt-3 inline-block text-sm font-semibold text-primary hover:underline">Parcourir les topics</Link>
      </div>
    </div>
  );
}

function TopicPanel({ ref, node, network, byId, layers, back, onClose, onSelect, onExplore, onCollapse }: {
  ref: Ref<HTMLElement>;
  node: NetworkNode;
  network: TopicNetwork;
  byId: Map<string, NetworkNode>;
  layers: ReadonlySet<NetworkLayer>;
  back: string;
  onClose: () => void;
  onSelect: (id: string) => void;
  onExplore: () => void;
  onCollapse: () => void;
}) {
  const relations = network.edges.filter((edge) => edge.source === node.id || edge.target === node.id);
  const open = network.request.open.includes(node.id);
  const action = "inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";
  return (
    <aside ref={ref} tabIndex={-1} aria-labelledby="topic-panel-title"
      className="absolute inset-x-0 bottom-0 z-30 flex max-h-[65%] flex-col rounded-t-2xl border-t bg-background shadow-lg outline-none sm:inset-x-auto sm:bottom-auto sm:right-3 sm:top-3 sm:max-h-[calc(100%-1.5rem)] sm:w-[360px] sm:rounded-2xl sm:border">
      <header className="flex items-start gap-2 border-b px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <h2 id="topic-panel-title" className="truncate text-[15px] font-bold">{node.name}</h2>
          <p className="text-[13px] text-muted-foreground">#{node.tag}{node.personal ? " · topic personnel, visible par vous seul" : ""}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Fermer la fiche du topic" className="inline-flex size-9 items-center justify-center rounded-full hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <X aria-hidden="true" className="size-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm">
        <div className="flex flex-wrap gap-2">
          <Link href={topicHref(node.tag)} className={action}><ExternalLink aria-hidden="true" className="size-3.5" />Ouvrir la fiche</Link>
          {open ? <button type="button" className={action} onClick={onCollapse}>Replier ses voisins</button>
            : node.hiddenNeighbours ? <button type="button" className={action} onClick={onExplore}>Explorer ses voisins ({node.hiddenNeighbours})</button>
              : <span className="inline-flex min-h-9 items-center text-[13px] text-muted-foreground">Tous ses voisins sont affichés</span>}
        </div>
        <section aria-label="Couches" className="space-y-1.5">
          <form action={toggleTopicKnowledge} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="topicId" value={node.id} />
            <input type="hidden" name="known" value={node.known ? "0" : "1"} />
            <input type="hidden" name="back" value={back} />
            <span className="flex-1">{node.known ? "Dans mes connaissances" : "Pas dans mes connaissances"}</span>
            <button type="submit" aria-pressed={node.known} className={action}>{node.known ? "Retirer de mes connaissances" : "Ajouter à mes connaissances"}</button>
          </form>
          <p>{node.interest ? "Centre d’intérêt : vous êtes abonné à ce topic." : "Vous n’êtes pas abonné à ce topic."}</p>
          {!layers.has("knowledge") || !layers.has("interests") ? <p className="text-xs text-muted-foreground">Certaines couches sont masquées : leurs repères n’apparaissent pas sur le réseau.</p> : null}
        </section>
        <section aria-labelledby="topic-panel-experts">
          <h3 id="topic-panel-experts" className="text-[13px] font-semibold text-muted-foreground">ΞAgents experts</h3>
          {node.experts.length ? (
            <ul className="mt-1 space-y-1">
              {node.experts.map((expert) => (
                <li key={expert.id}>
                  <span className="font-medium">{expert.name}</span> <span className="text-muted-foreground">@{expert.handle}</span>
                  <span className="block text-xs text-muted-foreground">
                    {[expert.role ? `spécialité déclarée (${expert.role})` : "aucune spécialité déclarée",
                      expert.contributions ? plural(expert.contributions, "publication accessible", "publications accessibles") : "aucune publication accessible"].join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          ) : <p className="mt-1 text-muted-foreground">Aucun ΞAgent accessible ne couvre ce topic.</p>}
        </section>
        <section aria-labelledby="topic-panel-relations">
          <h3 id="topic-panel-relations" className="text-[13px] font-semibold text-muted-foreground">{plural(relations.length, "relation affichée", "relations affichées")}</h3>
          {relations.length ? (
            <ul className="mt-1 space-y-1.5">
              {relations.map((edge) => {
                const other = byId.get(edge.source === node.id ? edge.target : edge.source)!;
                return (
                  <li key={edge.id}>
                    <span className="text-muted-foreground">{edgeLabel(edge, node.id)}</span>{" "}
                    <button type="button" onClick={() => onSelect(other.id)} className="rounded font-semibold hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">{other.name}</button>
                    {edge.status === "proposed" ? <span className="ml-1.5 rounded-full border border-amber-500/60 px-1.5 text-xs">proposée</span> : null}
                    <span className="block text-xs text-muted-foreground">{edgeProvenance(edge)}</span>
                  </li>
                );
              })}
            </ul>
          ) : <p className="mt-1 text-muted-foreground">Aucune relation avec les topics affichés.</p>}
          <p className="mt-2 text-xs text-muted-foreground">Justifications, preuves et corrections : sur la fiche du topic.</p>
        </section>
      </div>
    </aside>
  );
}

function NetworkList({ network, byId, selected, onSelect, onClose }: {
  network: TopicNetwork;
  byId: Map<string, NetworkNode>;
  selected: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const nodes = [...network.nodes].sort((a, b) => a.name.localeCompare(b.name, "fr"));
  const item = "w-full rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";
  return (
    <section aria-labelledby="network-list-title" className="absolute inset-0 z-40 flex flex-col bg-background sm:inset-y-3 sm:left-3 sm:right-auto sm:w-[360px] sm:rounded-2xl sm:border sm:shadow-lg">
      <header className="flex items-center gap-2 border-b px-4 py-2.5">
        <h2 id="network-list-title" className="flex-1 text-[15px] font-bold">Liste du réseau</h2>
        <button type="button" onClick={onClose} aria-label="Fermer la liste" className="inline-flex size-9 items-center justify-center rounded-full hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <X aria-hidden="true" className="size-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 text-sm">
        <h3 className="px-2 py-1 text-[13px] font-semibold text-muted-foreground">{plural(nodes.length, "topic affiché", "topics affichés")}</h3>
        <ul>
          {nodes.map((node) => (
            <li key={node.id}>
              <button type="button" className={item} aria-current={node.id === selected ? "true" : undefined} onClick={() => onSelect(node.id)}>
                <span className="font-medium">{node.name}</span> <span className="text-muted-foreground">#{node.tag}</span>
                <span className="block text-xs text-muted-foreground">
                  {[node.personal ? "personnel" : null, node.known ? "connaissance" : null, node.interest ? "centre d’intérêt" : null,
                    node.experts.length ? plural(node.experts.length, "ΞAgent expert", "ΞAgents experts") : null,
                    node.hiddenNeighbours ? plural(node.hiddenNeighbours, "voisin non affiché", "voisins non affichés") : null].filter(Boolean).join(" · ") || "voisin exploré"}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <h3 className="mt-3 px-2 py-1 text-[13px] font-semibold text-muted-foreground">{plural(network.edges.length, "relation", "relations")}</h3>
        {network.edges.length ? (
          <ul>
            {network.edges.map((edge) => (
              <li key={edge.id} className="px-2 py-1">
                <button type="button" className="font-medium hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" onClick={() => onSelect(edge.source)}>{byId.get(edge.source)?.name}</button>
                {" "}<span className="text-muted-foreground">{edgeLabel(edge, edge.source).toLowerCase()}</span>{" "}
                <button type="button" className="font-medium hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" onClick={() => onSelect(edge.target)}>{byId.get(edge.target)?.name}</button>
                <span className="block text-xs text-muted-foreground">{edgeProvenance(edge)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="px-2 py-1 text-muted-foreground">Aucune relation entre les topics affichés.</p>}
      </div>
    </section>
  );
}
