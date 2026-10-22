"use client";

import { useEffect, useRef } from "react";

/** Native details provides keyboard and screen-reader disclosure semantics. */
export function ConversationBranch({ anchors, count, children }: { anchors: string[]; count: number; children: React.ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const reveal = () => {
      let anchor: string;
      try { anchor = decodeURIComponent(location.hash.slice(1)); } catch { return; }
      const target = document.getElementById(anchor);
      if (target && ref.current?.contains(target)) {
        ref.current.open = true;
        requestAnimationFrame(() => target.scrollIntoView({ block: "center" }));
      }
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, [anchors]);
  return <details ref={ref} className="mt-2 group/branch">
    <summary className="w-fit cursor-pointer rounded px-1 py-2 text-sm font-medium text-chart-2 focus-visible:outline focus-visible:outline-2"><span className="group-open/branch:hidden">Développer</span><span className="hidden group-open/branch:inline">Réduire</span> les réponses ({count})</summary>
    {children}
  </details>;
}
