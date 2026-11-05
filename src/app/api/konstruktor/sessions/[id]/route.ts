import { getKonstruktor } from "@/lib/konstruktor/server";
import { systemAgentResponse } from "@/lib/system-agents/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Messages, proposals and state of the last turn of one of the session user's conversations (404 otherwise). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return systemAgentResponse(request, async (_, userId) => ({ session: await (await getKonstruktor()).view(userId, (await params).id) }));
}
