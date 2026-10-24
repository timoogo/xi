import type { XiAgentBloub } from "./avatar";

/**
 * One of the viewer's own ΞAgents as listed outside its page (widgets, panels):
 * identity, real activity and the viewer's pin (pin time in ms, null when unpinned).
 */
export type XiAgentSummary = { id: string; name: string; handle: string; bloub: XiAgentBloub; pinnedAt: number | null };
