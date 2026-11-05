"use client";

import { Pin } from "lucide-react";
import Link from "next/link";
import { BloubAvatar } from "@/components/bloub/bloub-avatar";
import { ACTIVITY_LABELS } from "@/components/bloub/labels";
import { xiAgentHref, type XiAgentSummary } from "@/lib/xiagents/summary";

/** One agent: real activity (unlike identity avatars), link to its page (or its card for a system agent), pin toggle. */
export function XiAgentWidgetItem({ agent, pending, onTogglePin }: { agent: XiAgentSummary; pending: boolean; onTogglePin: (agent: XiAgentSummary) => void }) {
  const pinned = agent.pinnedAt !== null;
  const { config, activity } = agent.bloub;
  return <li className="flex items-center gap-1" data-agent-id={agent.id} data-pinned={pinned}>
    <Link href={xiAgentHref(agent)} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-2 hover:bg-muted/60">
      <BloubAvatar config={config} activity={activity} size={40} label={`Avatar Bloub de ${agent.name}`} aria-hidden="true" />
      <span className="min-w-0">
        <span className="block truncate text-[15px] font-bold">{agent.name}</span>
        <span className="block truncate text-sm text-muted-foreground">{ACTIVITY_LABELS[activity]}</span>
      </span>
    </Link>
    <button type="button" aria-pressed={pinned} aria-label={`Épingler ${agent.name}`} title={pinned ? "Désépingler" : "Épingler"} disabled={pending} onClick={() => onTogglePin(agent)}
      className={`grid size-9 shrink-0 place-items-center rounded-full hover:bg-muted disabled:opacity-50 ${pinned ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
      <Pin aria-hidden="true" className={`size-[18px] ${pinned ? "fill-current" : ""}`} />
    </button>
  </li>;
}
