import { accountResponse } from "@/lib/accounts/http";
import { getAppDatabase } from "@/lib/auth";
import { getPublicationStore } from "@/lib/publications/server";
import { TopicError } from "@/lib/topics/types";
import { diffusionContext, parseSupervisionQuery, queryError, supervision } from "@/lib/xiagents/supervision";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * Read-only projection of the viewer's own ΞAgents: `?view=calendar|queue|activity` with the
 * filters of the supervision page (agent, topic, month, date, tz, from, to, state, story, before).
 */
export async function GET(request: Request) {
  return accountResponse(request, async (accounts, owner) => {
    const query = parseSupervisionQuery(new URL(request.url).searchParams);
    if (!query.success) throw new TopicError(queryError(query.error), 400);
    const publications = await getPublicationStore();
    await publications.ensureIndexed();
    return supervision(getAppDatabase(), owner, await accounts.watchAgents(), query.data, Date.now(), diffusionContext(publications));
  });
}
