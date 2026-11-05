import { getKonstruktor } from "@/lib/konstruktor/server";
import { body, systemAgentResponse } from "@/lib/system-agents/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `{ requestId, text }`: queues a turn (idempotent on requestId); 409 while the previous turn is in progress. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return systemAgentResponse(request, async (_, userId) => ({ session: await (await getKonstruktor()).send(userId, (await params).id, await body(request, 8_192)) }));
}
