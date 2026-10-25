import { llmResponse } from "@/lib/llm/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Explicit connection check and model discovery of a stored instance (rate-limited; never pulls nor loads a model). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return llmResponse(request, async ({ runtime, owner }) => ({ instance: await runtime.check(owner, (await params).id) }));
}
