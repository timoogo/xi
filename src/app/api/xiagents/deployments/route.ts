import { z } from "zod";
import { accountResponse, body } from "@/lib/accounts/http";
import { getDeployments } from "@/lib/xiagents/services";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The session user's deployments, most recent first. */
export async function GET(request: Request) {
  return accountResponse(request, async (_, owner) => ({ deployments: await (await getDeployments()).list(owner) }));
}
/** Creates a deployment (idempotent on the client-generated `id`); it runs with `POST …/<id>` `{ action: "run" }`. */
export async function POST(request: Request) {
  return accountResponse(request, async (_, owner) => {
    const data = z.object({ id: z.uuid(), spec: z.unknown() }).strict().parse(await body(request, 128_000));
    return { deployment: await (await getDeployments()).create(owner, data.id, data.spec) };
  });
}
