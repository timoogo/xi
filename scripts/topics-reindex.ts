import { resolve } from "node:path";
import Database from "better-sqlite3";
import { openVault, vaultPathFromEnv } from "../src/lib/publications/vault";
import { createTopicStore } from "../src/lib/topics/store";
async function main() {
  const vault = await openVault(vaultPathFromEnv());
  const db = new Database(resolve(process.env.AUTH_DATABASE_PATH || "./data/xi-auth.sqlite"), { fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    const topics = await createTopicStore({ vault, db }).reindex();
    console.log(`${topics.length} topics réindexés depuis Markdown.`);
  } finally { db.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Réindexation impossible."); process.exitCode = 1; });
