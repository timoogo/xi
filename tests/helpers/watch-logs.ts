import { createWatchLogger } from "../../src/lib/watch/events";
const logger = createWatchLogger("info");
logger({ event: "worker.start", pending: 2, concurrency: 2, inferenceConcurrency: 1 });
logger({ event: "worker.end", done: 2 });
process.stdout.write(JSON.stringify({ done: 2 }));
