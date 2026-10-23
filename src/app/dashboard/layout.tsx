import type { ReactNode } from "react";
import { getCurrentUser } from "@/lib/current-user";
import { DiscoveryPanel } from "./_components/discovery-panel";
import { Navigation } from "./_components/navigation";

/** Three columns: navigation, a 640px feed column, discovery. The whole composition is centred on wide screens. */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[1265px] justify-center">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded focus:bg-background focus:p-3">Aller au contenu</a>
      <Navigation user={{ name: user.name, image: user.image, bloubSeed: user.bloubSeed, handle: user.handle }} />
      <main id="main-content" tabIndex={-1} className="min-w-0 max-w-[640px] flex-1 pb-[calc(8rem+env(safe-area-inset-bottom))] outline-none sm:border-x sm:pb-0">{children}</main>
      <DiscoveryPanel />
    </div>
  );
}
