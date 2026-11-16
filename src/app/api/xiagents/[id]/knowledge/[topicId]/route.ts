import { accountResponse } from "@/lib/accounts/http";
import { conceptProvenance } from "@/lib/konstruktor/knowledge-graph-data";
import { getPublicationStore } from "@/lib/publications/server";
import { getTopicRelationStore, getTopicStore } from "@/lib/topics/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Publications, quotes and web sources a concept of one of the session user's ΞAgents was extracted from. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string; topicId: string }> }) {
  return accountResponse(request, async (accounts, owner) => {
    const { id, topicId } = await params;
    const [topics, relations, publications] = await Promise.all([getTopicStore(), getTopicRelationStore(), getPublicationStore()]);
    return conceptProvenance(owner, id, topicId, { accounts, topics, relations, publications });
  });
}
