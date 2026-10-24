"use client";

import { useEffect, useState, type RefObject } from "react";

const REDUCED = "(prefers-reduced-motion: reduce)";

export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = matchMedia(REDUCED);
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return reduced;
}

/**
 * True only while motion is wanted, the element is on screen, the tab is visible
 * and the user accepts motion. Nothing is observed when motion is not wanted, so
 * static avatars cost no observer, listener or animation frame.
 */
export function useLiveMotion(ref: RefObject<Element | null>, wanted: boolean) {
  const [live, setLive] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!wanted || !element || !("IntersectionObserver" in window)) return;
    const reduced = matchMedia(REDUCED);
    let visible = false;
    const sync = () => setLive(visible && !reduced.matches && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); });
    observer.observe(element);
    reduced.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      observer.disconnect();
      reduced.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
      setLive(false);
    };
  }, [ref, wanted]);
  return wanted && live;
}
