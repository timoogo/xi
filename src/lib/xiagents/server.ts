import { getAccountStore } from "../accounts/server";
import { DEFAULT_BLOUB_CONFIG } from "../bloub/config";
import { getFeedAuthors } from "../publications/server";
import type { XiAgentSummary } from "./summary";

/** The owner's ΞAgents with their server-computed activity (as feed authors) and the owner's pins. */
export async function xiAgentSummaries(owner: string): Promise<XiAgentSummary[]> {
  const accounts = await getAccountStore();
  const owned = (await accounts.list(owner)).filter(account => account.owner === owner);
  const authors = await getFeedAuthors({ id: owner }, owned.map(account => account.id));
  const pins = accounts.pins(owner);
  return owned.map(({ id, name, handle }) => ({
    id, name, handle, pinnedAt: pins.get(id) ?? null,
    bloub: authors.get(id)?.bloub ?? { config: DEFAULT_BLOUB_CONFIG, activity: "unavailable" },
  }));
}
