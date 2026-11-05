import { getAppDatabase } from "@/lib/auth";
import { systemAgentResponse } from "@/lib/system-agents/http";
import { instanceOwner, isInstanceOwner } from "@/lib/system-agents/owner";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * The instance's system ΞAgents, readable by any signed-in user. `canConfigure`: the viewer is the
 * instance owner. `owner`: whether that owner is recorded and still exists (never its identifier).
 */
export async function GET(request: Request) {
  return systemAgentResponse(request, async (store, userId) => {
    const db = getAppDatabase();
    return { agents: await store.list(), canConfigure: isInstanceOwner(db, userId), owner: instanceOwner(db).status };
  });
}
