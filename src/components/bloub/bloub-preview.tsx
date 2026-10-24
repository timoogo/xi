"use client";

import { BloubBot, POSES, type Block } from "bloub-react";
import { forwardRef } from "react";
import { bloubFrame } from "@/lib/bloub/state-mapping";
import type { BloubActivity, BloubConfig } from "@/lib/bloub/types";
import { BLOUB_EYES } from "./bloub-avatar";
import { useReducedMotion } from "./use-motion";

export type BloubSequence = { blocks: Block[]; block: number; playing: boolean };

/**
 * Real-time editor preview, uncropped so demo effects stay visible. Shows either
 * an activity (as avatars render it) or a demo sequence. With reduced motion it
 * falls back to still frames of the selected activity or block.
 */
export const BloubPreview = forwardRef<HTMLDivElement, {
  config: BloubConfig; activity: BloubActivity; sequence: BloubSequence | null; follow: boolean; size?: number; label: string;
  onBlockChange?: (block: number) => void;
}>(function BloubPreview({ config, activity, sequence, follow, size = 240, label, onBlockChange }, ref) {
  const reduced = useReducedMotion();
  const { frozenAt, animated, ...frame } = bloubFrame(config, activity);
  const current = sequence?.blocks[sequence.block];
  // Demo cycles never override what an activity looks like: they only run in their own mode.
  // Pointer follow needs open, unscripted eyes: never while sleeping or working.
  const follows = follow && !reduced && (activity === "idle" || activity === "unavailable");
  const props = sequence && current
    ? { ...frame, gaze: null, state: current.state, cycle: sequence.blocks, block: sequence.block, playing: sequence.playing && !reduced, onBlockChange, frozenAt: reduced ? POSES[current.state] : undefined, follow: follow && !reduced }
    : { ...frame, frozenAt: (animated && !reduced) || follows ? undefined : frozenAt, follow: follows };
  const live = props.frozenAt === undefined;
  // A still frame is exact only on a fresh engine clock, hence one mount per still pose.
  const key = live ? `${sequence ? "sequence" : activity}-live` : `still-${props.state}-${sequence ? "" : activity}`;
  return <div ref={ref} data-bloub-preview data-animating={live} className="inline-flex rounded-2xl border bg-[#e7e9ea]">
    <BloubBot key={key} {...props} size={size} paper={BLOUB_EYES} aria-label={label} />
  </div>;
});
