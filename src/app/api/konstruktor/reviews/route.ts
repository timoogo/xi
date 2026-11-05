import { getKonstruktor } from "@/lib/konstruktor/server";
import { systemAgentResponse } from "@/lib/system-agents/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `?requestId=…`: state of a review asked by the session user. */
export async function GET(request: Request) {
  return systemAgentResponse(request, async (_, userId) => ({ request: (await getKonstruktor()).reviewState(userId, new URL(request.url).searchParams.get("requestId")) }));
}

/** Asks Konstruktor to review the session user's ΞAgents and Topics now (idempotent for the same state, the same day). */
export async function POST(request: Request) {
  return systemAgentResponse(request, async (_, userId) => ({ request: await (await getKonstruktor()).review(userId) }));
}
