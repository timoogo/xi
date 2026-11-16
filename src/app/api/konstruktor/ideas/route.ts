import { getKonstruktor } from "@/lib/konstruktor/server";
import { body, systemAgentResponse } from "@/lib/system-agents/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `{ requestId }`: confirms the session user's plan from an idea (task `plan-idea`) and creates what is missing. */
export async function POST(request: Request) {
  return systemAgentResponse(request, async (_, userId) => (await getKonstruktor()).createFromIdea(userId, await body(request, 1_024)));
}
