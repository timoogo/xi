import { body, deleteInstance, llmResponse } from "@/lib/llm/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Params = { params: Promise<{ id: string }> };
/** Edit or (de)activate: `{ revision, ...instance }`, optimistic. */
export async function PATCH(request: Request, { params }: Params) {
  return llmResponse(request, async ({ runtime, owner }) => ({ instance: runtime.store.update(owner, (await params).id, await body(request, 8_000)) }));
}
/** Explicit decision required when ΞAgents depend on it (409 with the dependencies otherwise). */
export async function DELETE(request: Request, { params }: Params) {
  return llmResponse(request, async ({ runtime, accounts, owner }) => deleteInstance(runtime, await accounts(), owner, (await params).id, await body(request, 2_000)));
}
