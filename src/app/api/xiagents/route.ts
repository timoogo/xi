import { accountResponse } from "@/lib/accounts/http";
import { xiAgentSummaries } from "@/lib/xiagents/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The session user's own ΞAgents: identity, real activity and pins. Polled by the ΞAgents widget. */
export async function GET(request: Request) {
  return accountResponse(request, async (_, owner) => ({ agents: await xiAgentSummaries(owner) }));
}
