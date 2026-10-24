import { accountResponse, body } from "@/lib/accounts/http";
import { getWatchServices } from "@/lib/watch/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Owner decision on a source: `{ action: approve|reject|disable|delete|update, revision, note?, edits? }`. Others' sources are 404. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return accountResponse(request, async (_accounts, owner) => (await getWatchServices()).sources.decide(owner, (await params).id, await body(request, 8_192)));
}
