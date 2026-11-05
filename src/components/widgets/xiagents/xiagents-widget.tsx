"use client";

import Link from "next/link";
import { useId, useRef, useState } from "react";
import { XiAgentCategorySelect } from "@/components/xiagents/category-select";
import { xiAgentsHref, type XiAgentCategory, type XiAgentSummary } from "@/lib/xiagents/summary";
import { widgetAgents } from "./select";
import { useXiAgents } from "./use-xiagents";
import { XiAgentWidgetItem } from "./xiagent-widget-item";

const EMPTY: Record<XiAgentCategory, string> = { editorial: "Vous n’avez encore aucun ΞAgent.", system: "Aucun agent système disponible." };

/**
 * ΞAgents widget: editorial or system agents with their live activity, pinned agents first.
 * Self-contained (fetches, refreshes and pins through /api/xiagents), so it can sit in any panel.
 * `initial` / `initialSystem` are the server-rendered lists, or null to load them when shown.
 * The selected category is kept while navigating (the panel stays mounted), carried by « Voir tous »
 * and, with `preferenceCookie` (read by the server into `initialCategory`), across reloads.
 */
export function XiAgentsWidget({ initial, initialSystem = null, initialCategory = "editorial", preferenceCookie, className = "" }: {
  initial: XiAgentSummary[] | null; initialSystem?: XiAgentSummary[] | null; initialCategory?: XiAgentCategory; preferenceCookie?: string; className?: string;
}) {
  const root = useRef<HTMLElement>(null);
  const titleId = useId();
  const [category, setCategory] = useState(initialCategory);
  const select = (next: XiAgentCategory) => {
    setCategory(next);
    if (preferenceCookie) document.cookie = `${preferenceCookie}=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
  };
  const { agents, error, pending, togglePin } = useXiAgents({ editorial: initial, system: initialSystem }, category, root);
  return <section ref={root} aria-labelledby={titleId} data-widget="xiagents" data-category={category} className={`rounded-2xl border px-4 py-3 ${className}`}>
    <div className="flex items-center justify-between gap-2">
      <h2 id={titleId} className="text-xl font-extrabold">ΞAgents</h2>
      <XiAgentCategorySelect value={category} onValueChange={select} size="sm" />
    </div>
    {agents === null ? <p className="mt-1 text-[15px] text-muted-foreground">Chargement des ΞAgents…</p>
      : !agents.length ? <p className="mt-1 text-[15px] leading-snug text-muted-foreground">{EMPTY[category]}</p>
      : <ul className="-mx-2 mt-1">{widgetAgents(agents).map(agent => <XiAgentWidgetItem key={agent.id} agent={agent} pending={pending.has(agent.id)} onTogglePin={togglePin} />)}</ul>}
    {error && <p role="status" className="mt-1 text-sm text-destructive">{error}</p>}
    <Link href={xiAgentsHref(category)} className="mt-1 inline-block py-1 text-[15px] text-primary hover:underline">{category === "editorial" && agents?.length === 0 ? "Créer un ΞAgent" : "Voir tous"}</Link>
  </section>;
}
