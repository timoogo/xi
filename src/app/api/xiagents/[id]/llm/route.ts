import { z } from "zod";
import { body, llmResponse } from "@/lib/llm/http";
import { LLMStoreError } from "@/lib/llm/store";
import { agentLLMConfigSchema, type AgentLLMView } from "@/lib/llm/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Params = { params: Promise<{ id: string }> };
/** The agent's LLM selection and what it resolves to (no URL). Owner-only. */
export async function GET(request: Request, { params }: Params) {
  return llmResponse(request, async ({ runtime, accounts, owner }): Promise<AgentLLMView> => {
    const settings = await (await accounts()).llm(owner, (await params).id);
    return { settings, resolution: runtime.resolve(owner, settings) };
  });
}
/** `{ revision, config }`, optimistic. An explicit instance must be an enabled instance of the owner. */
export async function PUT(request: Request, { params }: Params) {
  return llmResponse(request, async ({ runtime, accounts, owner }): Promise<AgentLLMView> => {
    const input = z.object({ revision: z.uuid().nullable(), config: agentLLMConfigSchema }).strict().parse(await body(request, 4_000));
    if (input.config.instanceId) {
      const instance = runtime.store.get(owner, input.config.instanceId);
      if (!instance) throw new LLMStoreError("Instance introuvable.", 404);
      if (!instance.enabled) throw new LLMStoreError("Instance désactivée : réactivez-la ou choisissez-en une autre.");
    }
    const settings = await (await accounts()).setLLM(owner, (await params).id, input);
    return { settings, resolution: runtime.resolve(owner, settings) };
  });
}
