import { z } from "zod";
import { llmResponse, optionalBody } from "@/lib/llm/http";
import { modelNameSchema } from "@/lib/llm/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Explicit short request to one model of a stored instance: latency and reply, no side effect. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return llmResponse(request, async ({ runtime, owner }) => {
    const { model } = z.object({ model: modelNameSchema.optional() }).strict().parse(await optionalBody(request));
    return runtime.testModel(owner, null, model, (await params).id);
  });
}
