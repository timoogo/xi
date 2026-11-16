import { createCommandRegistry, type ContextualCommand } from "@cmdly/core";
import { commandTags, type CommandTag } from "@/lib/commands/tags";
import type { NavigationRuntime } from "@/lib/commands/types";
import type { PublicationSnapshot } from "../types";
import { findPublication } from "./find-publication";
import { goToPublications } from "./go-to-publications";

/** "own": the viewer's drafts and publications; "feed": the first page of the home feed. */
export type PublicationListScope = "own" | "feed";

/** Everything the publication commands need, supplied by the host when a workflow starts. */
export type PublicationCommandRuntime = NavigationRuntime & {
  publications: { list: (scope: PublicationListScope) => Promise<PublicationSnapshot[]> };
};

export type PublicationCommand = ContextualCommand<undefined, PublicationCommandRuntime, CommandTag>;

export const publicationCommands = createCommandRegistry<undefined, PublicationCommandRuntime, CommandTag>({ shared: undefined, runtimeRequired: true, tags: commandTags });
publicationCommands.registerMany([goToPublications, findPublication]);
