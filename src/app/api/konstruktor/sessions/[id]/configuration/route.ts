import { getKonstruktor } from "@/lib/konstruktor/server";
import { systemAgentResponse } from "@/lib/system-agents/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The current configuration of the conversation's target, read now with its revisions: the base of the preview. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return systemAgentResponse(request, async (_, userId) => ({ configuration: await (await getKonstruktor()).configuration(userId, (await params).id) }));
}
