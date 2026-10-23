import { z } from "zod";
import { accountResponse, body } from "@/lib/accounts/http";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) { return accountResponse(request, async (store, owner) => ({ run: await store.getRun(owner, (await context.params).id) })); }
export async function POST(request: Request, context: Context) { return accountResponse(request, async (store, owner) => {
  const { id } = await context.params;
  const data = z.discriminatedUnion("action", [z.object({ action: z.literal("resume") }).strict(), z.object({ action: z.literal("confirm"), draft: z.unknown(), confirmed: z.boolean() }).strict()]).parse(await body(request));
  return { run: data.action === "resume" ? await store.resume(owner, id) : await store.confirm(owner, id, data.draft, data.confirmed) };
}); }
