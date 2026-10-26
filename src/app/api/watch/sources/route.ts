import { accountResponse, body } from "@/lib/accounts/http";
import { getAppDatabase } from "@/lib/auth";
import { getTopicStore } from "@/lib/topics/server";
import { createSource } from "@/lib/watch/source-admin";
import { getWatchServices } from "@/lib/watch/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * The owner adds a source by hand: `{ url, topicIds }` (feed or site, autodiscovery), created
 * pending. A known address is reported (`duplicate: true`), never created twice.
 */
export async function POST(request: Request) {
  return accountResponse(request, async (accounts, owner) => {
    const { sources, fetch } = await getWatchServices();
    return createSource({ db: getAppDatabase(), accounts, topics: await getTopicStore(), sources, fetch }, owner, await body(request, 4_096));
  });
}
