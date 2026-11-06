import assert from "node:assert/strict";
import { connect } from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createTestServer } from "./helpers/next-server";

// Needs the current build (`pnpm build`). A graceful `next start` shutdown waits for every open
// response: an SSE stream accepted just before SIGTERM, still authenticating when the shutdown hook
// closed the open streams, must not register afterwards and hold the process forever.
test("SIGTERM ends the realtime streams that were still connecting", { timeout: 120_000 }, async (t) => {
  const app = await createTestServer();
  t.after(() => app.dispose());
  await app.migrate();
  await app.start();
  const signUp = await fetch(`${app.origin}/api/auth/sign-up/email`, {
    method: "POST", headers: { Origin: app.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Stream", email: "stream@example.com", password: "stream shutdown password" }),
  });
  assert.equal(signUp.status, 200);
  const cookie = signUp.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  const open = await fetch(`${app.origin}/api/events`, { headers: { Cookie: cookie } });
  assert.equal(open.status, 200);
  assert.match(open.headers.get("content-type") ?? "", /text\/event-stream/);

  // Streams connect continuously while the process stops, so some are mid-authentication at SIGTERM.
  const controller = new AbortController();
  const streams: Promise<unknown>[] = [];
  const connecting = (async () => {
    while (!controller.signal.aborted) {
      streams.push(fetch(`${app.origin}/api/events`, { headers: { Cookie: cookie }, signal: controller.signal })
        .then(response => response.body?.pipeTo(new WritableStream())).catch(() => undefined));
      await delay(2);
    }
  })();
  await delay(200);
  try {
    await app.stop(); // Throws if the process is still held 15 s after SIGTERM.
  } finally {
    controller.abort();
    await connecting;
    await Promise.all(streams);
    await open.body?.cancel().catch(() => undefined);
  }
});

// A browser preconnects sockets it may never use. Node keeps waiting for them after server.close()
// (they count as requests in progress, and headersTimeout is no longer checked): only the client
// would release the shutdown, after about 100 s for Chrome.
test("SIGTERM ends the connections that never sent a request", { timeout: 60_000 }, async (t) => {
  const app = await createTestServer();
  t.after(() => app.dispose());
  await app.migrate();
  await app.start();
  const { hostname, port } = new URL(app.origin);
  const silent = connect(Number(port), hostname);
  silent.on("error", () => undefined); // A reset instead of a FIN is fine too.
  await once(silent, "connect");
  // Accepted in order: once a later request is answered, the server holds the silent socket too.
  assert.equal((await fetch(`${app.origin}/xi.svg`)).status, 200);
  const ended = once(silent, "close");
  await app.stop(); // Throws if the process is still held 15 s after SIGTERM.
  await ended;
  assert.equal(silent.bytesRead, 0, "the server sent nothing on a connection that asked nothing");
});

// The connections ended on SIGTERM are only those the server has read nothing from: a request whose
// first bytes have arrived is kept, completed and answered before the process exits.
test("SIGTERM keeps a request that has started arriving", { timeout: 60_000 }, async (t) => {
  const app = await createTestServer();
  t.after(() => app.dispose());
  await app.migrate();
  await app.start();
  const { hostname, port } = new URL(app.origin);
  const partial = connect(Number(port), hostname);
  partial.on("error", () => undefined);
  let closed = false;
  partial.once("close", () => { closed = true; });
  let response = "";
  partial.on("data", chunk => { response += chunk; });
  await once(partial, "connect");
  partial.write(`GET /xi.svg HTTP/1.1\r\nHost: ${hostname}:${port}\r\n`);
  // Loopback delivers in order: once a later request is answered, the server has read these bytes.
  assert.equal((await fetch(`${app.origin}/xi.svg`)).status, 200);

  const stopping = app.stop();
  // Next closes the listener in the same SIGTERM dispatch as the shutdown hook: a refused connection
  // means both have run.
  for (let attempt = 0; ; attempt++) {
    const probe = connect(Number(port), hostname);
    const refused = await new Promise<boolean>(resolve => { probe.once("connect", () => resolve(false)); probe.once("error", () => resolve(true)); });
    probe.destroy();
    if (refused) break;
    assert.ok(attempt < 500, "next start still accepts connections after SIGTERM");
    await delay(10);
  }
  const answered = new Promise<void>((resolve, reject) => {
    const cut = () => reject(new Error("SIGTERM cut a request that had started arriving"));
    if (closed) return cut();
    partial.once("close", cut);
    partial.on("data", () => { if (response.includes("\r\n\r\n")) resolve(); });
  });
  partial.write("\r\n");
  await answered;
  assert.match(response, /^HTTP\/1\.1 200 /);
  partial.end();
  await stopping; // Throws if the process is still held 15 s after SIGTERM.
});
