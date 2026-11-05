import { getKonstruktor } from "@/lib/konstruktor/server";
import { targetSchema } from "@/lib/konstruktor/types";
import { body, systemAgentResponse } from "@/lib/system-agents/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `?type=topic|agent|new-topic|new-agent&id=…`: the session user's conversations about this target. */
export async function GET(request: Request) {
  return systemAgentResponse(request, async (_, userId) => {
    const params = new URL(request.url).searchParams;
    const target = targetSchema.parse({ type: params.get("type"), id: params.get("id") || null });
    return { sessions: await (await getKonstruktor()).list(userId, target) };
  });
}

/** `{ id, target }`: opens a conversation (idempotent on the client's id) after checking the target is readable. */
export async function POST(request: Request) {
  return systemAgentResponse(request, async (_, userId) => ({ session: await (await getKonstruktor()).open(userId, await body(request, 1_024)) }));
}
