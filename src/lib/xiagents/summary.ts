import type { XiAgentBloub } from "./avatar";

/** Editorial: the viewer's own thematic agents. System: singletons of the instance (system-agents/registry.ts). */
export type XiAgentCategory = "editorial" | "system";
/**
 * A ΞAgent as listed outside its page (widgets, panels): one of the viewer's own editorial agents,
 * or a system agent; identity, real activity and the viewer's pin (pin time in ms, null when unpinned).
 */
export type XiAgentSummary = { id: string; name: string; handle: string; category: XiAgentCategory; bloub: XiAgentBloub; pinnedAt: number | null };

export const XIAGENT_CATEGORIES = ["editorial", "system"] as const satisfies readonly XiAgentCategory[];
export const XIAGENT_CATEGORY_LABELS: Record<XiAgentCategory, string> = { editorial: "Agents éditoriaux", system: "Agents systèmes" };
/** `?category=` value: absent means editorial (the historical list); anything else unknown is null. */
export const parseCategory = (value: string | null | undefined): XiAgentCategory | null =>
  value === undefined || value === null || value === "" ? "editorial" : (XIAGENT_CATEGORIES as readonly string[]).includes(value) ? value as XiAgentCategory : null;
/** The full list of a category; editorial keeps the historical URL. */
export const xiAgentsHref = (category: XiAgentCategory) => category === "system" ? "/dashboard/xiagents?category=system" : "/dashboard/xiagents";
/** An editorial agent has its own page; a system agent is a card of the system list. */
export const xiAgentHref = (agent: Pick<XiAgentSummary, "id" | "handle" | "category">) =>
  agent.category === "system" ? `${xiAgentsHref("system")}#agent-${agent.handle}` : `/dashboard/xiagents/${agent.id}`;
/**
 * Cookie keeping the widget's category across reloads, one per user: an account never inherits
 * another's choice on a shared browser, and nothing is stored as an instance-wide preference.
 */
export const widgetCategoryCookie = (userId: string) => `xi-xiagents-category-${userId.replace(/[^A-Za-z0-9_-]/g, "")}`;
