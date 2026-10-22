import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { Composer } from "@/components/publications/publication-actions";
import { PublicationFeed } from "@/components/publications/publication-feed";
import { getCurrentUser } from "@/lib/current-user";

export const metadata: Metadata = { title: "Ξ | Accueil", description: "Votre fil Ξ." };

export default async function HomePage({ searchParams }: { searchParams: Promise<{ cursor?: string | string[]; tab?: string }> }) {
  const [user, { cursor, tab }] = await Promise.all([getCurrentUser(), searchParams]);
  const following = tab === "following";
  return (
    <>
      <PageHeader title="Accueil" />
      <nav aria-label="Choisir le fil" className="grid grid-cols-2 border-b">
        {[{ label: "Pour vous", href: "/dashboard", active: !following }, { label: "Abonnements", href: "/dashboard?tab=following", active: following }].map((item) => (
          <Link key={item.label} href={item.href} aria-current={item.active ? "page" : undefined} className={`px-4 py-4 text-center font-semibold hover:bg-accent ${item.active ? "border-b-2 border-chart-2" : "text-muted-foreground"}`}>{item.label}</Link>
        ))}
      </nav>
      <details className="border-b px-4 py-2 text-sm text-muted-foreground">
        <summary className="cursor-pointer">{following ? "Un fil chronologique" : "Pourquoi ces publications ?"}</summary>
        <p className="py-2">{following ? "Les comptes suivis et les descendants des générateurs suivis, du plus récent au plus ancien. Aucun reclassement éditorial." : "La pertinence éditoriale et vos préférences explicites guident ce fil, avec la fraîcheur et une diversité d’auteurs. Aucun historique de navigation n’est utilisé. Modifiez vos préférences depuis les profils."}</p>
        <Link className="underline" href="/dashboard/profiles">Découvrir les comptes et gérer mes préférences</Link>
      </details>
      {cursor ? null : <Composer user={{ name: user.name, image: user.image }} />}
      {/* Scoped to the feed: a segment-wide loading.tsx would stream every dashboard page with status 200 before notFound(). */}
      <Suspense fallback={<p role="status" className="p-6 text-muted-foreground">Chargement des publications…</p>}>
      <PublicationFeed viewer={user} scope={{ kind: "home", tab: following ? "following" : "for-you" }} cursor={typeof cursor === "string" ? cursor : undefined} path={following ? "/dashboard?tab=following" : "/dashboard"} label={following ? "Abonnements" : "Pour vous"}
        empty={following ? { title: "Aucune publication dans vos abonnements", description: "Abonnez-vous à des comptes depuis leur profil pour retrouver leurs publications ici." } : { title: "Votre fil vous attend", description: "Il n’y a encore aucune publication. Rédigez la première : elle est enregistrée en Markdown dans votre vault Obsidian." }} />
      </Suspense>
    </>
  );
}
