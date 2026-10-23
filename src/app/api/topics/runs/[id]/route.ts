import { z } from "zod";
import { body, topicResponse } from "@/lib/topics/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  return topicResponse(request, async (store, owner) => ({ run: await store.getRun(owner, (await context.params).id) }));
}
export async function POST(request: Request, context: Context) {
  return topicResponse(request, async (store, owner) => {
    const { id } = await context.params;
    const input = z.discriminatedUnion("action", [
      z.object({ action: z.literal("confirm"), draft: z.unknown(), relationsConfirmed: z.boolean() }),
      z.object({ action: z.literal("parent") }), z.object({ action: z.literal("resume") }), z.object({ action: z.literal("cancel") }),
    ]).parse(await body(request));
    const run = input.action === "confirm" ? await store.confirm(owner, id, input.draft, input.relationsConfirmed) : input.action === "parent" ? await store.proposeParent(owner, id) : input.action === "resume" ? await store.resume(owner, id) : await store.cancel(owner, id);
    return { run };
  });
}
