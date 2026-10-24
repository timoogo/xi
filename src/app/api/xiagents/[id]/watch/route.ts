import { accountResponse, body } from "@/lib/accounts/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Owner-only watch policy of a ΞAgent: `{ revision, policy }`; foreign or unknown agents are 404. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return accountResponse(request, async (accounts, owner) => accounts.watchPolicy(owner, (await params).id));
}
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return accountResponse(request, async (accounts, owner) => accounts.setWatchPolicy(owner, (await params).id, await body(request, 4_096)));
}
