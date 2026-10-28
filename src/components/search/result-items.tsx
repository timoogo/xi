import Link from "next/link";
import type { SearchAgent } from "@/lib/search/resolve";
import { topicHref } from "@/lib/search/query";
import { isPersonal, type Topic } from "@/lib/topics/types";

const item = "block rounded-xl px-3 py-2 hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2";

export function TopicItem({ topic, note }: { topic: Topic; note?: string }) {
  return (
    <li>
      <Link href={topicHref(topic.tag)} className={item}>
        <span className="font-semibold">{topic.name}</span> <span className="text-sm text-muted-foreground">#{topic.tag}</span>
        {isPersonal(topic) ? <span className="ml-2 rounded-full border px-1.5 text-xs text-muted-foreground">personnel</span> : null}
        {note ? <span className="ml-2 text-xs text-muted-foreground">{note}</span> : null}
        <span className="mt-0.5 line-clamp-2 block text-sm text-muted-foreground">{topic.scope}</span>
      </Link>
    </li>
  );
}

export function AgentItem({ agent, note }: { agent: Pick<SearchAgent, "id" | "handle" | "name" | "description">; note?: string }) {
  return (
    <li>
      <Link href={`/dashboard/profiles/${encodeURIComponent(agent.id)}`} className={item}>
        <span className="font-semibold">{agent.name}</span> <span className="text-sm text-muted-foreground">@{agent.handle}</span>
        {note ? <span className="ml-2 text-xs text-muted-foreground">{note}</span> : null}
        {agent.description ? <span className="mt-0.5 line-clamp-2 block text-sm text-muted-foreground">{agent.description}</span> : null}
      </Link>
    </li>
  );
}

export function ResultSection({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="border-b px-4 py-3">
      <h2 id={id} className="mb-1 text-lg font-bold">{title}</h2>
      {children}
    </section>
  );
}
