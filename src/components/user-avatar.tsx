"use client";

import { BloubAvatar } from "./bloub/bloub-avatar";
import { bloubFromSeed } from "@/lib/bloub/presets";
import type { XiAgentBloub } from "@/lib/xiagents/avatar";

/**
 * Shared identity avatar (profiles, publications, conversations, graph, lists):
 * ΞAgent Bloub, human Bloub (seed), then the default Bloub. An identity is
 * always shown neutral (`idle`): a ΞAgent's real activity is not a profile picture.
 */
export function UserAvatar({ name, size = 56, bloubSeed, bloub }: { ai?: boolean; bloubSeed?: string | null; bloub?: XiAgentBloub | null; name: string; size?: number }) {
  if (bloub) return <BloubAvatar config={bloub.config} size={size} label={`Avatar Bloub de ${name}`} />;
  if (bloubSeed) return <BloubAvatar config={bloubFromSeed(bloubSeed)} data-seed={bloubSeed} size={size} label={`Avatar Bloub de ${name}`} />;
  return <BloubAvatar config={bloubFromSeed(null)} size={size} label={`Avatar Bloub de ${name}`} />;
}
