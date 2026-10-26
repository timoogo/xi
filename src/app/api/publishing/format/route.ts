import { accountResponse, body } from "@/lib/accounts/http";
import { getAppDatabase } from "@/lib/auth";
import { ownerFormat, setOwnerFormat } from "@/lib/watch/format-store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The owner's global publication limits: `{ format, revision, defaults }`; PATCH `{ revision, format }` (optimistic, 409). */
export async function GET(request: Request) {
  return accountResponse(request, async (_, owner) => ownerFormat(getAppDatabase(), owner));
}
export async function PATCH(request: Request) {
  return accountResponse(request, async (_, owner) => setOwnerFormat(getAppDatabase(), owner, await body(request, 2_000)));
}
