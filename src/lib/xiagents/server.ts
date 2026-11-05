import { getAccountStore } from "../accounts/server";
import { getAppDatabase } from "../auth";
import { DEFAULT_BLOUB_CONFIG } from "../bloub/config";
import { getFeedAuthors } from "../publications/server";
import { getSystemAgentStore } from "../system-agents/server";
import { SYSTEM_AGENTS } from "../system-agents/registry";
import { migrateAgentPins, setAgentPin } from "./pins";
import { z } from "zod";
import { busyAgents, xiAgentBloub } from "./avatar";
import type { XiAgentCategory, XiAgentSummary } from "./summary";

/** The owner's ΞAgents with their server-computed activity (as feed authors) and the owner's pins. */
export async function xiAgentSummaries(owner: string): Promise<XiAgentSummary[]> {
  const accounts = await getAccountStore();
  const owned = (await accounts.list(owner)).filter(account => account.owner === owner);
  const authors = await getFeedAuthors({ id: owner }, owned.map(account => account.id));
  const pins = accounts.pins(owner);
  return owned.map(({ id, name, handle }) => ({
    id, name, handle, category: "editorial" as const, pinnedAt: pins.get(id) ?? null,
    bloub: authors.get(id)?.bloub ?? { config: DEFAULT_BLOUB_CONFIG, activity: "unavailable" },
  }));
}

/**
 * The instance's system ΞAgents, the same for every viewer: a disabled one is unavailable, one whose
 * job is claimed by a live worker is working (busyAgents reads `payload.agentId`), otherwise idle.
 */
export async function systemAgentSummaries(viewer: string): Promise<XiAgentSummary[]> {
  const [agents, accounts] = await Promise.all([getSystemAgentStore().then(store => store.list()), getAccountStore()]);
  const busy = busyAgents(getAppDatabase(), agents.map(agent => agent.id));
  const pins = accounts.pins(viewer);
  return agents.map(agent => ({
    id: agent.id, name: agent.name, handle: agent.handle, category: "system" as const, pinnedAt: pins.get(agent.id) ?? null,
    bloub: xiAgentBloub({ config: agent.bloub, active: agent.enabled, watching: true }, busy.has(agent.id)),
  }));
}

export const summariesOf = (category: XiAgentCategory, viewer: string) => category === "system" ? systemAgentSummaries(viewer) : xiAgentSummaries(viewer);

/**
 * Pins a ΞAgent for the viewer and returns the refreshed list of its category. System agents belong
 * to the instance and are listed for every user: any user may pin them for themselves. Editorial
 * agents stay owner-only (accounts.setPin, 404 otherwise).
 */
export async function setXiAgentPin(viewer: string, id: string, input: unknown): Promise<XiAgentSummary[]> {
  if (SYSTEM_AGENTS.some(agent => agent.id === id)) {
    const { pinned } = z.object({ pinned: z.boolean() }).strict().parse(input);
    const db = getAppDatabase();
    migrateAgentPins(db);
    setAgentPin(db, viewer, id, pinned);
    return systemAgentSummaries(viewer);
  }
  await (await getAccountStore()).setPin(viewer, id, input);
  return xiAgentSummaries(viewer);
}
