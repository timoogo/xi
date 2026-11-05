import { getKonstruktor } from "@/lib/konstruktor/server";
import { body, systemAgentResponse } from "@/lib/system-agents/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `{ deploymentId, spec, accepted, refused }`: validates the preview. Creates the deployment (idempotent
 * on its id; 409 when the target changed since the preview, 422 for problems; nothing written then)
 * and records the decisions. It runs with `POST /api/xiagents/deployments/<id>` `{ action: "run" }`.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return systemAgentResponse(request, async (_, userId) => await (await getKonstruktor()).apply(userId, (await params).id, await body(request, 128_000)));
}
