import { accountResponse, body } from "@/lib/accounts/http";
import { xiAgentSummaries } from "@/lib/xiagents/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** `{ pinned }` for the session user only; foreign or unknown agents are 404. Returns the refreshed list. */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return accountResponse(request, async (accounts, owner) => {
    await accounts.setPin(owner, (await params).id, await body(request, 256));
    return { agents: await xiAgentSummaries(owner) };
  });
}
