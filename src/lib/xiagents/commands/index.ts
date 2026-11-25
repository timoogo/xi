import { createCommandRegistry, type ContextualCommand } from "@cmdly/core";
import { commandTags, type CommandTag } from "@/lib/commands/tags";
import type { NavigationRuntime } from "@/lib/commands/types";
import type { XiAgentCategory, XiAgentSummary } from "../summary";
import { createPublicationForAgent } from "./create-publication";
import { addAgent, findTopic, requestScan } from "./poc";
import { findAgent } from "./find-agent";

/** Everything the ΞAgent commands need, supplied by the host when a workflow starts. */
export type XiAgentCommandRuntime = NavigationRuntime & {
  /** The ΞAgents of a category the viewer may see (editorial: the viewer's own). */
  agents: { list: (category: XiAgentCategory) => Promise<XiAgentSummary[]>; scan: (id: string) => Promise<{ runId: string; planned: number }> };
  topics: { list: () => Promise<{ id: string; name: string; tag: string; personal: boolean }[]> };
  notice: (message: string, href: string) => void;
};

export type XiAgentCommand = ContextualCommand<undefined, XiAgentCommandRuntime, CommandTag>;

export const xiAgentCommands = createCommandRegistry<undefined, XiAgentCommandRuntime, CommandTag>({ shared: undefined, runtimeRequired: true, tags: commandTags });
xiAgentCommands.registerMany([findAgent, createPublicationForAgent, addAgent, requestScan, findTopic]);
