"use client";

import { BloubAvatar } from "@/components/bloub/bloub-avatar";
import { DEFAULT_BLOUB_CONFIG } from "@/lib/bloub/config";
import { cn } from "@/lib/utils";

/**
 * Floating entry point of the command palette, with Ξ's default Bloub. It only calls `onOpen`:
 * the host owns the palette and its position (to stay clear of its other fixed elements).
 * The Bloub stays still unless motion is allowed (BloubAvatar); the hover lift is disabled with
 * reduced motion.
 */
export function CommandBubble({ onOpen, size = 48, className }: { onOpen: () => void; size?: number; className?: string }) {
  return (
    <button type="button" onClick={onOpen} aria-label="Ouvrir la palette de commandes" title="Commandes (Ctrl+K)" aria-keyshortcuts="Control+K Meta+K"
      className={cn("fixed z-40 rounded-full bg-background p-0.5 shadow-lg ring-1 ring-border outline-none transition-[transform,box-shadow] duration-150",
        "hover:-translate-y-0.5 hover:shadow-xl focus-visible:ring-[3px] focus-visible:ring-ring motion-reduce:transition-none motion-reduce:hover:translate-y-0", className)}>
      <BloubAvatar config={DEFAULT_BLOUB_CONFIG} size={size} label="" aria-hidden="true" className="block" />
    </button>
  );
}
