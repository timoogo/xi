import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { XiLogo } from "@/components/xi-logo";

/** Sticky title bar of the central column, shared by every dashboard page. */
export function PageHeader({ title, subtitle, back, children }: {
  title: string;
  subtitle?: string;
  back?: { href: string; label: string };
  children?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-20 flex min-h-[53px] items-center gap-3 border-b bg-background/85 px-4 py-1.5 backdrop-blur-md">
      {back ? (
        <Link href={back.href} aria-label={back.label} title={back.label} className="-ml-2 mr-2 inline-flex size-9 shrink-0 items-center justify-center rounded-full hover:bg-accent">
          <ArrowLeft aria-hidden="true" className="size-5" />
        </Link>
      ) : <XiLogo size={22} aria-hidden="true" className="shrink-0 sm:hidden" />}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-xl font-bold leading-6">{title}</h1>
        {subtitle ? <p className="truncate text-[13px] text-muted-foreground">{subtitle}</p> : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </header>
  );
}
