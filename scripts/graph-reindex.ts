// `pnpm graph:reindex`: drops every derived index table (never Better Auth's) and rebuilds them from the vault.
// Reads XI_VAULT_PATH and AUTH_DATABASE_PATH from .env.local. Only SQLite is written; vault files are never modified.
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { createGraphRepository } from "../src/lib/graph/repository";
import { createPublicationStore } from "../src/lib/publications/store";
import { openVault, vaultPathFromEnv } from "../src/lib/publications/vault";

async function main() {
  const vault = await openVault(vaultPathFromEnv());
  // The database must already exist (pnpm db:migrate): the index lives next to the Better Auth tables.
  const db = new Database(resolve(process.env.AUTH_DATABASE_PATH || "./data/xi-auth.sqlite"), { fileMustExist: true });
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    const publications = createPublicationStore({ vault, db });
    const repository = createGraphRepository({ vault, db, publications });
    await repository.rebuild();
    const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    console.log(`Index rebuilt: ${count("publication")} publications, ${count("publication_message")} messages, `
      + `${count("graph_generator")} generator files, ${count("graph_relation")} relation files.`);
  } finally {
    db.close();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Index rebuild failed.");
  process.exitCode = 1;
});
