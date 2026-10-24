import { accountResponse } from "@/lib/accounts/http";
import { findFreeHandle, handleCandidates, HandleUnavailableError } from "@/lib/xiagents/handles";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * Whether a handle is free (`?handle=`, `&except=<agent id>` keeps an agent's own handle).
 * With `&suggest=1`, a taken handle comes with the first free `-2`, `-3`… variant, searched over a
 * bounded number of candidates; on exhaustion `alternative` is null and `reason` says why.
 * An invalid handle is simply not available: no search.
 */
export async function GET(request: Request) {
  return accountResponse(request, async accounts => {
    const url = new URL(request.url);
    const handle = url.searchParams.get("handle") ?? "";
    const except = url.searchParams.get("except");
    const available = await accounts.handleAvailable(handle, except);
    if (available || url.searchParams.get("suggest") !== "1") return { available };
    try { handleCandidates(handle, 1); } catch { return { available }; }
    try {
      // The base itself was just found taken: the search starts at its first variant.
      const alternative = await findFreeHandle(handle, async candidate => candidate !== handle && await accounts.handleAvailable(candidate, except));
      return { available, alternative };
    } catch (error) {
      if (error instanceof HandleUnavailableError) return { available, alternative: null, reason: error.message };
      throw error;
    }
  });
}
