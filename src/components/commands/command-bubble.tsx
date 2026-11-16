"use client";

import { BloubAvatar } from "@/components/bloub/bloub-avatar";
import { useCompanion } from "@/components/bloub/use-companion";
import { CMDLY_BLOUB_CONFIG } from "@/lib/bloub/config";
import { MOOD_EXPRESSION } from "@/lib/bloub/companion";
import { cn } from "@/lib/utils";

/** The bubble sits on the right of the page: at rest, the Bloub looks left, towards the content. */
const REST_YAW = -22;

/**
 * Floating entry point of the command palette, with a living Bloub. It only calls `onOpen`, right
 * away: the host owns the palette and its position (to stay clear of its other fixed elements).
 * The Bloub's life (gaze, moods, blinks) comes from `useCompanion` and bloub-react; with reduced
 * motion it is a still frame and the hover lift is disabled.
 */
export function CommandBubble({ onOpen, size = 48, className }: { onOpen: () => void; size?: number; className?: string }) {
  const { mood, gaze, handlers, press } = useCompanion(REST_YAW);
  const config = { ...CMDLY_BLOUB_CONFIG, expression: MOOD_EXPRESSION[mood] ?? CMDLY_BLOUB_CONFIG.expression };
  return (
    <button type="button" onClick={() => { onOpen(); press(); }} {...handlers} data-mood={mood}
      aria-label="Ouvrir la palette de commandes" title="Commandes (Ctrl+K)" aria-keyshortcuts="Control+K Meta+K"
      className={cn("fixed z-40 rounded-full bg-background p-0.5 shadow-lg ring-1 ring-border outline-none transition-[transform,box-shadow] duration-150",
        "hover:-translate-y-0.5 hover:shadow-xl focus-visible:ring-[3px] focus-visible:ring-ring motion-reduce:transition-none motion-reduce:hover:translate-y-0", className)}>
      <BloubAvatar config={config} gaze={gaze} animate={mood !== "dormant"} size={size} label="" aria-hidden="true" className="block" />
    </button>
  );
}
