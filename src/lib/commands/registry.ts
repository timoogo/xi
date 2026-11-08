import { createCommandRegistry } from "@cmdly/core";
import { publicationsOverHttp } from "@/lib/publications/commands/client";
import { publicationCommands, type PublicationCommandRuntime } from "@/lib/publications/commands";
import { agentsOverHttp } from "@/lib/xiagents/commands/client";
import { xiAgentCommands, type XiAgentCommandRuntime } from "@/lib/xiagents/commands";
import type { NavigationRuntime } from "./types";

/**
 * Composition only: each module owns its commands and declares the runtime it needs; the root
 * mounts them under a namespace (ids become `publications.find`, `xiagents.find`…) and its runtime
 * type is the union of their needs. No command is defined here.
 */
export type XiCommandRuntime = PublicationCommandRuntime & XiAgentCommandRuntime;

export const xiCommands = createCommandRegistry<undefined, XiCommandRuntime>({ shared: undefined, runtimeRequired: true });
xiCommands.mount("publications", publicationCommands);
xiCommands.mount("xiagents", xiAgentCommands);

/** The browser runtime: the host's navigation plus each module's HTTP services. */
export const createXiCommandRuntime = (navigation: NavigationRuntime): XiCommandRuntime =>
  ({ ...navigation, publications: publicationsOverHttp, agents: agentsOverHttp });
