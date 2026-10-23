"use client";

import { useEffect, useRef } from "react";

import { useId, useMemo } from "react";
import { bloubAppearance, bloubEyes } from "@/lib/bloub/appearance";

export function BloubAvatar({ name, size = 40, seed }: { name: string; size?: number; seed?: string }) {
  const clipId = useId();
  const appearance = useMemo(() => bloubAppearance(seed), [seed]);
  const rest = useMemo(() => bloubEyes(appearance), [appearance]);
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const element = svg.current;
    if (!element || !("IntersectionObserver" in window)) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let visible = false;
    let disposed = false;
    let frame = 0;
    let generation = 0;
    const eyes = element.querySelectorAll("rect");
    function stop() {
      generation++;
      cancelAnimationFrame(frame);
      element!.dataset.animating = "false";
      eyes.forEach((eye, i) => eye.setAttribute("transform", rest[i]));
    }
    async function sync() {
      stop();
      if (disposed || !visible || reduced.matches || document.hidden) return;
      const ticket = generation;
      try {
        // Defer the animation loop until the avatar is visible.
        await Promise.resolve();
        if (disposed || ticket !== generation) return;
        const start = performance.now();
        function tick(now: number) {
          bloubEyes(appearance, (now - start) / 1000).forEach((matrix, i) => eyes[i].setAttribute("transform", matrix));
          frame = requestAnimationFrame(tick);
        }
        element!.dataset.animating = "true";
        frame = requestAnimationFrame(tick);
      } catch { /* The server-rendered rest pose remains available offline. */ }
    }
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; void sync(); });
    observer.observe(element);
    reduced.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      disposed = true;
      stop();
      observer.disconnect();
      reduced.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [appearance, rest]);
  return <svg ref={svg} role="img" aria-label={`Avatar Bloub de ${name}`} width={size} height={size} viewBox="-125 -125 250 250" className="shrink-0 rounded-full" style={{ backgroundColor: appearance.paper }} data-bloub data-seed={seed}>
    <defs><clipPath id={clipId}><path d={appearance.body} /></clipPath></defs>
    <path d={appearance.body} fill={appearance.ink} />
    <g clipPath={`url(#${clipId})`}>
      {rest.map((transform, i) => <rect key={i} x={-appearance.width / 2} y={-appearance.height / 2} width={appearance.width} height={appearance.height} rx={appearance.width / 2} fill="white" transform={transform} />)}
    </g>
  </svg>;
}
