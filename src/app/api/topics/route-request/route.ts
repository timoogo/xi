import { z } from "zod";
import { body, topicResponse } from "@/lib/topics/http";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return topicResponse(request, async store => {
    const input = z.object({ intent: z.string(), correction: z.object({ primaryId: z.uuid(), secondaryIds: z.array(z.uuid()).max(30) }).optional() }).parse(await body(request));
    return store.route(input.intent, input.correction);
  });
}
