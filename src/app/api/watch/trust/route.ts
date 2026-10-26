import { accountResponse, body } from "@/lib/accounts/http";
import { getAppDatabase } from "@/lib/auth";
import { getTopicStore } from "@/lib/topics/server";
import { getWatchServices } from "@/lib/watch/server";
import { decideTrust, trustMatrix } from "@/lib/watch/trust";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deps = async (accounts: Parameters<Parameters<typeof accountResponse>[1]>[0]) =>
  ({ db: getAppDatabase(), accounts, topics: await getTopicStore(), sources: (await getWatchServices()).sources });

/** The owner's trust matrix: sources, ΞAgents, topics and explicit decisions. */
export async function GET(request: Request) {
  return accountResponse(request, async (accounts, owner) => trustMatrix(await deps(accounts), owner));
}
/** One decision `{ sourceId, scope: global|agent|topic, scopeId, decision: approved|denied|pending, revision? }`. Others' sources are 404. */
export async function POST(request: Request) {
  return accountResponse(request, async (accounts, owner) => decideTrust(await deps(accounts), owner, await body(request, 4_096)));
}
