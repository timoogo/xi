import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkMigrationOnCopy } from "../src/lib/maintenance/migration-check";

/**
 * Migration rehearsal: copies the SQLite database (online backup, source opened read-only) and the
 * vault into a temporary directory, migrates the copy twice and checks it. The originals are never
 * written. Usage: pnpm db:migration-check [--database path] [--vault path] [--work dir] [--keep]
 */
async function main() {
  const { values } = parseArgs({ options: { database: { type: "string" }, vault: { type: "string" }, work: { type: "string" }, keep: { type: "boolean", default: false } } });
  const database = resolve(values.database ?? process.env.AUTH_DATABASE_PATH ?? "./data/xi-auth.sqlite");
  const vault = values.vault ?? process.env.XI_VAULT_PATH;
  if (!vault) throw new Error("Vault introuvable : indiquez --vault ou XI_VAULT_PATH.");
  const work = values.work ? resolve(values.work) : await mkdtemp(join(tmpdir(), "xi-migration-check-"));
  try {
    const report = await checkMigrationOnCopy({
      database, vault, workDir: work,
      // Better Auth's own migrations, on the copied file only.
      authMigrate: async copy => {
        process.env.AUTH_DATABASE_PATH = copy;
        const [{ getMigrations }, { createAuth }] = await Promise.all([import("better-auth/db/migration"), import("../src/lib/auth")]);
        const { auth, database: db } = createAuth();
        try { await (await getMigrations(auth.options)).runMigrations(); } finally { db.close(); }
      },
    });
    console.log(JSON.stringify({ ok: report.ok, problems: report.problems, notes: report.notes, queue: report.queue, agents: report.agents, publications: report.publications, copy: values.keep ? report.copy : undefined }, null, 2));
    if (!report.ok) process.exitCode = 1;
  } finally {
    if (!values.keep) await rm(work, { recursive: true, force: true });
  }
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : "Vérification de migration impossible.");
  process.exitCode = 1;
});
