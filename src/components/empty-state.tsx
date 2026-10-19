import { XiLogo } from "@/components/xi-logo";

/** Explicit placeholder for content or features that do not exist yet: never fake data. */
export function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <section aria-label={title} className="mx-auto max-w-md px-6 py-12 text-center">
      <XiLogo aria-hidden="true" className="mx-auto mb-4 h-10 w-10 text-chart-2" />
      <h2 className="text-2xl font-extrabold text-foreground">{title}</h2>
      <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">{description}</p>
    </section>
  );
}
