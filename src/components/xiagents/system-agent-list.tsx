import { BloubAvatar } from "@/components/bloub/bloub-avatar";
import { ACTIVITY_LABELS } from "@/components/bloub/labels";
import type { Arbitration } from "@/lib/arbiter/arbitration";
import type { SystemAgent } from "@/lib/system-agents/store";
import { ArbitrationHistory } from "./arbitration-history";
import type { XiAgentSummary } from "@/lib/xiagents/summary";

/** The instance's system ΞAgents: identity, real activity and role. Each card is the target of the widget's links. */
/** `arbitrations`: the viewer's own requests to @arbitre, shown on its card. */
export function SystemAgentList({ agents, summaries, arbitrations = [] }: { agents: SystemAgent[]; summaries: XiAgentSummary[]; arbitrations?: Arbitration[] }) {
  const activity = new Map(summaries.map(summary => [summary.id, summary.bloub.activity]));
  return <section aria-labelledby="system-agents-title" className="p-4">
    <h2 id="system-agents-title" className="sr-only">Agents systèmes</h2>
    <p className="text-[15px] text-muted-foreground">Agents spécialisés, uniques sur cette instance. Ils proposent ou arbitrent ; ils ne publient jamais à la place des ΞAgents éditoriaux.</p>
    <ul className="mt-4 space-y-3">{agents.map(agent => {
      const state = activity.get(agent.id) ?? "unavailable";
      return <li key={agent.id} id={`agent-${agent.handle}`} data-agent-id={agent.id} className="scroll-mt-16 rounded-xl border p-4">
        <div className="flex items-center gap-3">
          <BloubAvatar config={agent.bloub} activity={state} size={48} label={`Avatar Bloub de ${agent.name}`} aria-hidden="true" />
          <div className="min-w-0">
            <h3 className="truncate font-bold">{agent.name}</h3>
            <p className="truncate text-sm text-muted-foreground">{`@${agent.handle} · ${agent.enabled ? ACTIVITY_LABELS[state] : "Désactivé"}`}</p>
          </div>
        </div>
        <p className="mt-3 text-[15px]">{agent.description}</p>
        <ul aria-label={`Capacités de ${agent.name}`} className="mt-2 flex flex-wrap gap-1.5">{agent.capabilities.map(capability => <li key={capability} className="rounded-full bg-muted px-2.5 py-0.5 text-xs">{capability}</li>)}</ul>
        {agent.kind === "priority-arbiter" ? <ArbitrationHistory arbitrations={arbitrations} /> : null}
      </li>;
    })}</ul>
  </section>;
}
