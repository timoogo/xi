"use client";

import { useRouter } from "next/navigation";
import type { MouseEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";

const INTERACTIVE = "a, button, summary, details, input, textarea, select, label, [role=button], [role=group]";

/**
 * A feed entry whose free space opens the publication, like a social feed.
 * Links, buttons, folded sources and text selection keep their own behaviour;
 * keyboard users reach the detail page through the date link.
 */
export function FeedArticle({ href, label, className, children }: { href?: string; label: string; className?: string; children: ReactNode }) {
  const router = useRouter();
  function open(event: MouseEvent<HTMLElement>) {
    if (!href || event.defaultPrevented || event.button !== 0) return;
    if ((event.target as Element).closest(INTERACTIVE)) return;
    if (window.getSelection()?.toString()) return;
    if (event.metaKey || event.ctrlKey) window.open(href, "_blank", "noopener");
    else router.push(href);
  }
  return (
    <article aria-label={label} onClick={href ? open : undefined}
      className={cn(className, href && "cursor-pointer transition-colors hover:bg-foreground/[0.025]")}>
      {children}
    </article>
  );
}
