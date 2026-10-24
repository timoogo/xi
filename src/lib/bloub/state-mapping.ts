import { POSES, type BloubBotProps, type GazeScript } from "bloub-react";
import type { BloubActivity, BloubConfig } from "./types";

/**
 * Activity → bloub-react props. The library has no "closed eyes" or "busy eyes"
 * states, so both are built here from public props only:
 *
 * - closed eyes: a still frame inside the engine's first scheduled blink (at
 *   1.4 s, 0.18 s long, closing over its first 45 %), taken when the lid is at
 *   14 % rather than fully shut: a fully squashed eye is a sub-pixel sliver that
 *   the mask erases. Paired with the wide, front-facing, untilted `surpris` eyes,
 *   this gives two flat horizontal lids (≈ the 0.45 × 0.09 closed eye of the
 *   library's `wink`). The face is fixed: universal states are not customisable.
 *   The library version is pinned and tests/bloub-avatar.test.tsx checks this frame.
 * - busy eyes: a scripted `gaze` that steps between three points, left to right,
 *   like a three-dot loading indicator. The body and eyes keep their colours.
 *
 * Every activity keeps the `idle` engine state so the chosen shape and
 * expression stay applied (`baseBody` / `baseFace`). The activity always wins
 * over any demo cycle: none is passed here.
 */
export const OPEN_EYES_AT = POSES.idle;
const CLOSED_LID = 0.14;
export const CLOSED_EYES_AT = 1.4 + 0.18 * 0.45 * (1 - CLOSED_LID);
export const CLOSED_EYES_EXPRESSION = "surpris";
export const UNAVAILABLE_SHAPE = "triangle";

const DOT_YAWS = [-16, 0, 16];
const DOT_STEP = 0.5;
const DOT_MOVE = 0.35;

/** Looks at the three dots in turn, with a small hop on each, like the loader. Pure function of time. */
export const loadingGaze: GazeScript = t => {
  const step = Math.max(0, t) / DOT_STEP;
  const index = Math.floor(step) % DOT_YAWS.length;
  const p = Math.min(1, (step % 1) / DOT_MOVE);
  const eased = 1 - (1 - p) ** 3;
  const from = DOT_YAWS[(index + DOT_YAWS.length - 1) % DOT_YAWS.length];
  return { yaw: from + (DOT_YAWS[index] - from) * eased, pitch: 4 + 5 * Math.sin(Math.PI * p), mix: 1, spin: 0, wander: 0 };
};

export type BloubFrame = Pick<BloubBotProps, "shape" | "expression" | "color" | "state" | "gaze"> & {
  /** Still frame used when not animating (static activity, reduced motion, off screen). */
  frozenAt: number;
  /** Whether live playback adds anything for this activity. */
  animated: boolean;
};

export function bloubFrame(config: BloubConfig, activity: BloubActivity): BloubFrame {
  const base = { shape: config.shape, expression: config.expression, color: config.color, state: "idle" as const, gaze: null, frozenAt: OPEN_EYES_AT, animated: false };
  switch (activity) {
    case "sleeping": return { ...base, expression: CLOSED_EYES_EXPRESSION, frozenAt: CLOSED_EYES_AT };
    case "working": return { ...base, gaze: loadingGaze, animated: true };
    case "unavailable": return { ...base, shape: UNAVAILABLE_SHAPE };
    case "idle": return base;
  }
}
