import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import type Database from "better-sqlite3";
import { z } from "zod";
import { assertWithin, fromVaultRelative, inside, PUBLICATION_ID, USER_ID, writeAtomic, type Vault } from "../publications/vault";
import { parseRelation, serializeRelation, setFields, splitMessageRef, type RelationRecord } from "./format";
import { createGraphIndex } from "./index-db";
import { resolveGenerators, type GraphRepositoryHandle } from "./repository";
import { MESSAGE_REF, SEMANTIC_TYPES, type MessageRef } from "./types";

// Write rules of semantic relations (docs/graph.md). There is deliberately no delete: a relation whose endpoint
// disappears stays in the vault and is only hidden by the repository.

export type HumanActor = { kind: "human"; userId: string };
export type AiActor = { kind: "ai"; generatorId: string };
export type Actor = HumanActor | AiActor;

export class RelationError extends Error {
  constructor(readonly code: "not_found" | "invalid" | "forbidden", message: string) {
    super(message);
  }
}

// An unreadable relation or endpoint is indistinguishable from a nonexistent one.
const notFound = () => new RelationError("not_found", "Relation ou message introuvable.");
const invalid = (message: string) => new RelationError("invalid", message);
const forbidden = (message: string) => new RelationError("forbidden", message);

const createSchema = z.object({
  type: z.enum(SEMANTIC_TYPES),
  source: z.string().regex(MESSAGE_REF),
  target: z.string().regex(MESSAGE_REF),
  note: z.string().max(10_000).optional(),
}).refine((input) => input.source !== input.target, "Une relation relie deux messages distincts.");
export type CreateRelationInput = z.input<typeof createSchema>;

export function createRelationWriter({ vault, db, repository, now = () => new Date() }: {
  vault: Vault; db: Database.Database; repository: GraphRepositoryHandle; now?: () => Date;
}) {
  const index = createGraphIndex(db);
  const relationsDir = inside(vault.root, "relations");
  const sourceAuthor = db.prepare<[string], { author_type: string; author_id: string }>(
    "SELECT author_type, author_id FROM publication WHERE id = ? AND trashed_at IS NULL");
  const duplicate = db.prepare<[string, string, number, string, number], { id: string }>(`
    SELECT id FROM graph_relation WHERE type = ? AND source_publication = ? AND source_n = ? AND target_publication = ? AND target_n = ?
      AND status != 'rejected' LIMIT 1`);
  const locks = new Map<string, Promise<unknown>>();

  function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const run = (locks.get(key) ?? Promise.resolve()).then(task);
    const tail = run.catch(() => undefined);
    locks.set(key, tail);
    void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
    return run;
  }

  async function readsBoth(userId: string, source: MessageRef, target: MessageRef) {
    const found = await repository.describeMessages({ id: userId }, [source, target]);
    return found.has(source) && found.has(target);
  }

  /** A human writes a relation only between two messages they can read, from a publication they authored. */
  async function assertHumanRule(actor: HumanActor, source: MessageRef, target: MessageRef) {
    if (!USER_ID.test(actor.userId) || !(await readsBoth(actor.userId, source, target))) throw notFound();
    const author = sourceAuthor.get(splitMessageRef(source)!.publicationId);
    if (author?.author_type !== "human" || author.author_id !== actor.userId) {
      throw forbidden("Seul l’auteur de la publication source peut établir ou valider cette relation.");
    }
  }

  /** An AI acts through an existing generator, and never beyond what that generator's owner may read. */
  async function assertAiRule(actor: AiActor, source: MessageRef, target: MessageRef) {
    if (!PUBLICATION_ID.test(actor.generatorId)) throw notFound();
    await repository.reconcile();
    const generator = resolveGenerators(index.generators()).get(actor.generatorId);
    if (!generator || !(await readsBoth(generator.owner_id, source, target))) throw notFound();
  }

  async function createRelation(actor: Actor, raw: CreateRelationInput): Promise<RelationRecord> {
    const parsed = createSchema.safeParse(raw);
    if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? "Relation invalide.");
    const input = parsed.data;
    if (actor.kind === "human") await assertHumanRule(actor, input.source, input.target);
    else await assertAiRule(actor, input.source, input.target);
    const source = splitMessageRef(input.source)!;
    const target = splitMessageRef(input.target)!;
    if (duplicate.get(input.type, source.publicationId, source.n, target.publicationId, target.n)) throw invalid("Cette relation existe déjà.");
    const at = now().toISOString();
    const human = actor.kind === "human";
    const relation: RelationRecord = {
      id: randomUUID(), type: input.type, source: input.source, target: input.target,
      // AI output is only ever a proposal waiting for a human decision.
      status: human ? "validated" : "proposed", needsReview: false, origin: actor.kind,
      createdBy: human ? actor.userId : actor.generatorId, createdAt: at,
      validatedBy: human ? actor.userId : null, validatedAt: human ? at : null,
    };
    await mkdir(relationsDir, { recursive: true, mode: 0o700 });
    // Same rule as the repository's scan: relations/ is a real folder, never a symlink (else the file would not be indexed).
    if ((await assertWithin(vault.root, relationsDir)) !== relationsDir) throw invalid("Le dossier relations/ ne peut pas être un lien symbolique.");
    await writeAtomic(inside(relationsDir, `${relation.id}.md`), serializeRelation(relation, input.note ?? ""));
    await repository.reconcile();
    return relation;
  }

  /** Re-reads the relation file itself (the index only locates it) and rewrites it, keeping unknown keys and the note. */
  async function update(id: string, change: (parsed: NonNullable<ReturnType<typeof parseRelation>>) => Promise<RelationRecord | null>) {
    if (!PUBLICATION_ID.test(id)) throw notFound();
    return withLock(id, async () => {
      await repository.reconcile();
      const row = index.relationById(id);
      if (!row) throw notFound();
      const file = fromVaultRelative(vault, row.path);
      const parsed = await assertWithin(vault.root, file)
        .then((real) => (real === file ? readFile(real, "utf8") : null)).then((content) => content === null ? null : parseRelation(content), () => null);
      if (!parsed || parsed.relation.id !== id) throw notFound();
      const next = await change(parsed);
      if (!next) return parsed.relation;
      await writeAtomic(file, serializeRelation(next, parsed.note, parsed.doc));
      await repository.reconcile();
      return next;
    });
  }

  /** Only a proposal can be decided, by a human under the authorship rule; a validated relation stays validated. */
  async function reviewRelation(actor: HumanActor, id: string, decision: "validated" | "rejected") {
    if (actor.kind !== "human") throw forbidden("Seul un humain valide ou rejette une proposition.");
    if (decision !== "validated" && decision !== "rejected") throw invalid("Décision invalide.");
    return update(id, async ({ relation, doc }) => {
      await assertHumanRule(actor, relation.source, relation.target);
      if (relation.status !== "proposed") throw invalid("Seule une proposition peut être validée ou rejetée.");
      const at = now().toISOString();
      if (decision === "rejected") {
        setFields(doc, { rejected_by: actor.userId, rejected_at: at });
        return { ...relation, status: "rejected" };
      }
      return { ...relation, status: "validated", validatedBy: actor.userId, validatedAt: at };
    });
  }

  /**
   * Flagging (true) is open to an AI generator or any human who can read both messages; it never alters status.
   * Clearing the flag is a human decision under the authorship rule.
   */
  async function setNeedsReview(actor: Actor, id: string, value: boolean) {
    if (typeof value !== "boolean") throw invalid("Valeur invalide.");
    if (actor.kind === "ai" && !value) throw forbidden("Une IA ne peut que signaler une relation à réexaminer.");
    return update(id, async ({ relation }) => {
      if (actor.kind === "ai") await assertAiRule(actor, relation.source, relation.target);
      else if (value) {
        if (!USER_ID.test(actor.userId) || !(await readsBoth(actor.userId, relation.source, relation.target))) throw notFound();
      } else await assertHumanRule(actor, relation.source, relation.target);
      return relation.needsReview === value ? null : { ...relation, needsReview: value };
    });
  }

  return { createRelation, reviewRelation, setNeedsReview };
}

export type RelationWriter = ReturnType<typeof createRelationWriter>;
