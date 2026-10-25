import { body, llmResponse } from "@/lib/llm/http";
import type { InstancesResponse } from "@/lib/llm/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The owner's LLM instances, default instance and the operator's environment server (never its URL). */
export async function GET(request: Request) {
  return llmResponse(request, async ({ runtime, owner }): Promise<InstancesResponse> => ({ instances: runtime.store.list(owner), settings: runtime.store.settings(owner), environment: runtime.environment() }));
}
export async function POST(request: Request) {
  return llmResponse(request, async ({ runtime, owner }) => ({ instance: runtime.store.create(owner, await body(request, 8_000)) }));
}
