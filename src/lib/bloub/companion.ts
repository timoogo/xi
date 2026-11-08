import type { ExpressionId, GazeScript } from "bloub-react";

/**
 * A Bloub companion: where it looks and how it feels, as plain data and timers. No React, no DOM.
 *
 * bloub-react already brings the life: blinks, slow drift and saccades of the eyes, breathing (its
 * idle `liveliness`, scaled by `Look.wander`), and glides between expressions. What it lacks is a
 * resting direction other than up-right, and a smooth gaze script: a `gaze` is applied every frame
 * with a 1/60 s morph and its `follow` mode is tuned for a large hero (fixed −26° turn, a full eye spin
 * on arrival, pointer measured against half the window). So the direction is eased here, and the
 * engine does the rest.
 *
 * Moods: `neutral` (looks towards the page, occasional glances), `attentive` (hover or keyboard
 * focus, follows the pointer), `pleased` (short reaction to a press), `calm` (after a while without
 * interaction), then `dormant` (same pose, but the host stops the animation loop to spare the CPU).
 */
export type Look = ReturnType<GazeScript>;
export type CompanionMood = "neutral" | "attentive" | "calm" | "dormant" | "pleased";
/** Pointer offset from the avatar's centre, in avatar radii (−1…1, right and down positive). */
export type Aim = { x: number; y: number };

export type CompanionState = { mood: CompanionMood; aim: Aim | null; from: Look; since: number; duration: number };

/** Yaw is positive to the right, pitch upwards (degrees). */
const PITCH = 10;
const AIM_YAW = 16, AIM_PITCH = 12;
const WANDER: Record<CompanionMood, number> = { neutral: 0.8, attentive: 0.15, calm: 0.35, dormant: 0.35, pleased: 0.3 };
/** Transition into each mood, in seconds: attentive is quick, the way back is slow. */
export const MOOD_TRANSITION: Record<CompanionMood, number> = { neutral: 0.9, attentive: 0.25, calm: 2, dormant: 0.01, pleased: 0.2 };
const AIM_TRANSITION = 0.18;
/** Resting expression overrides (glided by the engine); null keeps the configured one. */
export const MOOD_EXPRESSION: Record<CompanionMood, ExpressionId | null> = { neutral: null, attentive: "attentif", calm: "somnolent", dormant: "somnolent", pleased: "heureux" };

export const easeInOut = (p: number) => p <= 0 ? 0 : p >= 1 ? 1 : p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2;
const mix = (a: Look, b: Look, p: number): Look => ({ yaw: a.yaw + (b.yaw - a.yaw) * p, pitch: a.pitch + (b.pitch - a.pitch) * p, mix: a.mix + (b.mix - a.mix) * p, spin: 0, wander: a.wander + (b.wander - a.wander) * p });

/** Deterministic PRNG (mulberry32): irregular yet reproducible glances. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => { a = a + 0x6d2b79f5 >>> 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

export type Glance = { at: number; yaw: number; pitch: number; hold: number };
const GLANCE_IN = 0.35, GLANCE_OUT = 0.5;
/** Occasional small glances, 6 to 15 s apart, each held 0.6 to 1.2 s, then back to the rest direction. */
export function glances(seed: number, until = 3600): Glance[] {
  const next = random(seed), list: Glance[] = [];
  for (let at = 4 + next() * 6; at < until; at += 6 + next() * 9) {
    const side = next() < 0.5 ? -1 : 1;
    list.push({ at, yaw: side * (6 + next() * 6), pitch: (next() - 0.4) * 10, hold: 0.6 + next() * 0.6 });
  }
  return list;
}
/** Glance offset at `t`, 0 outside a glance: eased in, held, eased out. */
export function glanceAt(list: readonly Glance[], t: number): { yaw: number; pitch: number } {
  for (const g of list) {
    if (t < g.at) break;
    const local = t - g.at, end = GLANCE_IN + g.hold + GLANCE_OUT;
    if (local > end) continue;
    const p = local < GLANCE_IN ? easeInOut(local / GLANCE_IN) : local < GLANCE_IN + g.hold ? 1 : 1 - easeInOut((local - GLANCE_IN - g.hold) / GLANCE_OUT);
    return { yaw: g.yaw * p, pitch: g.pitch * p };
  }
  return { yaw: 0, pitch: 0 };
}

/** Where a mood looks, without transition. `restYaw` turns the rest direction towards the page. */
export function target(state: Pick<CompanionState, "mood" | "aim">, restYaw: number, glance = { yaw: 0, pitch: 0 }): Look {
  const look = (yaw: number, pitch: number): Look => ({ yaw, pitch, mix: 1, spin: 0, wander: WANDER[state.mood] });
  switch (state.mood) {
    case "attentive": return state.aim ? look(state.aim.x * AIM_YAW, PITCH - state.aim.y * AIM_PITCH) : look(restYaw * 0.5, PITCH + 4);
    case "pleased": return look(restYaw * 0.5, PITCH + 6);
    case "calm": case "dormant": return look(restYaw * 0.7, PITCH - 6);
    case "neutral": return look(restYaw + glance.yaw, PITCH + glance.pitch);
  }
}

/** The look at time `t` (seconds): the transition from the previous look, then the mood's own. */
export function lookAt(state: CompanionState, t: number, restYaw: number, glanceList: readonly Glance[] = []): Look {
  const goal = target(state, restYaw, state.mood === "neutral" ? glanceAt(glanceList, t) : undefined);
  return mix(state.from, goal, easeInOut((t - state.since) / state.duration));
}

export type CompanionOptions = {
  /** Rest yaw in degrees, negative = looks left (the avatar sits on the right of the page). */
  restYaw: number;
  seed?: number;
  /** Without interaction for this long, the companion calms down… */
  calmAfterMs?: number;
  /** …and this long after, it dozes off (still frame). */
  dormantAfterMs?: number;
  /** Seconds, monotonic. */
  now?: () => number;
  timers?: { setTimeout: (callback: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void };
};

const systemTimers = { setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms), clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

/**
 * Mood controller. `look()` is read every frame by the gaze script and never notifies; listeners
 * only hear about mood changes (one re-render each). `dispose()` clears its timers and listeners.
 */
export function createCompanion({ restYaw, seed = 1, calmAfterMs = 30_000, dormantAfterMs = 90_000, now = () => performance.now() / 1000, timers = systemTimers }: CompanionOptions) {
  const list = glances(seed);
  const start = now();
  let state: CompanionState = { mood: "neutral", aim: null, from: target({ mood: "neutral", aim: null }, restYaw), since: -Infinity, duration: 1 };
  let engaged = false, disposed = false;
  let restTimer: unknown, pleasedTimer: unknown;
  const listeners = new Set<() => void>();
  const clock = () => now() - start;
  const look = () => lookAt(state, clock(), restYaw, list);

  function set(mood: CompanionMood, aim: Aim | null, duration = MOOD_TRANSITION[mood]) {
    if (disposed) return;
    const t = clock(), changed = mood !== state.mood;
    state = { mood, aim, from: lookAt(state, t, restYaw, list), since: t, duration };
    if (changed) for (const listener of [...listeners]) listener();
  }
  /** neutral → calm → dormant while nothing happens. */
  function rest() {
    timers.clearTimeout(restTimer);
    restTimer = timers.setTimeout(() => {
      set("calm", null);
      restTimer = timers.setTimeout(() => set("dormant", null), dormantAfterMs);
    }, calmAfterMs);
  }
  function settle() {
    if (engaged) set("attentive", state.aim);
    else { set("neutral", null); rest(); }
  }
  rest();

  return {
    look,
    mood: () => state.mood,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Pointer over the avatar or keyboard focus on it; `aim` is null without a pointer. */
    attend(aim: Aim | null) {
      engaged = true;
      timers.clearTimeout(restTimer);
      if (state.mood === "pleased") { state = { ...state, aim }; return; }
      set("attentive", aim, state.mood === "attentive" && state.aim && aim ? AIM_TRANSITION : MOOD_TRANSITION.attentive);
    },
    /** Pointer gone or focus lost: back to the rest direction, progressively. */
    release() {
      engaged = false;
      if (state.mood !== "pleased") settle();
    },
    /** A short happy reaction that delays nothing, then attentive again (if still engaged) or back to rest. */
    press(holdMs = 700) {
      timers.clearTimeout(pleasedTimer);
      timers.clearTimeout(restTimer);
      set("pleased", state.aim);
      pleasedTimer = timers.setTimeout(settle, holdMs);
    },
    dispose() {
      disposed = true;
      timers.clearTimeout(restTimer);
      timers.clearTimeout(pleasedTimer);
      listeners.clear();
    },
  };
}
export type Companion = ReturnType<typeof createCompanion>;
