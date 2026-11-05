import { getKonstruktor } from "@/lib/konstruktor/server";
import { systemAgentResponse } from "@/lib/system-agents/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The session user's Konstruktor suggestions; `?type=agent|topic&id=…`: those about one ΞAgent or Topic. */
export async function GET(request: Request) {
  return systemAgentResponse(request, async (_, userId) => {
    const params = new URL(request.url).searchParams;
    const filter = params.has("type") ? { type: params.get("type"), id: params.get("id") } : undefined;
    return { suggestions: await (await getKonstruktor()).suggestions(userId, filter) };
  });
}
