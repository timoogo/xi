"use client";

import Link from "next/link";
import { useId, useRef } from "react";
import type { XiAgentSummary } from "@/lib/xiagents/summary";
import { widgetAgents } from "./select";
import { useXiAgents } from "./use-xiagents";
import { XiAgentWidgetItem } from "./xiagent-widget-item";

/**
 * ΞAgents widget: the viewer's agents with their live activity, pinned agents first.
 * Self-contained (fetches, refreshes and pins through /api/xiagents), so it can sit in
 * any panel. `initial` is the server-rendered list, or null to load it on mount.
 */
export function XiAgentsWidget({ initial, className = "" }: { initial: XiAgentSummary[] | null; className?: string }) {
  const root = useRef<HTMLElement>(null);
  const titleId = useId();
  const { agents, error, pending, togglePin } = useXiAgents(initial, root);
  return <section ref={root} aria-labelledby={titleId} data-widget="xiagents" className={`rounded-2xl border px-4 py-3 ${className}`}>
    <h2 id={titleId} className="text-xl font-extrabold">ΞAgents</h2>
    {agents === null ? <p className="mt-1 text-[15px] text-muted-foreground">Chargement des ΞAgents…</p>
      : !agents.length ? <p className="mt-1 text-[15px] leading-snug text-muted-foreground">Vous n’avez encore aucun ΞAgent.</p>
      : <ul className="-mx-2 mt-1">{widgetAgents(agents).map(agent => <XiAgentWidgetItem key={agent.id} agent={agent} pending={pending.has(agent.id)} onTogglePin={togglePin} />)}</ul>}
    {error && <p role="status" className="mt-1 text-sm text-destructive">{error}</p>}
    <Link href="/dashboard/xiagents" className="mt-1 inline-block py-1 text-[15px] text-primary hover:underline">{agents?.length === 0 ? "Créer un ΞAgent" : "Voir tous"}</Link>
  </section>;
}
