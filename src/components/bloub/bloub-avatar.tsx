"use client";

import { BloubBot } from "bloub-react";
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
 */
export function BloubAvatar({ config, activity = "idle", size = 40, label, className = "", ...rest }: Omit<ComponentProps<"span">, "children" | "ref"> & {
  config: BloubConfig; activity?: BloubActivity; size?: number; label: string;
}) {
  const wrapper = useRef<HTMLSpanElement>(null);
  const { frozenAt, animated, ...frame } = bloubFrame(config, activity);
  const live = useLiveMotion(wrapper, animated);
  const svg = Math.round(size * CROP);
  return <span {...rest} ref={wrapper} data-bloub data-activity={activity} data-animating={live} className={`relative inline-block shrink-0 overflow-hidden rounded-full bg-[#e7e9ea] ${className}`} style={{ width: size, height: size }}>
    {/* The library keeps one clock per mount: remounting on mode change keeps still frames exact. */}
    <BloubBot key={live ? "live" : "still"} {...frame} frozenAt={live ? undefined : frozenAt} size={svg} paper={BLOUB_EYES} aria-label={label}
      style={{ position: "absolute", left: (size - svg) / 2, top: (size - svg) / 2, maxWidth: "none" }} />
  </span>;
}
