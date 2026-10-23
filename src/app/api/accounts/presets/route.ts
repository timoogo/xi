import { accountResponse, body } from "@/lib/accounts/http";
export const runtime = "nodejs";
export async function POST(request: Request) { return accountResponse(request, async (store, owner) => ({ preset: await store.savePreset(owner, await body(request)) })); }
