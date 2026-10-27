"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

const focusable = "a[href], button, input, select, textarea, summary, [tabindex]";

/**
 * Collapsible section of the ΞAgent page (disclosure pattern: a heading holding a button with
 * `aria-expanded`). Closed by default. A link to the section or to any element inside it (`#id`,
 * on load, on hash change or when the same link is followed again) opens it, scrolls to the
 * target and moves the focus there. The content stays mounted while closed: panel state survives.
 * Children label their region with `${id}-title`.
 */
export function DashboardSection({ id, title, icon, children }: { id: string; title: string; icon: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<{ element: HTMLElement } | null>(null);

  useEffect(() => {
    const reveal = (hash: string) => {
      const element = hash.length > 1 ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
      if (!element || !document.getElementById(id)?.contains(element)) return;
      setOpen(true);
      setTarget({ element });
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const href = (event.target as Element | null)?.closest?.("a[href^='#']")?.getAttribute("href");
      // A different hash fires `hashchange`; following the current one again does not.
      if (href && href === window.location.hash) reveal(href);
    };
    const onHash = () => reveal(window.location.hash);
    reveal(window.location.hash);
    window.addEventListener("hashchange", onHash);
    document.addEventListener("click", onClick);
    return () => { window.removeEventListener("hashchange", onHash); document.removeEventListener("click", onClick); };
  }, [id]);

  // After the content is shown: scroll to the target and focus it (the toggle for the section itself).
  useEffect(() => {
    if (!target) return;
    const root = document.getElementById(id);
    const element = target.element === root ? root.querySelector<HTMLElement>(`#${id}-toggle`) : target.element;
    if (!element) return;
    if (!element.matches(focusable)) element.setAttribute("tabindex", "-1");
    element.focus({ preventScroll: true });
    (target.element === root ? root : element).scrollIntoView({ block: "start" });
  }, [id, target]);

  return <div id={id} className="scroll-mt-14 border-b">
    <h2 id={`${id}-title`} className="text-lg font-bold">
      <button id={`${id}-toggle`} type="button" aria-expanded={open} aria-controls={`${id}-content`} onClick={() => setOpen(value => !value)}
        className="flex w-full items-center gap-3 p-4 text-left hover:bg-accent/40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
        <span aria-hidden="true" className="text-muted-foreground [&>svg]:size-[18px]">{icon}</span>
        <span className="min-w-0 flex-1">{title}</span>
        <ChevronDown aria-hidden="true" className={`size-5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
    </h2>
    <div id={`${id}-content`} hidden={!open} className="border-t [&>*:last-child]:border-b-0 [&_[id]]:scroll-mt-14">{children}</div>
  </div>;
}
