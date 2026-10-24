import { z } from "zod";
import { accountResponse, body } from "@/lib/accounts/http";
import { TopicError } from "@/lib/topics/types";
import { proposeFromUrl } from "@/lib/watch/collect";
import { jsonApiSchema } from "@/lib/watch/feeds";
import { getWatchServices } from "@/lib/watch/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * Owner proposes a source for one of their agents: a feed or site URL (feed autodiscovery), or a
 * configured official JSON API. It is created as a proposal; approval is a separate decision.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return accountResponse(request, async (accounts, owner) => {
    const agent = await accounts.getOwned(owner, (await params).id);
    if (!agent.editorial) throw new TopicError("Complétez le ΞAgent avant de lui associer des sources.", 409);
    const input = z.object({ url: z.string().trim().min(1).max(2_000), api: jsonApiSchema.optional() }).strict().parse(await body(request, 8_192));
    const { sources, fetch } = await getWatchServices();
    return proposeFromUrl({ fetch, sources, owner, url: input.url, api: input.api ?? null, topicIds: [agent.editorial.primaryTopicId, ...agent.editorial.secondaryTopicIds], by: owner, note: "Proposée manuellement par le propriétaire." });
  });
}
