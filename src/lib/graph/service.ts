// Request-level orchestration: one authorized graph per request, message content only from permission-checked files.

import { excerpt } from "../publications/markdown";
import { PublicationError, type PublicationStore } from "../publications/store";
import { NUMBERED_FILE } from "../publications/vault";
import {
  buildView, generatorResolver, listConnections, parseMessageRef, publicationsToLoad,
} from "./engine";
import {
  messageNode, type AuthorSummary, type ConnectionsRequest, type ConnectionsResponse, type GraphRepository,
  type MessageData, type MessagePreview, type MessageRef, type MessageSummary, type Viewer, type ViewRequest,
  type ViewResponse,
} from "./types";

/** Unreadable and nonexistent are the same answer: callers map it to a 404. */
export class GraphNotFoundError extends Error {
  readonly code = "not_found";
  constructor() {
    super("Élément introuvable.");
  }
}

export type GraphService = ReturnType<typeof createGraphService>;

export function createGraphService({ repository, publications, authors }: {
  repository: GraphRepository;
  publications: Pick<PublicationStore, "get">;
  authors: (ids: string[], viewer?: Viewer) => Map<string, AuthorSummary> | Promise<Map<string, AuthorSummary>>;
}) {
  async function view(viewer: Viewer, request: ViewRequest): Promise<ViewResponse> {
    const graph = await repository.authorizedGraph(viewer);
    const loaded = await Promise.all(publicationsToLoad(graph, request).map(async (id) => [id, await repository.messages(viewer, id, { reconciled: true })] as const));
    const messages = new Map(loaded.flatMap(([id, list]) => (list ? [[id, list] as const] : [])));
    return buildView(graph, request, messages);
  }

  async function connections(viewer: Viewer, request: ConnectionsRequest): Promise<ConnectionsResponse> {
    const graph = await repository.authorizedGraph(viewer);
    const page = listConnections(graph, request);
    const generatorOf = generatorResolver(graph);
    const described = await repository.describeMessages(viewer, [...new Set(page.relations.flatMap((relation) => [relation.source, relation.target]))], { reconciled: true });
    const summary = (ref: MessageRef) => {
      const message = described.get(ref);
      return message && summarize(message, generatorOf(message.publicationId));
    };
    // An endpoint that became unreadable between the two reads is dropped rather than shown half-described.
    const items = page.relations.flatMap((relation) => {
      const source = summary(relation.source);
      const target = summary(relation.target);
      return source && target ? [{ id: relation.id, type: relation.type, needsReview: relation.needsReview, createdAt: relation.createdAt, source, target }] : [];
    });
    return { items, total: page.total, nextCursor: page.nextCursor };
  }

  async function preview(viewer: Viewer, rawRef: string): Promise<MessagePreview> {
    const parsed = parseMessageRef(rawRef);
    if (!parsed) throw new GraphNotFoundError();
    const { ref, publicationId, n } = parsed;
    // The body comes from the files after the store's own permission check, never from the index.
    let snapshot;
    try {
      snapshot = await publications.get(viewer, publicationId);
    } catch (error) {
      if (error instanceof PublicationError) throw new GraphNotFoundError();
      throw error;
    }
    const numberOf = (file: string) => (NUMBERED_FILE.test(file) ? parseInt(file, 10) : NaN);
    const index = snapshot.messages.findIndex((message) => numberOf(message.file) === n);
    if (index < 0) throw new GraphNotFoundError();

    const graph = await repository.authorizedGraph(viewer);
    const generatorId = generatorResolver(graph)(publicationId);
    const publication = graph.publications.find((item) => item.id === publicationId);
    // Thread neighbours are described from the files just read: same permission check, fresher than the index.
    const neighbour = (at: number): MessageSummary | null => {
      const message = snapshot.messages[at];
      const number = message && numberOf(message.file);
      if (!message || Number.isNaN(number)) return null;
      const neighbourRef = `${publicationId}/${number}`;
      return { ref: neighbourRef, nodeId: messageNode(neighbourRef), publicationId, generatorId, excerpt: excerpt(message.body), position: at + 1 };
    };
    const touching = graph.relations
      .filter((relation) => relation.source === ref || relation.target === ref)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
    const others = await repository.describeMessages(viewer, [...new Set(touching.map((relation) => (relation.source === ref ? relation.target : relation.source)))], { reconciled: true });
    const connections = touching.flatMap((relation) => {
      // Direction is relative to this message and never inverted; a self-relation reads as outgoing.
      const direction = relation.source === ref ? "outgoing" as const : "incoming" as const;
      const other = others.get(direction === "outgoing" ? relation.target : relation.source);
      return other ? [{ id: relation.id, type: relation.type, needsReview: relation.needsReview, direction, other: summarize(other, generatorResolver(graph)(other.publicationId)) }] : [];
    });

    return {
      ref, nodeId: messageNode(ref), body: snapshot.messages[index].body,
      author: (await authors([snapshot.authorId], viewer)).get(snapshot.authorId) ?? null,
      publication: {
        id: publicationId, type: snapshot.type, title: publication?.title ?? excerpt(snapshot.summary || snapshot.messages[0]?.body || "", 120),
        date: snapshot.publishedAt ?? snapshot.updatedAt, visibility: snapshot.visibility, status: snapshot.status,
      },
      position: index + 1, total: snapshot.messages.length,
      parent: neighbour(index - 1), replies: [neighbour(index + 1)].filter((item) => item !== null),
      connections, href: `/dashboard/publications/${publicationId}#m-${n}`,
    };
  }

  return { view, connections, preview };
}

function summarize(message: MessageData, generatorId: string | null): MessageSummary {
  return {
    ref: message.ref, nodeId: messageNode(message.ref), publicationId: message.publicationId, generatorId,
    excerpt: message.excerpt, position: message.position,
  };
}
