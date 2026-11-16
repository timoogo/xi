import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import Database from "better-sqlite3";
import { createLLMRuntime } from "../src/lib/llm/server";

test("Ollama diffuse les fragments avant la fin et respecte la configuration locale", async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const server = createServer(async (_request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.write(JSON.stringify({ message: { content: "Bonjour " }, done: false }) + "\n");
    await gate;
    response.end(JSON.stringify({ message: { content: "Xi" }, done: true }) + "\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const db = new Database(":memory:");
  const runtime = createLLMRuntime({ db, env: { XI_INFERENCE_URL: `http://127.0.0.1:${address.port}`, XI_INFERENCE_MODEL: "local" } });
  try {
    let observed!: () => void;
    const first = new Promise<void>(resolve => { observed = resolve; });
    const chunks: string[] = [];
    const result = runtime.streamChat("owner", null, "system", "prompt", text => { chunks.push(text); observed(); });
    await first;
    assert.deepEqual(chunks, ["Bonjour "]);
    finish();
    assert.equal(await result, "Bonjour Xi");
    assert.deepEqual(chunks, ["Bonjour ", "Bonjour Xi"]);
  } finally { finish(); db.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
