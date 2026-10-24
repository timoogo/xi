import { accountResponse, body } from "@/lib/accounts/http";
import { getAppDatabase } from "@/lib/auth";
import { getWatchServices } from "@/lib/watch/server";
import { control } from "@/lib/xiagents/control";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Owner commands: pause, resume, manual run (`{ action, … }`, see lib/xiagents/control.ts). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return accountResponse(request, async (accounts, owner) => control({ db: getAppDatabase(), accounts, sources: (await getWatchServices()).sources }, owner, (await params).id, await body(request, 4_096)));
}
