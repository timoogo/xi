import Database from "better-sqlite3";
import { join } from "node:path";
import { TopicError } from "./types";

/** Dedicated SQLite connection: OS releases this cross-process lock even after a crash.
 * This file contains no application data and is separate from the reconstructible index. */
export async function locked<T>(directory: string, task: () => Promise<T>): Promise<T> {
  const lock = new Database(join(directory, ".writer-lock.sqlite"));
  lock.pragma("busy_timeout = 0");
  const deadline = Date.now() + 10_000;
  try {
    for (;;) {
      try { lock.exec("BEGIN IMMEDIATE"); break; }
      catch (error) {
        if ((error as { code?: string }).code !== "SQLITE_BUSY") throw error;
        if (Date.now() > deadline) throw new TopicError("Une opération est en cours. Réessayez.", 409);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    return await task();
  } finally {
    if (lock.inTransaction) lock.exec("ROLLBACK");
    lock.close();
  }
}
