import { instanceDependencies, llmResponse } from "@/lib/llm/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return llmResponse(request, async ({ runtime, accounts, owner }) => instanceDependencies(runtime, await accounts(), owner, (await params).id));
}
