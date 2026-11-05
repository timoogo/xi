import type Database from "better-sqlite3";
import { z } from "zod";
import type { AccountStore } from "../accounts/store";
import type { Preset } from "../accounts/types";
import type { SystemTasks } from "../system-agents/tasks";
import type { TopicStore } from "../topics/store";
import { TopicError, type Topic } from "../topics/types";
import type { SourceStore } from "../watch/sources";
import type { Deployment, Deployments } from "../xiagents/deployments";
import type { AgentDraft } from "../xiagents/draft";
import type { EditBase } from "../xiagents/edit";
import { exportAgentConfiguration } from "../xiagents/export";
import { loadContext, type ModelChoices } from "./context";
import { previewStateSchema, type PreviewState } from "./preview";
import { createSuggestionStore, findings, reviewRequestId, SUGGESTION_KINDS, type StoredSuggestion } from "./suggestions";
import { createConversationStore, type Decision } from "./store";
import { MAX_MESSAGE, targetSchema, type KonstruktorSession, type KonstruktorTarget, type Proposal, type ProposalStatus, type TurnStatus } from "./types";

const openSchema = z.object({ id: z.uuid(), target: targetSchema }).strict();
const sendSchema = z.object({ requestId: z.uuid(), text: z.string().trim().min(1).max(MAX_MESSAGE) }).strict();
const ids = z.array(z.uuid()).max(50);
const decideSchema = z.object({ refused: ids.default([]), reset: ids.default([]) }).strict();
const applySchema = z.object({ deploymentId: z.uuid(), spec: z.record(z.string(), z.unknown()), accepted: ids, refused: ids.default([]) }).strict();

/** What the preview starts from: the current configuration (with its revisions) or nothing to create yet. */
export type PreviewBase =
  | { kind: "agent"; draft: AgentDraft; base: EditBase }
  | { kind: "topic"; topic: Topic; editable: boolean }
  | { kind: "new-agent" | "new-topic" };
export type Configuration = PreviewBase & { catalog: Topic[]; presets: Preset[] };

/** `pending`: to review; `obsolete`: the problem is gone and nothing was decided. */
export type SuggestionStatus = "pending" | "accepted" | "refused" | "applied" | "failed" | "obsolete";
export type SuggestionView = Omit<StoredSuggestion, "agentIds" | "topicIds"> & {
  kindLabel: string; status: SuggestionStatus; target: KonstruktorTarget; proposals: { id: string; summary: string; status: ProposalStatus }[];
  agents: { id: string; handle: string }[]; topics: { id: string; tag: string }[];
};
const suggestionFilter = z.object({ type: z.enum(["agent", "topic"]), id: z.uuid() }).strict();
const suggestionAction = z.object({ action: z.enum(["refuse", "restore"]) }).strict();
const reviewPoll = z.uuid();
function suggestionStatus(stored: StoredSuggestion, proposals: Proposal[]): SuggestionStatus {
  if (proposals.some(proposal => proposal.status === "applied")) return "applied";
  if (proposals.some(proposal => proposal.status === "accepted")) return "accepted";
  if (proposals.some(proposal => proposal.status === "failed")) return "failed";
  if (proposals.length ? proposals.every(proposal => proposal.status === "refused") : stored.dismissed) return "refused";
  return stored.obsolete ? "obsolete" : "pending";
}

/**
 * Conversations with Konstruktor for the session user. Each turn is a Konstruktor `system-task`
 * (converse.ts), keyed by the client's requestId: resending it never queues a second turn.
 * Opening or listing a conversation checks that the user may read its target (404 otherwise).
 *
 * Application: the owner validates a preview, sent as a deployment spec (creation, or `edit` of the
 * existing target) with the proposals accepted and refused. The deployment (deployments.ts) is the
 * durable application log: preflight and revisions checked before anything is written, resumable,
 * idempotent on its id. Proposals take their status from it; nothing is written before validation.
 */
export function createKonstruktor({ db, tasks, accounts, topics, sources, deployments, models, now = Date.now }: {
  db: Database.Database; tasks: SystemTasks; accounts: AccountStore; topics: TopicStore; sources: SourceStore; deployments: Deployments;
  models?: (owner: string) => ModelChoices; now?: () => number;
}) {
  const conversations = createConversationStore(db, now);
  const suggestionStore = createSuggestionStore(db, now);
  const services = { accounts, topics, models };

  async function open(owner: string, input: unknown) {
    const data = openSchema.parse(input);
    const context = await loadContext(services, owner, data.target);
    return view(owner, conversations.createSession(owner, data.id, data.target, context.label).id);
  }

  async function list(owner: string, target: KonstruktorTarget) {
    await loadContext(services, owner, targetSchema.parse(target));
    return conversations.sessions(owner, target);
  }

  /** State of the last user turn, from its task (which also resumes it if it was left behind). */
  function turn(owner: string, requestId: string, answered: boolean): TurnStatus {
    if (answered) return { requestId, state: "done", message: null, retryAt: null };
    let task;
    try { task = tasks.get(owner, "konstruktor", requestId); }
    catch (error) { if (error instanceof TopicError && error.status === 404) return { requestId, state: "error", message: "Demande expirée : renvoyez votre message.", retryAt: null }; throw error; }
    if (task.state === "running") return { requestId, state: "thinking", message: null, retryAt: null };
    if (task.state === "failed") return { requestId, state: "error", message: task.message, retryAt: null };
    if (task.state === "done") return { requestId, state: "done", message: null, retryAt: null };
    const waiting = task.runs.at(-1)?.status === "waiting";
    return { requestId, state: waiting ? "unavailable" : "pending", message: waiting ? task.message : null, retryAt: waiting ? task.runAfter : null };
  }

  /** Deployment states of the session's applications (an unreadable or missing one counts as failed). */
  async function applications(owner: string, decided: Decision[]) {
    const states = new Map<string, Deployment["state"]>();
    for (const id of new Set(decided.flatMap(decision => decision.deploymentId ? [decision.deploymentId] : []))) {
      states.set(id, await deployments.get(owner, id).then(deployment => deployment.state, () => "failed" as const));
    }
    return states;
  }
  const statusOf = (decision: Decision | undefined, states: Map<string, Deployment["state"]>): ProposalStatus => {
    if (!decision) return "proposed";
    if (decision.decision === "refused") return "refused";
    const state = decision.deploymentId ? states.get(decision.deploymentId) : "failed";
    return state === "completed" ? "applied" : state === "failed" ? "failed" : "accepted";
  };

  async function view(owner: string, id: string): Promise<KonstruktorSession> {
    const session = conversations.session(owner, id);
    const history = conversations.messages(id);
    const decided = conversations.decisions(id);
    const states = await applications(owner, decided);
    const byId = new Map(decided.map(decision => [decision.proposalId, decision]));
    const last = history.findLast(message => message.role === "user");
    return {
      ...session,
      history: history.map(message => ({ ...message, proposals: message.proposals.map(proposal => ({ ...proposal, status: statusOf(byId.get(proposal.id), states), deploymentId: byId.get(proposal.id)?.deploymentId ?? null })) })),
      turn: last?.requestId ? turn(owner, last.requestId, history.some(message => message.replyTo === last.id)) : null,
      previewSaved: conversations.preview(id) !== null,
    };
  }

  /** `{ requestId, text }`: one turn at a time per conversation; the same request again is a no-op. */
  async function send(owner: string, id: string, input: unknown) {
    const session = conversations.session(owner, id);
    const data = sendSchema.parse(input);
    const current = await view(owner, session.id);
    const busy = current.turn && current.turn.requestId !== data.requestId && ["pending", "thinking", "unavailable"].includes(current.turn.state);
    if (busy) throw new TopicError("Konstruktor répond encore au message précédent.", 409);
    const { message, created } = conversations.addUserMessage(session.id, data.requestId, data.text);
    try {
      await tasks.request(owner, "konstruktor", { requestId: data.requestId, task: "converse", input: { sessionId: session.id, messageId: message.id } }, { internal: true });
    } catch (error) {
      // Refused (agent disabled, too many requests): the message is not kept unanswered.
      if (created) conversations.retract(message.id);
      throw error;
    }
    return view(owner, session.id);
  }

  /** The configuration the preview is built on, read now (with its revisions) for the session's target. */
  async function configuration(owner: string, id: string): Promise<Configuration> {
    const { target } = conversations.session(owner, id);
    const context = await loadContext(services, owner, target);
    const common = { catalog: context.catalog, presets: target.type.endsWith("agent") ? await accounts.listPresets(owner) : [] };
    if (target.type === "agent") return { kind: "agent", ...await exportAgentConfiguration({ owner, agentId: target.id, accounts, topics, sources }), ...common };
    if (target.type === "topic") {
      const topic = context.catalog.find(item => item.id === target.id)!;
      return { kind: "topic", topic, editable: topic.createdBy === owner, ...common };
    }
    return { kind: target.type, ...common };
  }

  /** The session's proposals, by id (only these may be decided on). */
  async function proposals(owner: string, id: string) {
    const current = await view(owner, id);
    return new Map(current.history.flatMap(message => message.proposals).map(proposal => [proposal.id, proposal] as [string, Proposal]));
  }
  function known(all: Map<string, Proposal>, wanted: string[]) {
    if (wanted.some(proposal => !all.has(proposal))) throw new TopicError("Proposition inconnue dans cette conversation.", 404);
    if (wanted.some(proposal => all.get(proposal)!.status === "applied")) throw new TopicError("Proposition déjà appliquée.", 409);
  }

  /** Refusing (or resetting) proposals writes nothing but the decision. */
  async function decide(owner: string, id: string, input: unknown) {
    const data = decideSchema.parse(input);
    known(await proposals(owner, id), [...data.refused, ...data.reset]);
    if (data.refused.length) conversations.decide(id, data.refused, "refused");
    if (data.reset.length) conversations.undecide(id, data.reset);
    return view(owner, id);
  }

  /**
   * Validation of the preview: the deployment is created (preflight, revisions: 409 when the target
   * changed since the preview, nothing written) and the decisions recorded with it. Running it is
   * the deployment's own call (`POST /api/xiagents/deployments/<id>`), resumable after an interruption.
   */
  async function apply(owner: string, id: string, input: unknown) {
    const session = conversations.session(owner, id);
    const data = applySchema.parse(input);
    const all = await proposals(owner, id);
    known(all, [...data.accepted, ...data.refused]);
    if (data.accepted.some(proposal => data.refused.includes(proposal))) throw new TopicError("Une proposition ne peut pas être à la fois validée et refusée.");
    const spec = data.spec as { target?: string; agentId?: string | null; topic?: { id?: string } | null };
    const target = session.target;
    const matches = target.type === "new-agent" ? spec.target === "agent" : target.type === "new-topic" ? spec.target === "topic"
      : target.type === "agent" ? spec.target === "edit" && spec.agentId === target.id && !spec.topic : spec.target === "edit" && !spec.agentId && spec.topic?.id === target.id;
    if (!matches) throw new TopicError("La configuration validée ne correspond pas à la cible de la conversation.");
    const deployment = await deployments.create(owner, data.deploymentId, data.spec);
    if (data.accepted.length) conversations.decide(id, data.accepted, "accepted", deployment.id);
    if (data.refused.length) conversations.decide(id, data.refused, "refused");
    return { deployment, session: await view(owner, id) };
  }

  /** The saved preview of the conversation (null when none): the owner's choices, never a configuration. */
  function preview(owner: string, id: string) {
    const saved = conversations.preview(conversations.session(owner, id).id);
    const state = saved && previewStateSchema.safeParse(saved.state);
    return state?.success ? { state: state.data as PreviewState, updatedAt: saved!.updatedAt } : null;
  }
  function savePreview(owner: string, id: string, input: unknown) {
    const session = conversations.session(owner, id);
    const saved = conversations.savePreview(session.id, previewStateSchema.parse(input));
    return { state: saved.state as PreviewState, updatedAt: saved.updatedAt };
  }

  // ------------------------------------------------------------ proactive suggestions (suggestions.ts)

  /** The owner's suggestions (optionally those about one ΞAgent or Topic), with their status from their conversation. */
  async function suggestions(owner: string, filter?: unknown): Promise<SuggestionView[]> {
    const only = filter ? suggestionFilter.parse(filter) : null;
    const stored = suggestionStore.list(owner).filter(item => !only || (only.type === "agent" ? item.agentIds : item.topicIds).includes(only.id));
    if (!stored.length) return [];
    const handles = new Map((await accounts.list(owner)).filter(account => account.owner === owner).map(account => [account.id, account.handle]));
    const { shared, personal } = await topics.visible(owner);
    const tags = new Map([...shared, ...personal].map(topic => [topic.id, topic.tag]));
    return Promise.all(stored.map(async ({ agentIds, topicIds, ...item }) => {
      const session = await view(owner, item.sessionId);
      const proposals = session.history.flatMap(message => message.proposals);
      return {
        ...item, kindLabel: SUGGESTION_KINDS[item.kind], status: suggestionStatus({ ...item, agentIds, topicIds }, proposals), target: session.target,
        proposals: proposals.map(proposal => ({ id: proposal.id, summary: proposal.summary, status: proposal.status })),
        agents: agentIds.flatMap(id => handles.has(id) ? [{ id, handle: handles.get(id)! }] : []),
        topics: topicIds.flatMap(id => tags.has(id) ? [{ id, tag: tags.get(id)! }] : []),
      };
    }));
  }
  /** Refuses a suggestion (its undecided proposals, recorded as decisions) or puts it back to review; never a configuration write. */
  async function decideSuggestion(owner: string, id: string, input: unknown) {
    const { action } = suggestionAction.parse(input);
    const stored = suggestionStore.get(owner, id);
    if (!stored) throw new TopicError("Suggestion introuvable.", 404);
    const proposals = (await view(owner, stored.sessionId)).history.flatMap(message => message.proposals);
    if (proposals.some(proposal => proposal.status === "applied")) throw new TopicError("Suggestion déjà appliquée.", 409);
    if (action === "refuse") {
      const open = proposals.filter(proposal => proposal.status === "proposed" || proposal.status === "failed").map(proposal => proposal.id);
      if (open.length) conversations.decide(stored.sessionId, open, "refused");
    } else {
      const refused = proposals.filter(proposal => proposal.status === "refused").map(proposal => proposal.id);
      if (refused.length) conversations.undecide(stored.sessionId, refused);
    }
    suggestionStore.dismiss(owner, id, action === "refuse");
    return (await suggestions(owner)).find(item => item.id === id)!;
  }
  /** Asks a review now (idempotent per state and day, like the worker's), run as a Konstruktor system task. */
  async function review(owner: string) {
    const found = await findings({ db, accounts, topics, sources, models }, owner, now());
    const { request } = await tasks.request(owner, "konstruktor", { requestId: reviewRequestId(owner, found, now()), task: "review", input: null }, { internal: true, trigger: "review" });
    return request;
  }
  const reviewState = (owner: string, requestId: unknown) => tasks.get(owner, "konstruktor", reviewPoll.parse(requestId));

  return { open, list, view, send, configuration, decide, apply, preview, savePreview, suggestions, decideSuggestion, review, reviewState };
}
export type Konstruktor = ReturnType<typeof createKonstruktor>;
