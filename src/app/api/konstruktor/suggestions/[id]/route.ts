import { getKonstruktor } from "@/lib/konstruktor/server";
import { body, systemAgentResponse } from "@/lib/system-agents/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `{ action: "refuse" | "restore" }`: refuses a suggestion or puts it back to review; no configuration is written. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return systemAgentResponse(request, async (_, userId) => ({ suggestion: await (await getKonstruktor()).decideSuggestion(userId, (await params).id, await body(request, 1_024)) }));
}
