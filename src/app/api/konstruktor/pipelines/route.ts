import { getKnowledgePipelines } from "@/lib/konstruktor/server";
import { body, systemAgentResponse } from "@/lib/system-agents/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The session user's pipeline runs, optionally of one of their ΞAgents (`?agent=`). */
export async function GET(request: Request) {
  const agent = new URL(request.url).searchParams.get("agent") ?? undefined;
  return systemAgentResponse(request, async (_, userId) => ({ runs: (await getKnowledgePipelines()).list(userId, { agent }) }));
}

/** `{ agent, mode: "missing" | "force" }`: a manual run for one of the session user's ΞAgents. */
export async function POST(request: Request) {
  return systemAgentResponse(request, async (_, userId) => ({ run: (await (await getKnowledgePipelines()).start(userId, await body(request)))!.run }));
}
