import type { XiAgentSummary } from "@/lib/xiagents/summary";

export const XIAGENTS_WIDGET_LIMIT = 5;
const names = new Intl.Collator("fr", { sensitivity: "base" });
const byId = (a: XiAgentSummary, b: XiAgentSummary) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Every pinned agent first (oldest pin first), whatever its activity and even past
 * the limit, then unpinned agents by name until the limit. Ties break on id, so the
 * order is deterministic.
 */
export function widgetAgents(agents: XiAgentSummary[], limit = XIAGENTS_WIDGET_LIMIT) {
  const pinned = agents.filter(agent => agent.pinnedAt !== null).sort((a, b) => a.pinnedAt! - b.pinnedAt! || byId(a, b));
  const others = agents.filter(agent => agent.pinnedAt === null).sort((a, b) => names.compare(a.name, b.name) || byId(a, b));
  return [...pinned, ...others.slice(0, Math.max(0, limit - pinned.length))];
}
