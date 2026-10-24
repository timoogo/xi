import { z } from "zod";
import { accountResponse, body } from "@/lib/accounts/http";
import { getDeployments } from "@/lib/xiagents/services";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  return accountResponse(request, async (_, owner) => ({ deployment: await (await getDeployments()).get(owner, (await context.params).id) }));
}
/** Runs or resumes the deployment; awaited by the request. A concurrent run gets 409 and the client keeps polling. */
export async function POST(request: Request, context: Context) {
  return accountResponse(request, async (_, owner) => {
    z.object({ action: z.literal("run") }).strict().parse(await body(request, 1_024));
    return { deployment: await (await getDeployments()).run(owner, (await context.params).id) };
  });
}
