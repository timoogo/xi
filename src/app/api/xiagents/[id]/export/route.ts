import { getAccountStore } from "@/lib/accounts/server";
import { getLLMRuntime } from "@/lib/llm/server";
import { privateJson } from "@/lib/publications/http";
import { getViewer } from "@/lib/publications/server";
import { getTopicStore } from "@/lib/topics/server";
import { TopicError } from "@/lib/topics/types";
import { getWatchServices } from "@/lib/watch/server";
import { exportAgentDraft } from "@/lib/xiagents/export";
import { draftToYaml } from "@/lib/xiagents/yaml";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Owner-only portable YAML configuration of a ΞAgent (docs/xiagent-yaml.md), as an attachment. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await getViewer();
  if (!viewer) return privateJson({ error: "Session requise." }, 401);
  try {
    const [accounts, topics, { sources }] = await Promise.all([getAccountStore(), getTopicStore(), getWatchServices()]);
    const draft = await exportAgentDraft({ owner: viewer.id, agentId: (await params).id, accounts, topics, sources });
    const instances = (await getLLMRuntime()).store.list(viewer.id).map(({ id, key, name }) => ({ id, key, name }));
    const yaml = draftToYaml(draft, await topics.list(), instances);
    return new Response(yaml, {
      headers: {
        "Content-Type": "application/yaml; charset=utf-8",
        // The handle matches GENERATOR_SLUG (lowercase letters, digits, dots, hyphens): safe in the header.
        "Content-Disposition": `attachment; filename="${draft.handle}.xiagent.yaml"`,
        "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof TopicError) return privateJson({ error: error.message }, error.status);
    console.error("ΞAgent export failed", error instanceof Error ? error.name : "unknown");
    return privateJson({ error: "Export indisponible. Réessayez." }, 503);
  }
}
