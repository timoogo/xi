import { accountResponse, body } from "@/lib/accounts/http";
import { setXiAgentPin } from "@/lib/xiagents/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** `{ pinned }` for the session user only; foreign or unknown editorial agents are 404. Returns the refreshed list of the agent's category. */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return accountResponse(request, async (_, owner) => ({ agents: await setXiAgentPin(owner, (await params).id, await body(request, 256)) }));
}
