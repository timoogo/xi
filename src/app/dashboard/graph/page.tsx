import type { Metadata } from "next";
import { GraphExplorer } from "@/components/graph/graph-explorer";
import { PageHeader } from "@/components/page-header";
import { getCurrentUser } from "@/lib/current-user";

export const metadata: Metadata = { title: "Ξ | Graphe", description: "Explorer les générateurs, les publications et leurs connexions." };

// Page-local: the graph takes the whole width and height left by the navigation (the layout's 640px column and
// the discovery panel are lifted only while this page is rendered).
const FULL_WIDTH = `
#main-content:has([data-xi-graph]) { max-width: none; padding-bottom: 0; }
div:has(> #main-content [data-xi-graph]) { max-width: none; }
body:has([data-xi-graph]) #main-content ~ aside { display: none; }
`;

export default async function GraphPage() {
  const user = await getCurrentUser();
  return (
    <div data-xi-graph="" className="flex h-[calc(100dvh-3.5rem-env(safe-area-inset-bottom))] min-h-[420px] flex-col sm:h-dvh">
      <style dangerouslySetInnerHTML={{ __html: FULL_WIDTH }} />
      <PageHeader title="Graphe" subtitle="Générateurs, publications et connexions validées" />
      <GraphExplorer userId={user.id} className="flex-1" />
    </div>
  );
}
