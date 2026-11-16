import type { XiAgentCommand } from ".";

/**
 * Opens the existing generator of the chosen agent's page (`#publication-generator` expands its
 * section): drafting, review and publication stay there, with their own checks.
 */
export const createPublicationForAgent = {
  id: "create-publication",
  tags: ["creation"],
  label: "Créer une publication pour un ΞAgent",
  steps: [{
    id: "agent",
    label: "Pour quel ΞAgent ?",
    // Only editorial agents publish, and the API lists only the viewer's own.
    options: async (_answers, { runtime }) => (await runtime.agents.list("editorial"))
      .map(agent => ({ value: agent.id, label: `${agent.name} · @${agent.handle}` })),
  }],
  run: ({ agent }, { runtime }) => runtime.navigate(`/dashboard/xiagents/${encodeURIComponent(agent)}#publication-generator`),
} satisfies XiAgentCommand;
