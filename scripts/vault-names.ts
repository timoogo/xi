import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { applyVaultNames, planVaultNames } from "../src/lib/maintenance/vault-names";
import { openVault } from "../src/lib/publications/vault";

/**
 * Readable file names for an existing vault (see src/lib/maintenance/vault-names.ts). Without --apply, prints the plan
 * and changes nothing. With --apply (app and worker stopped), backs up the vault into --backup (a new folder outside
 * the vault) and renames. Content revisions are kept: nothing is analysed again, the database is not touched.
 * Usage: tsx --env-file-if-exists=.env.local scripts/vault-names.ts [--vault path] [--apply --backup dir]
 */
async function main() {
  const { values } = parseArgs({ options: { vault: { type: "string" }, apply: { type: "boolean", default: false }, backup: { type: "string" } } });
  const path = values.vault ?? process.env.XI_VAULT_PATH;
  if (!path) throw new Error("Vault introuvable : indiquez --vault ou XI_VAULT_PATH.");
  const { root } = await openVault(path);
  if (!values.apply) {
    const plan = await planVaultNames(root);
    console.log(JSON.stringify({ dryRun: true, ...plan }, null, 2));
    return;
  }
  if (!values.backup) throw new Error("--apply exige --backup <dossier neuf hors du vault>.");
  const result = await applyVaultNames(root, { backupDir: resolve(values.backup) });
  console.log(JSON.stringify({ applied: true, ...result }, null, 2));
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : "Renommage impossible.");
  process.exitCode = 1;
});
