import { systemAgentResponse } from "@/lib/system-agents/http";
import { getSystemTasks } from "@/lib/system-agents/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** State, result or error and attempts of one of the session user's tasks (404 for anyone else). */
export async function GET(request: Request, { params }: { params: Promise<{ kind: string; requestId: string }> }) {
  return systemAgentResponse(request, async (_, userId) => {
    const { kind, requestId } = await params;
    return { request: (await getSystemTasks()).get(userId, kind, requestId) };
  });
}
