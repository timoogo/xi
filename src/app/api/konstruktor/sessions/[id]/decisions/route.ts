import { getKonstruktor } from "@/lib/konstruktor/server";
import { body, systemAgentResponse } from "@/lib/system-agents/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `{ refused, reset }`: refuses proposals, or puts them back to undecided; no configuration is written. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return systemAgentResponse(request, async (_, userId) => ({ session: await (await getKonstruktor()).decide(userId, (await params).id, await body(request, 8_192)) }));
}
