import type { XiAgentSummary } from "../summary";
import type { XiAgentCommandRuntime } from ".";

/** Browser implementation over the existing `/api/xiagents` route: the server decides what the viewer may see. */
export const agentsOverHttp: XiAgentCommandRuntime["agents"] = {
  async scan(id) {
    const response = await fetch(`/api/xiagents/${encodeURIComponent(id)}/control`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "run", task: "watch" }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Veille indisponible.");
    return data;
  },
  async list(category) {
    const response = await fetch(`/api/xiagents?category=${category}`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(data.agents)) throw new Error(typeof data.error === "string" ? data.error : "ΞAgents indisponibles. Réessayez.");
    return (data.agents as XiAgentSummary[]).filter(agent => typeof agent?.id === "string" && typeof agent.handle === "string");
  },
};

export const topicsOverHttp: XiAgentCommandRuntime["topics"] = {
  async list() {
    const response = await fetch("/api/commands/topics", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(data.topics)) throw new Error(typeof data.error === "string" ? data.error : "Topics indisponibles.");
    return data.topics;
  },
};
