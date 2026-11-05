import { createAuth } from "../src/lib/auth";
import { instanceOwner, recoverInstanceOwner } from "../src/lib/system-agents/owner";
import { TopicError } from "../src/lib/topics/types";

/**
 * Local administration of the instance owner (never exposed over HTTP):
 * - `show`: recorded owner and whether its account still exists;
 * - `recover <email>`: explicit recovery, only when the recorded owner's account no longer exists.
 */
function main() {
  const [command, email] = process.argv.slice(2);
  const { database } = createAuth();
  try {
    if (command === "show") {
      const owner = instanceOwner(database);
      if (owner.status === "uninitialized") console.log("Aucun propriétaire : aucun compte n’existe encore. Le premier compte créé le deviendra.");
      else console.log(JSON.stringify({ status: owner.status, ownerId: owner.ownerId, source: owner.source, initializedAt: new Date(owner.initializedAt).toISOString(), updatedAt: new Date(owner.updatedAt).toISOString() }, null, 2));
      if (owner.status === "missing") console.log("Le compte propriétaire n’existe plus : configuration des agents systèmes bloquée. Récupération : pnpm instance:owner recover <email>");
    } else if (command === "recover" && email) {
      const { ownerId, previousOwnerId } = recoverInstanceOwner(database, email);
      console.log(`Propriétaire de l’instance : ${ownerId} (précédent : ${previousOwnerId ?? "aucun"}).`);
    } else {
      console.error("Usage : instance-owner show | recover <email>");
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(error instanceof TopicError ? error.message : "Opération impossible.");
    process.exitCode = 1;
  } finally {
    database.close();
  }
}
main();
