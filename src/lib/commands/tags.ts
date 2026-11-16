import type { TagDefinition } from "@cmdly/core";

export const commandTags = {
  test: { label: "Test" },
  global: { label: "Global" },
  debug: { label: "Debug" },
  search: { label: "Recherche", variant: "soft" },
  navigation: { label: "Navigation", variant: "soft" },
  creation: { label: "Création", variant: "soft" },
  destructive: { label: "Destructif", variant: "outline", className: "text-destructive" },
} satisfies Record<string, TagDefinition>;

export type CommandTag = keyof typeof commandTags;
