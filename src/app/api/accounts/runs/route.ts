import { z } from "zod";
import { accountResponse, body } from "@/lib/accounts/http";
export const runtime = "nodejs";
export async function POST(request: Request) { return accountResponse(request, async (store, owner) => { const data = z.object({ topicId: z.uuid() }).strict().parse(await body(request)); return { run: await store.propose(owner, data.topicId) }; }); }
