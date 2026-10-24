import Database from "better-sqlite3";
import { createJobQueue } from "../../src/lib/watch/jobs";
import { createPublicationStore } from "../../src/lib/publications/store";
import { openVault } from "../../src/lib/publications/vault";

/** Separate OS process for the watch concurrency tests. Prints one JSON line. */
async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "claim") {
    // Claims and completes every due job, as fast as possible, alongside sibling processes.
    const db = new Database(args[0]);
    db.pragma("busy_timeout = 5000");
    const queue = createJobQueue(db);
    const claimed: string[] = [];
    for (let job = queue.claim(["race"], 60_000); job; job = queue.claim(["race"], 60_000)) {
      if (!queue.complete(job, process.pid)) throw new Error("lease lost");
      claimed.push(job.key);
    }
    db.close();
    console.log(JSON.stringify(claimed));
  } else if (mode === "publish") {
    // Own index database, like the worker next to the web server: only the vault is shared.
    const [vaultPath, owner, agentId, topicId, ...ids] = args;
    const store = createPublicationStore({ vault: await openVault(vaultPath), db: new Database(":memory:") });
    const results = await Promise.all(ids.map(id => store.publishGenerated({ id: owner }, agentId, { id, summary: "Test", messages: [`Message ${id}`], topicIds: [topicId] }).then(p => p.id)));
    console.log(JSON.stringify(results));
  } else throw new Error("unknown mode");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
