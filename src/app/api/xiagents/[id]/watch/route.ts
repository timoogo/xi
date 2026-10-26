import { accountResponse, body } from "@/lib/accounts/http";
import { getAppDatabase } from "@/lib/auth";
import { assertAgentFormat } from "@/lib/watch/format-store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Owner-only watch policy of a ΞAgent: `{ revision, policy }`; foreign or unknown agents are 404. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return accountResponse(request, async (accounts, owner) => accounts.watchPolicy(owner, (await params).id));
}
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return accountResponse(request, async (accounts, owner) => {
    const input = await body(request, 4_096) as { policy?: { format?: unknown } } | null;
    // Overrides are checked once merged onto the owner's global limits (watch/format.ts).
    if (input?.policy?.format !== undefined) assertAgentFormat(getAppDatabase(), owner, input.policy.format);
    return accounts.setWatchPolicy(owner, (await params).id, input);
  });
}
