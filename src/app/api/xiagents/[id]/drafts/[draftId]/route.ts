import { accountResponse, body } from "@/lib/accounts/http";
import { getAppDatabase } from "@/lib/auth";
import { getPublicationStore } from "@/lib/publications/server";
import { TopicError } from "@/lib/topics/types";
import { reviewDraft } from "@/lib/watch/drafting";
import { agentFormat } from "@/lib/watch/format-store";
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
    const db = getAppDatabase();
    const limits = agentFormat(db, { owner, watch: await accounts.watchPolicy(owner, id) });
    if (!limits.ok) throw new TopicError(`Limites de publication incohérentes : ${limits.problems.join(" ")}`, 409);
    return reviewDraft({ db, publications: await getPublicationStore(), owner, agentId: id, draftId, input: await body(request, 64_000), format: limits.format });
  });
}
