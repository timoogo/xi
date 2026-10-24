import { accountResponse, body } from "@/lib/accounts/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Owner-only calendars of a ΞAgent: `{ revision, schedule }` with optimistic revision (409). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return accountResponse(request, async (accounts, owner) => ({ schedule: await accounts.schedule(owner, (await params).id) }));
}
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return accountResponse(request, async (accounts, owner) => ({ schedule: await accounts.setSchedule(owner, (await params).id, await body(request, 64_000)) }));
}
