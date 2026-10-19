// Writes a small demo knowledge graph into a vault, for trying the graph view by hand.
//
//   pnpm exec tsx scripts/graph-seed-demo.ts <absolute vault path> <userId>
//
// - <vault path> is required and never defaults to XI_VAULT_PATH: point it at a scratch or test vault.
// - <userId> is the Better Auth id that will own the generators and author the publications.
// Creates generators/{politiks,politiks.france,politiks.international,mercatus,sciencia}/index.md, a few public
// published publications under posts/_users/<userId>/ linked with `generator:`, and relations/ (validated ones,
// one flagged needs_review, one AI proposal). Refuses to run twice on the same vault. Then run `pnpm graph:reindex`
// (or just open the app) to index it.
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Document } from "yaml";
import { parseGenerator, serializeGenerator, serializeRelation, type GeneratorRecord, type RelationRecord } from "../src/lib/graph/format";
import type { SemanticType } from "../src/lib/graph/types";
import { messageEmbedTarget, messageSlug, serializeIndex, setMeta } from "../src/lib/publications/markdown";
import { FOLDER_NAME, listDir, openVault, USER_ID, writeAtomic } from "../src/lib/publications/vault";

const GENERATORS = [
  { id: "0b6f3c1e-6f0a-4c39-9a51-6f2f0e1a0001", slug: "politiks", title: "Politiks", description: "Vie politique et institutions." },
  { id: "0b6f3c1e-6f0a-4c39-9a51-6f2f0e1a0002", slug: "politiks.france", title: "Politiks · France", description: "Politique française." },
  { id: "0b6f3c1e-6f0a-4c39-9a51-6f2f0e1a0003", slug: "politiks.international", title: "Politiks · International", description: "Relations internationales." },
  { id: "0b6f3c1e-6f0a-4c39-9a51-6f2f0e1a0004", slug: "mercatus", title: "Mercatus", description: "Économie et marchés." },
  { id: "0b6f3c1e-6f0a-4c39-9a51-6f2f0e1a0005", slug: "sciencia", title: "Sciencia", description: "Sciences et recherche." },
] as const;
type Slug = (typeof GENERATORS)[number]["slug"];

const PUBLICATIONS: { key: string; generator: Slug; summary: string; messages: string[] }[] = [
  {
    key: "retraites", generator: "politiks.france", summary: "La réforme des retraites revient au Parlement.",
    messages: ["Le gouvernement présente un nouveau calendrier pour la réforme des retraites.", "Les syndicats contestent l’âge de départ retenu."],
  },
  { key: "sommet", generator: "politiks.international", summary: "", messages: ["Le sommet européen ne tranche pas la question du financement commun."] },
  {
    key: "inflation", generator: "mercatus", summary: "Inflation et pouvoir d’achat.",
    messages: ["L’inflation ralentit pour le troisième mois consécutif.", "Les salaires réels restent inférieurs à leur niveau de 2021."],
  },
  { key: "climat", generator: "sciencia", summary: "", messages: ["Une étude relie la hausse des températures à la productivité du travail."] },
  { key: "budget", generator: "politiks", summary: "", messages: ["Le projet de budget prévoit de financer la réforme par de nouvelles économies."] },
];

// [type, source key/n, target key/n, status, needs_review]
const RELATIONS: [SemanticType, string, string, "validated" | "proposed", boolean][] = [
  ["contradicts", "retraites/2", "retraites/1", "validated", false],
  ["expands", "inflation/1", "retraites/1", "validated", false],
  ["contradicts", "sommet/1", "budget/1", "validated", false],
  ["related_to", "climat/1", "inflation/2", "validated", true],
  ["updates", "budget/1", "retraites/1", "validated", false],
  ["supports", "inflation/2", "retraites/2", "proposed", false],
];

async function main() {
  const [path, userId] = process.argv.slice(2);
  if (!path || !isAbsolute(path) || !userId || !USER_ID.test(userId)) {
    throw new Error("Usage : tsx scripts/graph-seed-demo.ts <chemin absolu du vault> <userId>");
  }
  const vault = await openVault(path);
  const generatorsDir = join(vault.root, "generators");
  for (const entry of await listDir(generatorsDir)) {
    const content = await readFile(join(generatorsDir, entry.name, "index.md"), "utf8").catch(() => "");
    const id = parseGenerator(content)?.generator.id;
    if (GENERATORS.some((generator) => generator.slug === entry.name || generator.id === id)) {
      throw new Error("Ce vault contient déjà les générateurs de démonstration : rien n’a été écrit.");
    }
  }

  const at = new Date();
  for (const generator of GENERATORS) {
    const dir = join(generatorsDir, generator.slug);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const record: GeneratorRecord = { id: generator.id, slug: generator.slug, title: generator.title, ownerId: userId, visibility: "public", createdAt: at.toISOString() };
    await writeAtomic(join(dir, "index.md"), serializeGenerator(record, generator.description));
  }

  const userDir = join(vault.postsDir, "_users", userId);
  await mkdir(userDir, { recursive: true, mode: 0o700 });
  const stamp = at.toISOString().slice(0, 10).replaceAll("-", "");
  const used = (await listDir(userDir)).map((entry) => FOLDER_NAME.exec(entry.name)).filter((match) => match?.[2] === stamp).map((match) => Number(match![3]));
  let sequence = Math.max(0, ...used);
  const ids = new Map<string, string>();
  for (const publication of PUBLICATIONS) {
    const type = publication.messages.length > 1 ? "thread" : "post";
    const folder = `${type}_${stamp}_${String(++sequence).padStart(3, "0")}`;
    const dir = join(userDir, folder);
    await mkdir(dir, { mode: 0o700 });
    const files = publication.messages.map((body, i) => `${i + 1}_${messageSlug(body)}.md`);
    for (const [i, file] of files.entries()) await writeAtomic(join(dir, file), `${publication.messages[i]}\n`);
    const id = randomUUID();
    ids.set(publication.key, id);
    const doc = new Document({});
    const date = at.toISOString();
    setMeta(doc, {
      id, type, authorType: "human", authorId: userId, status: "published", visibility: "public", createdAt: date, updatedAt: date,
      publishedAt: date, score: null,
    });
    doc.set("generator", GENERATORS.find((generator) => generator.slug === publication.generator)!.id);
    const relative = `posts/_users/${userId}/${folder}`;
    await writeAtomic(join(dir, "index.md"), serializeIndex(doc, publication.summary, files.map((file) => messageEmbedTarget(relative, file))));
  }

  const relationsDir = join(vault.root, "relations");
  await mkdir(relationsDir, { recursive: true, mode: 0o700 });
  const ref = (value: string) => `${ids.get(value.split("/")[0])}/${value.split("/")[1]}`;
  for (const [type, source, target, status, needsReview] of RELATIONS) {
    const human = status === "validated";
    const relation: RelationRecord = {
      id: randomUUID(), type, source: ref(source), target: ref(target), status, needsReview, origin: human ? "human" : "ai",
      createdBy: human ? userId : GENERATORS[3].id, createdAt: at.toISOString(),
      validatedBy: human ? userId : null, validatedAt: human ? at.toISOString() : null,
    };
    await writeAtomic(join(relationsDir, `${relation.id}.md`), serializeRelation(relation, human ? "" : "Proposition de démonstration."));
  }
  console.log(`Démo écrite : ${GENERATORS.length} générateurs, ${PUBLICATIONS.length} publications, ${RELATIONS.length} relations.`);
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Échec de l’écriture de la démo.");
  process.exitCode = 1;
});
