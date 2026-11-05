import { getAppDatabase } from "@/lib/auth";
import { body, systemAgentResponse } from "@/lib/system-agents/http";
import { isInstanceOwner } from "@/lib/system-agents/owner";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ kind: string }> }) {
  return systemAgentResponse(request, async (store, userId) => ({ agent: await store.get((await params).kind), canConfigure: isInstanceOwner(getAppDatabase(), userId) }));
}

/** `{ revision, enabled?, bloub? }`: instance owner only (404 otherwise), optimistic (409). */
export async function PATCH(request: Request, { params }: { params: Promise<{ kind: string }> }) {
  return systemAgentResponse(request, async (store, userId) => ({ agent: await store.configure(userId, (await params).kind, await body(request, 4_096)) }));
}
