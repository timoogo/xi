import type { BloubConfig } from "../bloub/types";

/**
 * System ΞAgents: specialised agents, each a singleton of the instance (never owned by a user,
 * never a generator: they do not appear in the feed or the graph). This registry is the only place
 * that declares them; adding one means adding an entry here, then its behaviour in later modules.
 *
 * - `id`: fixed UUID, the same on every instance and across restarts;
 * - `handle`: reserved, refused to editorial ΞAgents (accounts/store.ts);
 * - `capabilities`: what the agent does, as shown to users;
 * - `permissions`: the closed list of operations its code may perform. A system agent never writes
 *   an editorial ΞAgent or a Topic itself: changes it proposes are applied by the user, through the
 *   existing stores and their checks.
 */
export const SYSTEM_AGENT_PERMISSIONS = {
  "read-owner-context": "Lire la configuration des ΞAgents et des Topics de l’utilisateur qui le sollicite.",
  "propose-changes": "Proposer des modifications, jamais appliquées sans validation.",
  "read-candidate-evidence": "Lire les éléments sourcés d’une actualité qui lui est soumise.",
  "decide-priority": "Décider si une actualité mérite une publication prioritaire, sans contourner les contrôles de publication.",
} as const;
export type SystemAgentPermission = keyof typeof SYSTEM_AGENT_PERMISSIONS;

export type SystemAgentDefinition = {
  kind: string; id: string; handle: string; name: string; description: string;
  capabilities: readonly string[]; permissions: readonly SystemAgentPermission[]; bloub: BloubConfig;
};

export const SYSTEM_AGENTS = [
  {
    kind: "konstruktor", id: "5b0c1a2e-6f43-4d6a-9b1e-3c7d2a8f4e10", handle: "konstruktor", name: "Konstruktor",
    description: "Crée, configure et modifie les ΞAgents et les Topics en conversation, avec validation avant toute application.",
    capabilities: ["Conversation de configuration", "Aperçu interactif", "Suggestions proactives"],
    permissions: ["read-owner-context", "propose-changes"],
    bloub: { version: 1, shape: "hexagone", expression: "attentif", color: "bleu" },
  },
  {
    kind: "priority-arbiter", id: "9e4f7c31-2b8d-4a05-8c6e-d1f0a9b3e527", handle: "arbitre", name: "Arbitre prioritaire",
    description: "Décide, sur sollicitation d’un ΞAgent éditorial, si une actualité potentiellement majeure mérite une publication prioritaire.",
    capabilities: ["Arbitrage des publications prioritaires", "Décisions justifiées et auditables"],
    permissions: ["read-candidate-evidence", "decide-priority"],
    bloub: { version: 1, shape: "triangle", expression: "neutre", color: "ambre" },
  },
] as const satisfies readonly SystemAgentDefinition[];

export type SystemAgentKind = (typeof SYSTEM_AGENTS)[number]["kind"];
export const SYSTEM_AGENT_KINDS = SYSTEM_AGENTS.map(agent => agent.kind) as SystemAgentKind[];

export const systemAgentDefinition = (kind: string): SystemAgentDefinition | null => SYSTEM_AGENTS.find(agent => agent.kind === kind) ?? null;
export const hasPermission = (kind: SystemAgentKind, permission: SystemAgentPermission) =>
  (systemAgentDefinition(kind)?.permissions as readonly string[] | undefined)?.includes(permission) ?? false;

const RESERVED_HANDLES: ReadonlySet<string> = new Set(SYSTEM_AGENTS.map(agent => agent.handle));
/** Handles of system agents, never available to editorial ΞAgents (compared without "@", lowercase). */
export const isReservedHandle = (handle: string) => RESERVED_HANDLES.has(handle.trim().replace(/^@/, "").toLowerCase());
