import { accountResponse, body } from "@/lib/accounts/http";
import { getAppDatabase } from "@/lib/auth";
import { getLLMRuntime } from "@/lib/llm/server";
import { getPublicationStore } from "@/lib/publications/server";
import { getTopicStore } from "@/lib/topics/server";
import { agentLLMSettings } from "@/lib/watch/llm-binding";
import { generatePublication } from "@/lib/xiagents/publication-generator";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * Owner-only real publication draft (`{ format: post | thread, storyId? }`): verified information →
 * the agent's model → checks → private draft. Never publishes, never falls back to fixtures
 * (those stay on POST /api/xiagents/<id>/publications).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return accountResponse(request, async (accounts, owner) => {
    const llm = await getLLMRuntime();
    return generatePublication({ db: getAppDatabase(), accounts, topics: await getTopicStore(), publications: await getPublicationStore(), llm: agent => llm.bind(agent.owner, agentLLMSettings(agent)) }, owner, (await params).id, await body(request, 4_096));
  });
}
