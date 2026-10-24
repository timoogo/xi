import { migrateAvatarPreferences } from "../src/lib/avatar-preferences";
import { getMigrations } from "better-auth/db/migration";
import { createAuth } from "../src/lib/auth";
import { migratePublicationIndex } from "../src/lib/publications/index-db";
import { migrateWatchJobs } from "../src/lib/watch/jobs";

async function main() {
  const { auth, database } = createAuth();
  try {
    const migrations = await getMigrations(auth.options);
    await migrations.runMigrations();
    migrateAvatarPreferences(database);
    migratePublicationIndex(database);
    migrateWatchJobs(database);
    console.log("SQLite authentication, publication index and watch queue schemas are up to date.");
  } finally {
    database.close();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "SQLite initialization failed.");
  process.exitCode = 1;
});
