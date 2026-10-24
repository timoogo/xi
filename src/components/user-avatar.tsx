"use client";

import Image from "next/image";
import { useState } from "react";
import { BloubAvatar } from "./bloub/bloub-avatar";
import { bloubFromSeed } from "@/lib/bloub/presets";
import type { XiAgentBloub } from "@/lib/xiagents/avatar";

/**
 * Shared identity avatar (profiles, publications, conversations, graph, lists):
 * ΞAgent Bloub, human Bloub (seed), photo, then the default Bloub. An identity is
 * always shown neutral (`idle`): a ΞAgent's real activity is not a profile picture.
 */
export function UserAvatar({ image, name, size = 56, bloubSeed, bloub }: { ai?: boolean; bloubSeed?: string | null; bloub?: XiAgentBloub | null; image?: string | null; name: string; size?: number }) {
  const [failedImage, setFailedImage] = useState<string>();
  const safeImage = image && (/^https:\/\//i.test(image) || /^\/(?!\/)/.test(image));
  if (bloub) return <BloubAvatar config={bloub.config} size={size} label={`Avatar Bloub de ${name}`} />;
  if (bloubSeed) return <BloubAvatar config={bloubFromSeed(bloubSeed)} data-seed={bloubSeed} size={size} label={`Avatar Bloub de ${name}`} />;
  if (safeImage && failedImage !== image) {
    return <Image src={image} alt={`${name}'s avatar`} width={size} height={size} unoptimized referrerPolicy="no-referrer" onError={() => setFailedImage(image)} className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />;
  }
  return <BloubAvatar config={bloubFromSeed(null)} size={size} label={`Avatar Bloub de ${name}`} />;
}
