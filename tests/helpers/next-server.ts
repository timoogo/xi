import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseEnv, promisify } from "node:util";

const require = createRequire(import.meta.url);
const exec = promisify(execFile);

/** Files Next loads in production; a variable already set, even empty, wins over them. */
const PROJECT_ENV_FILES = [".env", ".env.production", ".env.local", ".env.production.local"];
async function projectEnvKeys() {
  const files = await Promise.all(PROJECT_ENV_FILES.map(file => readFile(file, "utf8").catch(() => "")));
  return [...new Set(files.flatMap(content => Object.keys(parseEnv(content))))];
}

/**
 * A production `next start` of the current build, on a free port, with a temporary SQLite base and
 * vault. The developer's local configuration (.env.local: model server, automatic publication…)
 * never leaks in: each variable of the project's env files is blanked unless set below or in `overrides`.
 */
export async function createTestServer(overrides: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "xi-test-"));
  const databasePath = join(directory, "auth.sqlite");
  const vaultPath = join(directory, "vault");
  await mkdir(vaultPath);
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const blank = Object.fromEntries((await projectEnvKeys()).map(key => [key, ""]));
  const env: NodeJS.ProcessEnv = { ...process.env, ...blank, ...overrides, NODE_ENV: "production", BETTER_AUTH_SECRET: randomBytes(32).toString("hex"), BETTER_AUTH_URL: origin, AUTH_DATABASE_PATH: databasePath, XI_VAULT_PATH: vaultPath };
  let server: ChildProcess | undefined;
  let output = "";

  async function stop() {
    if (server && server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      await exited;
    }
    server = undefined;
  }
  async function migrate() {
    await exec(process.execPath, ["--import", "tsx", "scripts/migrate-auth.ts"], { env });
  }
  async function start() {
    output = "";
    server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout?.on("data", (data) => { output = (output + data).slice(-5000); });
    server.stderr?.on("data", (data) => { output = (output + data).slice(-5000); });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null) throw new Error(`Next.js exited: ${output}`);
      try {
        const response = await fetch(`${origin}/api/auth/get-session`);
        if (response.ok) return;
      } catch { /* Wait for the local server to bind. */ }
      await delay(100);
    }
    throw new Error(`Next.js did not start: ${output}`);
  }
  async function dispose() {
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
  return { origin, databasePath, vaultPath, migrate, start, stop, dispose, output: () => output };
}
