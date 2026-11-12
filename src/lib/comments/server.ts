import { randomUUID } from "node:crypto";
import { getAppDatabase } from "@/lib/auth";
import { getAccountStore } from "@/lib/accounts/server";
import { getLLMRuntime } from "@/lib/llm/server";
import { agentLLMSettings } from "@/lib/watch/llm-binding";
import { getPublicationStore } from "@/lib/publications/server";
import { conversationContext, shouldAgentReply } from "./conversation";
import { addCommentTopics, migrateCommentTopics } from "./topics";
import { getSystemTasks } from "@/lib/system-agents/server";
import { extendSequence, migrateSequences, queueMentions, reserveSequence } from "./sequences";

export type Comment = { id: string; publication: string; parent: string | null; root: string; owner: string; author: string; agent: string | null; body: string; state: string; created: number };
const globalState = globalThis as typeof globalThis & { xiCommentInit?: boolean; xiCommentSequencesInit?: boolean; xiCommentRunning?: Set<string> };
const running = globalState.xiCommentRunning ??= new Set();
function db() {
  const database = getAppDatabase();
  database.exec(`CREATE TABLE IF NOT EXISTS xi_comment (id TEXT PRIMARY KEY, publication TEXT NOT NULL, parent TEXT, root TEXT NOT NULL, owner TEXT NOT NULL, author TEXT NOT NULL, agent TEXT, body TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS xi_comment_publication ON xi_comment(publication, created);
    CREATE INDEX IF NOT EXISTS xi_comment_parent ON xi_comment(publication, parent, created);
    CREATE TABLE IF NOT EXISTS xi_comment_chain (root TEXT PRIMARY KEY, allowance INTEGER NOT NULL)`);
  migrateCommentTopics(database);
  if (!globalState.xiCommentSequencesInit) {
    migrateSequences(database);
    globalState.xiCommentSequencesInit = true;
  }
  if (!globalState.xiCommentInit) {
    database.prepare("UPDATE xi_comment SET state = 'error' WHERE state = 'running'").run();
    globalState.xiCommentInit = true;
  }
  return database;
}
export function getComment(publication: string, id: string) {
  return db().prepare("SELECT * FROM xi_comment WHERE publication = ? AND id = ? AND state NOT IN ('waiting', 'skipped')").get(publication, id) as Comment | undefined;
}
export function listComments(publication: string, focus?: string) {
  const database = db();
  const comments = (focus ? database.prepare(`WITH RECURSIVE
    ancestors(id, parent) AS (SELECT id, parent FROM xi_comment WHERE publication = @publication AND id = @focus UNION SELECT c.id, c.parent FROM xi_comment c JOIN ancestors a ON c.id = a.parent WHERE c.publication = @publication),
    descendants(id) AS (SELECT id FROM xi_comment WHERE publication = @publication AND id = @focus UNION SELECT c.id FROM xi_comment c JOIN descendants d ON c.parent = d.id WHERE c.publication = @publication)
    SELECT c.* FROM xi_comment c WHERE c.publication = @publication AND (c.id IN (SELECT id FROM ancestors) OR c.id IN (SELECT id FROM descendants)) ORDER BY c.created, c.rowid`).all({ publication, focus })
    : database.prepare("SELECT * FROM xi_comment WHERE publication = ? ORDER BY created, rowid").all(publication)) as Comment[];
  const ids = JSON.stringify(comments.map(comment => comment.id));
  const sequences = database.prepare("SELECT comment_id, sequence_id FROM xi_comment_sequence WHERE comment_id IN (SELECT value FROM json_each(?))").all(ids) as { comment_id: string; sequence_id: string }[];
  const topicLinks = database.prepare("SELECT t.comment_id, t.source_id, t.owner, t.tag, t.topic_id, t.state, t.request_id FROM xi_comment_topic t WHERE t.comment_id IN (SELECT value FROM json_each(?))").all(ids) as TopicLink[];
  for (const row of topicLinks) if (row.comment_id === row.source_id && row.state === "pending") void requestTopic(row);
  return { comments, sequences, topicLinks };
}
type TopicLink = { comment_id: string; source_id: string; owner: string; tag: string; topic_id: string | null; state: string; request_id: string };
async function requestTopic(row: TopicLink) {
  try {
    const { request } = await (await getSystemTasks()).request(row.owner, "konstruktor", { requestId: row.request_id, task: "comment-topic", input: { commentId: row.source_id, tag: row.tag, requestId: row.request_id } }, { internal: true, trigger: "review" });
    if (request.state === "failed") db().prepare("UPDATE xi_comment_topic SET state = 'error' WHERE source_id = ? AND tag = ? AND request_id = ?").run(row.source_id, row.tag, row.request_id);
  } catch { db().prepare("UPDATE xi_comment_topic SET state = 'error' WHERE source_id = ? AND tag = ? AND request_id = ?").run(row.source_id, row.tag, row.request_id); }
}
export function retryTopic(publication: string, commentId: string, tag: string, owner: string) {
  const database = db();
  const row = database.prepare("SELECT t.* FROM xi_comment_topic t JOIN xi_comment c ON c.id = t.comment_id WHERE c.publication = ? AND t.comment_id = ? AND t.source_id = ? AND t.tag = ? AND t.owner = ? AND t.state = 'error'").get(publication, commentId, commentId, tag, owner) as TopicLink | undefined;
  if (!row) throw new Error("Demande de topic indisponible.");
  const requestId = randomUUID();
  database.prepare("UPDATE xi_comment_topic SET state = 'pending', request_id = ? WHERE source_id = ? AND tag = ?").run(requestId, commentId, tag);
  void requestTopic({ ...row, state: "pending", request_id: requestId });
}
async function agentsFor(owner: string) {
  const store = await getAccountStore();
  const [agents, accounts] = await Promise.all([store.watchAgents(), store.list(owner)]);
  return agents.flatMap(agent => {
    const account = accounts.find(item => item.id === agent.id);
    if (!account) return [];
    // A public agent owned by someone else uses the requester's model, not the other owner's private configuration.
    return [{ agent: agent.owner === owner ? agent : { ...agent, modelRef: null, llm: undefined, profile: null }, name: account.name }];
  });
}
function mentions(text: string, agents: Awaited<ReturnType<typeof agentsFor>>) {
  const handles = new Set(Array.from(text.matchAll(/(?:^|[^\w@])@([\w.-]+)/g), match => match[1].replace(/[.-]+$/, "").toLowerCase()));
  return agents.filter(({ agent }) => handles.has(agent.handle.replace(/^@/, "").toLowerCase()));
}
async function enqueue(parent: Comment) {
  const agents = mentions(parent.body, await agentsFor(parent.owner)).filter(({ agent }) => agent.id !== parent.agent);
  const database = db();
  queueMentions(database, parent, agents.map(({ agent, name }) => ({ id: agent.id, name })), id => addCommentTopics(database, id, parent.id, parent.owner, null));
  dispatch(sequenceOf(parent.id));
}
function sequenceOf(commentId: string) {
  return (db().prepare("SELECT sequence_id FROM xi_comment_sequence WHERE comment_id = ?").get(commentId) as { sequence_id: string }).sequence_id;
}
function dispatch(sequence: string) {
  const database = db();
  const ids = reserveSequence(database, sequence);
  for (const id of ids) { running.add(id); void generate(id); }
}
async function generate(id: string) {
  const database = db();
  const comment = database.prepare("SELECT * FROM xi_comment WHERE id = ?").get(id) as Comment;
  try {
    const entry = (await agentsFor(comment.owner)).find(item => item.agent.id === comment.agent);
    if (!entry) throw new Error("Agent indisponible.");
    const publication = await (await getPublicationStore()).get({ id: comment.owner }, comment.publication);
    const parent = database.prepare("SELECT * FROM xi_comment WHERE id = ?").get(comment.parent) as Comment;
    const history = database.prepare("SELECT * FROM xi_comment WHERE root = ? AND state = 'done' ORDER BY created, rowid").all(comment.root) as Comment[];
    const context = conversationContext(publication.messages.filter(message => !message.deleted).map(message => message.body).join("\n"), history, parent);
    const system = `Tu es ${entry.name} (@${entry.agent.handle.replace(/^@/, "")}), un ΞAgent. Périmètre : ${entry.agent.profile?.perimeter ?? "non précisé"}. Consignes : ${entry.agent.profile?.charter ?? "aucune"}.`;
    const runtime = getLLMRuntime();
    const settings = agentLLMSettings(entry.agent);
    if (parent.agent) {
      const binding = runtime.bind(comment.owner, settings);
      if (!binding.ok) throw new Error(binding.message);
      if (!await shouldAgentReply(binding.inference, binding.resolved.model, system, context)) {
        database.prepare("UPDATE xi_comment SET state = 'skipped' WHERE id = ?").run(id);
        return;
      }
    }
    const prompt = `${context}\n\nRéponds directement à la dernière sollicitation, dans le contexte de la publication et de tous les commentaires ci-dessus. Apporte un élément précis et utile, sans répéter ce qui a déjà été dit ; reconnais les limites de tes connaissances. Ne mentionne un autre ΞAgent que si une question précise relevant de son rôle justifie son intervention. Ne demande pas de réaction par politesse et termine naturellement si rien ne reste à ajouter.`;
    const result = await runtime.streamChat(comment.owner, settings, system, prompt, text => database.prepare("UPDATE xi_comment SET body = ? WHERE id = ?").run(text, id));
    database.prepare("UPDATE xi_comment SET body = ?, state = 'done' WHERE id = ?").run(result, id);
    await enqueue({ ...comment, body: result, state: "done" });
  } catch { database.prepare("UPDATE xi_comment SET state = 'error' WHERE id = ?").run(id); }
  finally { running.delete(id); dispatch(sequenceOf(id)); }
}
export async function addComment(publication: string, owner: string, author: string, body: string, parentId: string | null) {
  const database = db();
  const parent = parentId ? database.prepare("SELECT * FROM xi_comment WHERE id = ? AND publication = ?").get(parentId, publication) as Comment | undefined : null;
  if (parentId && !parent) throw new Error("Commentaire parent introuvable.");
  const id = randomUUID(), root = parent?.root ?? id;
  database.transaction(() => {
    if (!parent) database.prepare("INSERT INTO xi_comment_chain VALUES (?, 10)").run(root);
    database.prepare("INSERT INTO xi_comment VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'done', ?)").run(id, publication, parentId, root, owner, author, body, Date.now());
    database.prepare("INSERT INTO xi_agent_sequence VALUES (?, 10)").run(id);
    database.prepare("INSERT INTO xi_comment_sequence VALUES (?, ?)").run(id, id);
    addCommentTopics(database, id, parentId, owner, body);
  })();
  for (const row of database.prepare("SELECT * FROM xi_comment_topic WHERE source_id = ? AND comment_id = ? AND state = 'pending'").all(id, id) as TopicLink[]) void requestTopic(row);
  const comment = database.prepare("SELECT * FROM xi_comment WHERE id = ?").get(id) as Comment;
  await enqueue(comment);
}
export function continueChain(publication: string, sequence: string, owner: string) {
  if (!extendSequence(db(), publication, sequence, owner)) throw new Error("Aucune séquence arrivée à sa limite.");
  dispatch(sequence);
}
export function retry(publication: string, id: string, owner: string) {
  const database = db();
  const row = database.prepare("SELECT * FROM xi_comment WHERE publication = ? AND id = ? AND owner = ? AND state = 'error'").get(publication, id, owner) as Comment | undefined;
  if (!row || running.has(id)) throw new Error("Réponse indisponible.");
  database.prepare("UPDATE xi_comment SET state = 'running', body = '' WHERE id = ?").run(id);
  running.add(id); void generate(id);
}
