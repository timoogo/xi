import type { XiAgentCommand } from ".";
import { XIAGENT_CATEGORIES, xiAgentHref } from "../summary";

export const findAgent = {
  id: "find",
  tags: ["search"],
  label: "Rechercher un ΞAgent",
  steps: [{
    id: "agent",
    label: "ΞAgent",
    // The option value is the agent's page: editorial agents have their own, system agents a card of their list.
    options: async (_answers, { runtime }) => (await Promise.all(XIAGENT_CATEGORIES.map(category => runtime.agents.list(category)))).flat()
      .map(agent => ({ value: xiAgentHref(agent), label: `${agent.name} · @${agent.handle}${agent.category === "system" ? " (système)" : ""}` })),
  }],
  run: ({ agent }, { runtime }) => runtime.navigate(agent),
} satisfies XiAgentCommand;
