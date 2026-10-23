import { accountResponse, body } from "@/lib/accounts/http";
import { getTopicStore } from "@/lib/topics/server";
import { getPublicationStore } from "@/lib/publications/server";
import { manualPublication } from "@/lib/xiagents/manual-publication";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return accountResponse(request, async (accounts, owner) => manualPublication(accounts, await getTopicStore(), await getPublicationStore(), owner, (await params).id, await body(request, 512_000)));
}
