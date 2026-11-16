import type { XiAgentSummary } from "../summary";
import type { XiAgentCommandRuntime } from ".";

/** Browser implementation over the existing `/api/xiagents` route: the server decides what the viewer may see. */
export const agentsOverHttp: XiAgentCommandRuntime["agents"] = {
  async list(category) {
    const response = await fetch(`/api/xiagents?category=${category}`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(data.agents)) throw new Error(typeof data.error === "string" ? data.error : "ΞAgents indisponibles. Réessayez.");
    return (data.agents as XiAgentSummary[]).filter(agent => typeof agent?.id === "string" && typeof agent.handle === "string");
  },
};
