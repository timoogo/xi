import { getKonstruktor } from "@/lib/konstruktor/server";
import { body, systemAgentResponse } from "@/lib/system-agents/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The owner's saved preview of this conversation (`null` when none). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return systemAgentResponse(request, async (_, userId) => ({ preview: (await getKonstruktor()).preview(userId, (await params).id) }));
}

/** Saves the preview's choices and manual edits; no ΞAgent or Topic configuration is written. */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return systemAgentResponse(request, async (_, userId) => ({ preview: (await getKonstruktor()).savePreview(userId, (await params).id, await body(request, 128_000)) }));
}
