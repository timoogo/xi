import { z } from "zod";
import { getKnowledgePipelines } from "@/lib/konstruktor/server";
import { body, systemAgentResponse } from "@/lib/system-agents/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const action = z.object({ action: z.enum(["retry", "cancel"]) }).strict();

/** One of the session user's runs, with its jobs and their logs; another user's run is unknown (404). */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return systemAgentResponse(request, async (_, userId) => ({ run: (await getKnowledgePipelines()).get(userId, id) }));
}

/** `{ action: "retry" }` relaunches failed jobs; `{ action: "cancel" }` withdraws queued ones. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return systemAgentResponse(request, async (_, userId) => {
    const pipelines = await getKnowledgePipelines();
    const { action: wanted } = action.parse(await body(request));
    return { run: wanted === "retry" ? pipelines.retry(userId, id) : pipelines.cancel(userId, id) };
  });
}
