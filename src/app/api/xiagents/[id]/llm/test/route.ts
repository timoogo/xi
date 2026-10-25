import { llmResponse } from "@/lib/llm/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Explicit test of the agent's resolved model: short request, latency, nothing published or modified. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return llmResponse(request, async ({ runtime, accounts, owner }) => runtime.testModel(owner, await (await accounts()).llm(owner, (await params).id)));
}
