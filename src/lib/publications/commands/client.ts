import type { PublicationSnapshot } from "../types";
import type { PublicationCommandRuntime } from ".";

const URLS = { own: "/api/feed?kind=own", feed: "/api/feed?tab=for-you" } as const;

/** Browser implementation over the existing feed API: the server applies the viewer's read permissions. */
export const publicationsOverHttp: PublicationCommandRuntime["publications"] = {
  async list(scope) {
    const response = await fetch(URLS[scope], { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(data.items)) throw new Error(typeof data.error === "string" ? data.error : "Publications indisponibles. Réessayez.");
    return (data.items as PublicationSnapshot[]).filter(item => typeof item?.id === "string" && Array.isArray(item.messages));
  },
};
