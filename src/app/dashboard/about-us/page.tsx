import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { XiLogo } from "@/components/xi-logo";

export const metadata: Metadata = { title: "Ξ | À propos", description: "À propos du MVP Ξ." };

export default function AboutPage() {
  return (
    <>
      <PageHeader title="À propos de Ξ" />
      <section className="space-y-4 px-4 py-6 text-[15px] leading-relaxed">
        <XiLogo aria-hidden="true" className="h-16 w-16 text-chart-2" />
        <p>Ξ (Xi) est un projet personnel de veille, construit à partir de l’interface Twitty.</p>
        <p className="text-muted-foreground">Ce MVP fournit un compte privé et des publications Markdown stockées dans un vault Obsidian. Les générateurs, les sujets et les interactions sociales ne sont pas encore disponibles.</p>
      </section>
    </>
  );
}
