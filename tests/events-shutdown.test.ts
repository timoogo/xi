import assert from "node:assert/strict";
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
