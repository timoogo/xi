import { body, systemAgentResponse } from "@/lib/system-agents/http";
import { getSystemTasks } from "@/lib/system-agents/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The session user's latest tasks for this system agent (never another user's). */
export async function GET(request: Request, { params }: { params: Promise<{ kind: string }> }) {
  return systemAgentResponse(request, async (_, userId) => ({ requests: (await getSystemTasks()).list(userId, (await params).kind) }));
}

/** `{ requestId, task, input? }`: queued and started at once; idempotent on `requestId` (409 if it differs). */
export async function POST(request: Request, { params }: { params: Promise<{ kind: string }> }) {
  return systemAgentResponse(request, async (_, userId) => (await getSystemTasks()).request(userId, (await params).kind, await body(request, 16_384)));
}
