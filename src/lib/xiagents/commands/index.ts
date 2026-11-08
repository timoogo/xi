import { createCommandRegistry, type ContextualCommand } from "@cmdly/core";
import type { NavigationRuntime } from "@/lib/commands/types";
import type { XiAgentCategory, XiAgentSummary } from "../summary";
import { createPublicationForAgent } from "./create-publication";
import { findAgent } from "./find-agent";

/** Everything the ΞAgent commands need, supplied by the host when a workflow starts. */
export type XiAgentCommandRuntime = NavigationRuntime & {
  /** The ΞAgents of a category the viewer may see (editorial: the viewer's own). */
  agents: { list: (category: XiAgentCategory) => Promise<XiAgentSummary[]> };
};

export type XiAgentCommand = ContextualCommand<undefined, XiAgentCommandRuntime>;

export const xiAgentCommands = createCommandRegistry<undefined, XiAgentCommandRuntime>({ shared: undefined, runtimeRequired: true });
xiAgentCommands.registerMany([findAgent, createPublicationForAgent]);
