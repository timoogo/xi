import { accountResponse, body } from "@/lib/accounts/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Owner-only Bloub appearance of a ΞAgent: `{ revision, config }`; foreign or unknown agents are 404. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return accountResponse(request, async (accounts, owner) => accounts.avatar(owner, (await params).id));
}
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return accountResponse(request, async (accounts, owner) => accounts.setAvatar(owner, (await params).id, await body(request, 1_024)));
}
