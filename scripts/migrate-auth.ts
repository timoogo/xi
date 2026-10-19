import { getMigrations } from "better-auth/db/migration";
import { createAuth } from "../src/lib/auth";
import { migratePublicationIndex } from "../src/lib/publications/index-db";

async function main() {
  const { auth, database } = createAuth();
  try {
    const migrations = await getMigrations(auth.options);
    await migrations.runMigrations();
    migratePublicationIndex(database);
    console.log("SQLite authentication and publication index schemas are up to date.");
  } finally {
    database.close();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "SQLite initialization failed.");
  process.exitCode = 1;
});
