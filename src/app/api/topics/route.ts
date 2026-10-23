import { z } from "zod";
import { body, topicResponse } from "@/lib/topics/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return topicResponse(request, async store => ({ topics: await store.list() })); }
export async function PATCH(request: Request) {
  return topicResponse(request, async (store, owner) => {
    const input = z.object({ id: z.uuid(), revision: z.uuid(), draft: z.unknown(), relationsConfirmed: z.boolean() }).parse(await body(request));
    return { topic: await store.update(owner, input.id, input.revision, input.draft, input.relationsConfirmed) };
  });
}
