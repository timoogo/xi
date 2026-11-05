import { getMigrations } from "better-auth/db/migration";
import { createAuth } from "../src/lib/auth";
import { migrateSchemas } from "../src/lib/maintenance/migration-check";
import { instanceOwner } from "../src/lib/system-agents/owner";

async function main() {
  const { auth, database } = createAuth();
  try {
    const migrations = await getMigrations(auth.options);
    await migrations.runMigrations();
    // Every application schema up front (expand only, idempotent); services still migrate lazily.
    migrateSchemas(database);
    // Records the instance owner (first account) if none is recorded yet; never replaces one.
    instanceOwner(database);
    console.log("SQLite authentication and application schemas are up to date.");
  } finally {
    database.close();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "SQLite initialization failed.");
  process.exitCode = 1;
});
