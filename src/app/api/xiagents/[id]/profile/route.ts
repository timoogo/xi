import { accountResponse, body } from "@/lib/accounts/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Owner-only editorial perimeter and charter of a ΞAgent. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return accountResponse(request, async (accounts, owner) => ({ profile: await accounts.setProfile(owner, (await params).id, await body(request, 16_000)) }));
}
