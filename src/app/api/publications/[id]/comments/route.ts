import { z } from "zod";
import { getAppDatabase, getAuth } from "@/lib/auth";
import { getViewer, getPublicationStore, getFeedAuthors } from "@/lib/publications/server";
import { privateJson } from "@/lib/publications/http";
import { body } from "@/lib/topics/http";
import { addComment, continueChain, getComment, listComments, retry, retryTopic } from "@/lib/comments/server";
import { getAccountStore } from "@/lib/accounts/server";
import { getTopicStore } from "@/lib/topics/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const input = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add"), body: z.string().trim().min(1).max(10000), parent: z.string().uuid().nullable() }).strict(),
  z.object({ action: z.literal("continue"), root: z.string().uuid() }).strict(),
  z.object({ action: z.literal("retry"), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("retry-topic"), id: z.string().uuid(), tag: z.string().min(1).max(180) }).strict(),
]);
async function handle(request: Request, context: { params: Promise<{ id: string }> }) {
  const viewer = await getViewer();
  if (!viewer) return privateJson({ error: "Session requise." }, 401);
  if (request.method !== "GET" && request.headers.get("origin") !== new URL(getAuth().options.baseURL!).origin) return privateJson({ error: "Origine refusée." }, 403);
  const { id } = await context.params;
  try { await (await getPublicationStore()).get(viewer, id); } catch { return privateJson({ error: "Publication indisponible." }, 404); }
  const focus = new URL(request.url).searchParams.get("focus");
  if (focus && (!z.uuid().safeParse(focus).success || !getComment(id, focus))) return privateJson({ error: "Commentaire indisponible." }, 404);
  try {
    if (request.method === "POST") {
      const data = input.parse(await body(request));
      if (data.action === "add") {
        const session = await getAuth().api.getSession({ headers: request.headers });
        await addComment(id, viewer.id, session?.user.name || "Utilisateur", data.body, data.parent);
      } else if (data.action === "continue") continueChain(id, data.root, viewer.id);
      else if (data.action === "retry-topic") retryTopic(id, data.id, data.tag, viewer.id);
      else retry(id, data.id, viewer.id);
    }
    const result = listComments(id, focus ?? undefined);
    const visibleAgents = await (await getAccountStore()).list(viewer.id);
    const identities = await getFeedAuthors(viewer, [viewer.id, ...visibleAgents.map(agent => agent.id), ...result.comments.map(comment => comment.agent ?? comment.owner)]);
    const agents = visibleAgents.map(({ id, name, handle }) => ({ id, name, handle, bloub: identities.get(id)?.bloub }));
    const { shared, personal } = await (await getTopicStore()).visible(viewer.id);
    const visibleTopics = [...personal, ...shared];
    const topics = visibleTopics.map(({ id, tag, aliases }) => ({ id, tag, aliases }));
    const allowed = new Set(visibleTopics.map(topic => topic.id));
    const topicLinks = result.topicLinks.filter(row => row.topic_id ? allowed.has(row.topic_id) : row.owner === viewer.id).map(({ comment_id, source_id, tag, topic_id, state, owner }) => ({ comment_id, source_id, tag, topic_id, state, owned: owner === viewer.id }));
    const declaredTopics = (getAppDatabase().prepare("SELECT topic_id FROM publication_topic WHERE publication_id = ? AND origin = 'declared'").all(id) as { topic_id: string }[]).map(row => row.topic_id).filter(topic => allowed.has(topic));
    return privateJson({ ...result, topicLinks, declaredTopics, agents, knownAgents: visibleAgents.map(({ handle }) => handle), topics, identities: Object.fromEntries(identities) });
  } catch (error) { return privateJson({ error: error instanceof z.ZodError ? "Données invalides." : error instanceof Error ? error.message : "Erreur inattendue." }, 400); }
}
export const GET = handle;
export const POST = handle;
