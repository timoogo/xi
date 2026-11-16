import { PageHeader } from "@/components/page-header";
import { IdeaPlanner } from "@/components/konstruktor/idea-planner";
import { getCurrentUser } from "@/lib/current-user";
export const metadata = { title: "Ξ | Créer à partir d’une idée" };
export const dynamic = "force-dynamic";

export default async function KonstruktorIdeaPage() {
  await getCurrentUser();
  return <><PageHeader title="Créer à partir d’une idée" back={{ href: "/dashboard/konstruktor", label: "Konstruktor" }} /><IdeaPlanner /></>;
}
