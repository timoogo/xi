import { z } from "zod";
import { accountResponse, body } from "@/lib/accounts/http";
import { getTopicStore } from "@/lib/topics/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return accountResponse(request, async (store, owner) => ({ accounts: (await store.list(owner)).filter(account => account.owner === owner), presets: await store.listPresets(owner), topics: await (await getTopicStore()).list() })); }
export async function PATCH(request: Request) { return accountResponse(request, async (store, owner) => { const data = z.object({ id: z.uuid(), revision: z.uuid().nullable(), draft: z.unknown() }).strict().parse(await body(request)); return { account: await store.update(owner, data.id, data.revision, data.draft) }; }); }
