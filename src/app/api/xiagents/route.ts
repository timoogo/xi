import { accountResponse } from "@/lib/accounts/http";
import { TopicError } from "@/lib/topics/types";
import { summariesOf } from "@/lib/xiagents/server";
import { parseCategory } from "@/lib/xiagents/summary";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** `?category=editorial` (default: the viewer's own agents) or `system` (the instance's system agents). */
export async function GET(request: Request) {
  return accountResponse(request, async (_, owner) => {
    const category = parseCategory(new URL(request.url).searchParams.get("category"));
    if (!category) throw new TopicError("Catégorie inconnue.", 400);
    return { category, agents: await summariesOf(category, owner) };
  });
}
