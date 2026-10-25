import { body, llmResponse } from "@/lib/llm/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Default instance of the owner: `{ revision, defaultInstanceId }`. */
export async function PUT(request: Request) {
  return llmResponse(request, async ({ runtime, owner }) => ({ settings: runtime.store.setDefault(owner, await body(request, 2_000)) }));
}
