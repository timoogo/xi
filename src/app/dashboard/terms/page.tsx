import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Ξ | Utiliser Ξ", description: "Fonctionnalités disponibles et confidentialité dans le MVP Ξ." };

const SECTIONS = [
  { title: "Votre compte privé", text: "Votre profil affiche le nom et l’email du compte connecté. Votre email ne figure dans aucun annuaire public." },
  { title: "Fonctionnalités disponibles", text: "Vous pouvez créer un compte, vous connecter, consulter votre profil, changer de thème et vous déconnecter. Vous pouvez rédiger des publications en Markdown : les brouillons sont enregistrés automatiquement et restent privés ; une publication publiée est visible par vous uniquement, ou par chaque membre connecté si elle est publique. Les publications supprimées vont dans votre corbeille privée et peuvent être restaurées." },
  { title: "Pas encore disponible", text: "Commentaires, réactions, abonnements, dérivations, collaboration, générateurs, recherche, notifications et découverte de sujets ne sont pas implémentés. Les publications réservées aux abonnés restent visibles par leur seul auteur tant que les abonnements n’existent pas. Aucune activité ni statistique n’est simulée." },
];

export default function TermsPage() {
  return (
    <>
      <PageHeader title="Utiliser Ξ" subtitle="Informations sur le MVP actuel" />
      {SECTIONS.map(({ title, text }) => (
        <section key={title} className="space-y-1 border-b px-4 py-4">
          <h2 className="text-lg font-bold">{title}</h2>
          <p className="text-[15px] leading-relaxed text-muted-foreground">{text}</p>
        </section>
      ))}
    </>
  );
}
