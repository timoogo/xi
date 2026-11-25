import type { XiAgentCommand } from ".";

export const addAgent = {
  id: "add",
  label: "Ajouter un bot",
  tags: ["creation"],
  run: (_answers, { runtime }) => runtime.navigate("/dashboard/xiagents?create=agent"),
} satisfies XiAgentCommand;

const agentFromPath = (pathname: string) => /^\/dashboard\/xiagents\/([0-9a-f-]{36})\/?$/i.exec(pathname)?.[1];

export const requestScan = {
  id: "scan",
  label: "Demander un scan",
  steps: [{
    id: "agent",
    label: "Quel ΞAgent doit lancer une veille ?",
    when: (_answers, { runtime }) => !agentFromPath(runtime.pathname),
    options: async (_answers, { runtime }) => (await runtime.agents.list("editorial"))
      .map(agent => ({ value: agent.id, label: `${agent.name} · @${agent.handle}` })),
  }],
  run: async ({ agent }, { runtime }) => {
    agent = agent || agentFromPath(runtime.pathname) || "";
    const result = await runtime.agents.scan(agent);
    runtime.notice(result.planned ? `Veille demandée : ${result.planned} collecte(s) planifiée(s) pour le prochain passage du worker.` : "Aucune source à collecter pour cet ΞAgent.", `/dashboard/xiagents/${encodeURIComponent(agent)}/runs/${encodeURIComponent(result.runId)}`);
  },
} satisfies XiAgentCommand;

export const findTopic = {
  id: "find-topic",
  label: "Se renseigner sur un topic",
  tags: ["search"],
  steps: [{
    id: "topic",
    label: "Rechercher un topic",
    options: async (_answers, { runtime }) => (await runtime.topics.list())
      .map(topic => ({ value: topic.id, label: `${topic.name} · #${topic.tag} (${topic.personal ? "personnel" : "partagé"})` })),
  }],
  run: ({ topic }, { runtime }) => runtime.navigate(`/dashboard/topics/by-id?topicId=${encodeURIComponent(topic)}`),
} satisfies XiAgentCommand;
