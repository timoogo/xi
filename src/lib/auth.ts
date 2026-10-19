import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function createAuth() {
  const secret = process.env.BETTER_AUTH_SECRET;
  const baseURL = process.env.BETTER_AUTH_URL;
  if (!secret || secret.length < 32) throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters.");
  if (!baseURL) throw new Error("BETTER_AUTH_URL is required.");
  const url = new URL(baseURL);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("BETTER_AUTH_URL must use HTTPS except on localhost.");
  }
  const databasePath = resolve(process.env.AUTH_DATABASE_PATH || "./data/xi-auth.sqlite");
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  const auth = betterAuth({
    appName: "Xi",
    baseURL: url.origin,
    secret,
    database,
    emailAndPassword: { enabled: true, autoSignIn: true, minPasswordLength: 8, maxPasswordLength: 128 },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24, cookieCache: { enabled: false } },
    advanced: { cookiePrefix: "xi" },
    rateLimit: { enabled: true, storage: "database" },
    telemetry: { enabled: false },
    plugins: [nextCookies()],
  });
  return { auth, database };
}

// Lazy initialization keeps builds independent of runtime secrets and databases.
const authGlobal = globalThis as typeof globalThis & { xiAuth?: ReturnType<typeof createAuth> };
export function getAuth() {
  authGlobal.xiAuth ??= createAuth();
  return authGlobal.xiAuth.auth;
}

/** The same SQLite connection also holds the publication index. */
export function getAppDatabase() {
  authGlobal.xiAuth ??= createAuth();
  return authGlobal.xiAuth.database;
}
