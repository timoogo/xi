"use client";

import { BloubBot, type GazeScript } from "bloub-react";
import { useRef, type ComponentProps } from "react";
import { bloubFrame } from "@/lib/bloub/state-mapping";
import type { BloubActivity, BloubConfig } from "@/lib/bloub/types";
import { useLiveMotion } from "./use-motion";

/** Eyes are holes in the body showing `paper`: white paper gives white eyes. */
export const BLOUB_EYES = "#ffffff";
/**
 * bloub-react draws a 316-unit viewBox around a 100-unit body to leave room for
 * its orbit effects. Avatars show no such effect, so the SVG is enlarged and
 * cropped to a 250-unit frame, keeping the body at 80 % of the avatar.
 */
const CROP = 158 / 125;

/**
 * Lightweight avatar: a still frame (no animation loop) unless the activity is
 * animated, the avatar is visible and motion is allowed. Server rendering and
 * hydration always use the still frame.
 *
 * A companion avatar may pass its own `gaze` (where the eyes look, the engine keeps the blinks,
 * drift and breathing) and `animate` to want live playback (or not) whatever the activity.
 * A `gaze` must keep its identity across renders: a new one restarts the script.
 */
export function BloubAvatar({ config, activity = "idle", size = 40, label, gaze, animate, className = "", ...rest }: Omit<ComponentProps<"span">, "children" | "ref"> & {
  config: BloubConfig; activity?: BloubActivity; size?: number; label: string; gaze?: GazeScript; animate?: boolean;
}) {
  const wrapper = useRef<HTMLSpanElement>(null);
  const { frozenAt, animated, ...frame } = bloubFrame(config, activity);
  if (gaze) frame.gaze = gaze;
  const live = useLiveMotion(wrapper, animate ?? animated);
  const svg = Math.round(size * CROP);
  return <span {...rest} ref={wrapper} data-bloub data-activity={activity} data-animating={live} className={`relative inline-block shrink-0 overflow-hidden rounded-full bg-[#e7e9ea] ${className}`} style={{ width: size, height: size }}>
    {/* The library keeps one clock per mount: remounting on mode change keeps still frames exact. */}
    <BloubBot key={live ? "live" : "still"} {...frame} frozenAt={live ? undefined : frozenAt} size={svg} paper={BLOUB_EYES} aria-label={label}
      style={{ position: "absolute", left: (size - svg) / 2, top: (size - svg) / 2, maxWidth: "none" }} />
  </span>;
}
