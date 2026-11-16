"use client";

import type { GazeScript } from "bloub-react";
import { useCallback, useEffect, useRef, useState, type FocusEvent, type PointerEvent } from "react";
import { createCompanion, target, type Companion, type CompanionMood } from "@/lib/bloub/companion";

/**
 * Brings a Bloub companion to life on the element that hosts it: returns its mood (one render per
 * change, never per frame), the gaze script for `BloubAvatar`, and handlers to spread on that
 * element. Listeners live on the element only (no global listener); timers are cleared on unmount.
 */
export function useCompanion(restYaw: number) {
  const companion = useRef<Companion | null>(null);
  const [mood, setMood] = useState<CompanionMood>("neutral");
  useEffect(() => {
    // Created in the effect, so Strict Mode's replay disposes the first one and starts afresh.
    const instance = createCompanion({ restYaw, seed: Math.floor(Math.random() * 2 ** 32) });
    companion.current = instance;
    const unsubscribe = instance.subscribe(() => setMood(instance.mood()));
    return () => { unsubscribe(); instance.dispose(); companion.current = null; setMood("neutral"); };
  }, [restYaw]);

  const gaze = useCallback<GazeScript>(() => companion.current?.look() ?? target({ mood: "neutral", aim: null }, restYaw), [restYaw]);
  const aim = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "touch") return;
    const box = event.currentTarget.getBoundingClientRect(), radius = Math.max(1, box.width / 2);
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    companion.current?.attend({ x: clamp((event.clientX - box.left - radius) / radius), y: clamp((event.clientY - box.top - box.height / 2) / radius) });
  };
  const handlers = {
    onPointerEnter: aim,
    onPointerMove: aim,
    onPointerLeave: (event: PointerEvent<HTMLElement>) => { if (event.pointerType !== "touch") companion.current?.release(); },
    onFocus: (event: FocusEvent<HTMLElement>) => { if (event.currentTarget.matches(":focus-visible")) companion.current?.attend(null); },
    onBlur: () => companion.current?.release(),
  };
  const press = useCallback(() => companion.current?.press(), []);
  return { mood, gaze, handlers, press };
}
