import { accountResponse, body } from "@/lib/accounts/http";
import { getAppDatabase } from "@/lib/auth";
import { getPublicationStore } from "@/lib/publications/server";
import { reviewDraft } from "@/lib/watch/drafting";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * Owner review of a watch draft: `{ action: update | reject | approve, revision, messages? }`.
 * Approval publishes privately only (manual end-to-end test); foreign agents and drafts are 404.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; draftId: string }> }) {
  return accountResponse(request, async (accounts, owner) => {
    const { id, draftId } = await params;
    await accounts.getOwned(owner, id);
    return reviewDraft({ db: getAppDatabase(), publications: await getPublicationStore(), owner, agentId: id, draftId, input: await body(request, 64_000) });
  });
}
