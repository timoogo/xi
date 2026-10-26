import { accountResponse, body } from "@/lib/accounts/http";
import { getAppDatabase } from "@/lib/auth";
import { getTopicStore } from "@/lib/topics/server";
import { sourceDetail, updateSource } from "@/lib/watch/source-admin";
import { getWatchServices } from "@/lib/watch/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deps = async (accounts: Parameters<Parameters<typeof accountResponse>[1]>[0]) =>
  ({ db: getAppDatabase(), accounts, topics: await getTopicStore(), sources: (await getWatchServices()).sources });

/** One source of the owner: catalogue entry, history, collector, trust, latest articles. Others' sources are 404. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return accountResponse(request, async (accounts, owner) => sourceDetail(await deps(accounts), owner, (await params).id));
}
/** Owner decision on a source: `{ action: approve|reject|reset|disable|enable|delete|update, revision, note?, edits? }`. Others' sources are 404. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return accountResponse(request, async (accounts, owner) => updateSource(await deps(accounts), owner, (await params).id, await body(request, 8_192)));
}
