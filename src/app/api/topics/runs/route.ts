import { z } from "zod";
import { body, topicResponse } from "@/lib/topics/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return topicResponse(request, async (store, owner) => {
    const { intent } = z.object({ intent: z.string() }).parse(await body(request));
    return { run: await store.propose(owner, intent, true) };
  });
}
