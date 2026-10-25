import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { bindInference } from "../src/lib/llm/inference";
import { createProviderFetch, destinationPolicyFromEnv, validateBaseUrl, type DestinationPolicy } from "../src/lib/llm/network";
import { createOllamaClient } from "../src/lib/llm/ollama";
import { BUILTIN_INFERENCE_OPTIONS, type LLMErrorCode } from "../src/lib/llm/types";
import { askJson, InferenceConfigError, InferenceOutputError, InferenceUnavailableError } from "../src/lib/watch/inference";
import { z } from "zod";

type Reply = { status?: number; body?: unknown; raw?: string; delayMs?: number; headers?: Record<string, string>; cut?: boolean };

/** Simulated Ollama server: `routes` answers by path; every request is recorded. */
async function fakeOllama(t: test.TestContext, routes: Record<string, Reply | ((body: Record<string, unknown>) => Reply)>) {
  const requests: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ method: req.method ?? "", path: req.url ?? "", body });
      const route = routes[req.url ?? ""];
      const reply = typeof route === "function" ? route(body) : route ?? { status: 404, body: { error: "404 page not found" } };
      const send = () => {
        if (reply.cut) { res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "1000" }); res.write("{\"message\": {\"con"); setTimeout(() => res.destroy(), 50); return; }
        res.writeHead(reply.status ?? 200, { "Content-Type": "application/json", ...reply.headers });
        res.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs); else send();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests };
}

const policy: DestinationPolicy = { allow: [], hosts: null };
const options = { ...BUILTIN_INFERENCE_OPTIONS, timeoutMs: 2_000 };
const chat = { model: "qwen3:1.7b", system: "système", prompt: "consigne", options, json: true };
const code = (Class: new (...args: never[]) => Error, expected: LLMErrorCode) => (error: Error) => error instanceof Class && (error as Error & { code: LLMErrorCode }).code === expected;
const closedPort = async () => {
  const closed = http.createServer();
  await new Promise<void>(resolve => closed.listen(0, "127.0.0.1", resolve));
  const port = (closed.address() as { port: number }).port;
  await new Promise(resolve => closed.close(resolve));
  return port;
};

test("ollama: version, then models with and without metadata, without loading any model", async t => {
  const server = await fakeOllama(t, {
    "/api/version": { body: { version: "0.12.3" } },
    "/api/tags": { body: { models: [
      { name: "qwen3:8b", model: "qwen3:8b", size: 5_200_000_000, modified_at: "2026-10-01T10:00:00Z", details: { family: "qwen3", parameter_size: "8.2B", quantization_level: "Q4_K_M" } },
      { name: "mystery" },
      { model: "only-model-field:latest", size: "big", details: { family: 42 } },
      { size: 10 },
      "garbage",
    ] } },
  });
  const client = createOllamaClient({ baseUrl: server.url, policy });
  const version = await client.version();
  assert.equal(version.version, "0.12.3");
  assert.ok(version.latencyMs >= 0);
  const models = await client.models();
  assert.deepEqual(models.map(model => model.name), ["mystery", "only-model-field:latest", "qwen3:8b"]);
  assert.deepEqual(models.find(model => model.name === "qwen3:8b"), { name: "qwen3:8b", sizeBytes: 5_200_000_000, family: "qwen3", parameterSize: "8.2B", quantization: "Q4_K_M", contextLength: null, modifiedAt: "2026-10-01T10:00:00Z" });
  // Absent or malformed metadata stays null, never guessed.
  assert.deepEqual(models.find(model => model.name === "mystery"), { name: "mystery", sizeBytes: null, family: null, parameterSize: null, quantization: null, contextLength: null, modifiedAt: null });
  assert.deepEqual(models.find(model => model.name === "only-model-field:latest")!.sizeBytes, null);
  assert.deepEqual(server.requests.map(request => `${request.method} ${request.path}`), ["GET /api/version", "GET /api/tags"]);
});

test("ollama: chat sends the model, deterministic options and the JSON format", async t => {
  const server = await fakeOllama(t, { "/api/chat": { body: { message: { role: "assistant", content: "{\"ok\": true}" }, done: true, done_reason: "stop" } } });
  const client = createOllamaClient({ baseUrl: `${server.url}/`, policy });
  assert.equal(await client.chat({ ...chat, options: { ...options, temperature: 0.2, maxTokens: 512, contextSize: 8_192 } }), "{\"ok\": true}");
  const sent = server.requests[0].body as { model: string; stream: boolean; format: string; options: Record<string, number>; messages: { role: string }[] };
  assert.equal(server.requests[0].path, "/api/chat");
  assert.deepEqual([sent.model, sent.stream, sent.format, sent.messages.map(message => message.role)], ["qwen3:1.7b", false, "json", ["system", "user"]]);
  assert.deepEqual(sent.options, { temperature: 0.2, num_predict: 512, seed: 0, num_ctx: 8_192 });
  // Thinking is off: reasoning tokens would count against num_predict before the JSON starts.
  assert.equal((server.requests[0].body as { think?: boolean }).think, false);
  // Without a context size the model default applies; free text has no JSON format.
  await client.chat({ ...chat, json: false });
  const plain = server.requests[1].body as { format?: string; options: Record<string, number> };
  assert.equal(plain.format, undefined);
  assert.equal(plain.options.num_ctx, undefined);
  // The bound Inference asks for JSON and validates nothing by itself: askJson does.
  const inference = bindInference({ type: "ollama", baseUrl: server.url, policy, options });
  assert.deepEqual(await askJson(inference, { model: "qwen3:1.7b", system: "s", prompt: "p" }, z.object({ ok: z.boolean() })), { ok: true });
  assert.equal((server.requests[2].body as { format: string }).format, "json");
});

test("ollama: valid, thinking, truncated, unfinished, empty and malformed JSON answers", async t => {
  const answer = (content: string, extra: Record<string, unknown> = {}) => ({ body: { message: { role: "assistant", content, ...(extra.thinking ? { thinking: extra.thinking } : {}) }, done: extra.done ?? true, done_reason: extra.reason ?? "stop" } });
  const server = await fakeOllama(t, {
    "/valid/api/chat": answer("{\"ok\": true}"),
    // A thinking model may still return its reasoning apart: only the content is the answer.
    "/reasoned/api/chat": answer("{\"ok\": true}", { thinking: "Je dois répondre {\"ok\": false}…" }),
    // Observed with qwen3 on a Raspberry Pi: the limit spent in reasoning, no content at all.
    "/exhausted/api/chat": answer("", { thinking: "Okay, the user wants me to reply with a JSON object…", reason: "length" }),
    "/truncated/api/chat": answer("{\"messages\": [", { reason: "length" }),
    "/unfinished/api/chat": answer("{\"ok\": tr", { done: false, reason: "" }),
    "/empty/api/chat": answer("   "),
    "/malformed/api/chat": answer("{\"ok\": oui}"),
    "/thinking-only/api/chat": answer("", { thinking: "{\"ok\": true}" }),
  });
  const at = (prefix: string) => createOllamaClient({ baseUrl: `${server.url}/${prefix}/`, policy });
  const output = (pattern: RegExp) => (error: Error) => error instanceof InferenceOutputError && error.code === "invalid-response" && pattern.test(error.message);
  assert.equal(await at("valid").chat(chat), "{\"ok\": true}");
  assert.equal(await at("reasoned").chat(chat), "{\"ok\": true}");
  await assert.rejects(at("exhausted").chat(chat), output(/raisonnement \(thinking\)/));
  await assert.rejects(at("truncated").chat(chat), output(/incomplète.*limite de 2048 tokens/));
  await assert.rejects(at("unfinished").chat(chat), output(/non terminée/));
  await assert.rejects(at("empty").chat(chat), output(/vide/));
  // The reasoning is never promoted to the answer, even when it looks like valid JSON.
  await assert.rejects(at("thinking-only").chat(chat), output(/vide/));
  // Syntactically broken JSON reaches askJson, which retries once then refuses it.
  const inference = bindInference({ type: "ollama", baseUrl: `${server.url}/malformed/`, policy, options });
  await assert.rejects(askJson(inference, { model: "qwen3:1.7b", system: "s", prompt: "p" }, z.object({ ok: z.boolean() })), output(/non conforme/));
  // Free text keeps a truncated answer (no JSON contract), but not an exhausted reasoning.
  assert.equal(await at("truncated").chat({ ...chat, json: false }), "{\"messages\": [");
  await assert.rejects(at("exhausted").chat({ ...chat, json: false }), output(/raisonnement/));
});

test("ollama: unavailable server, timeout and interrupted connection wait without consuming attempts", { timeout: 20_000 }, async t => {
  const port = await closedPort();
  await assert.rejects(createOllamaClient({ baseUrl: `http://127.0.0.1:${port}`, policy }).version(), code(InferenceUnavailableError, "unreachable"));
  const server = await fakeOllama(t, { "/api/version": { body: { version: "1" }, delayMs: 1_500 }, "/api/chat": { cut: true } });
  const client = createOllamaClient({ baseUrl: server.url, policy });
  await assert.rejects(client.version({ timeoutMs: 300 }), code(InferenceUnavailableError, "timeout"));
  await assert.rejects(client.chat(chat), code(InferenceUnavailableError, "interrupted"));
  // A name that does not resolve is unreachable too.
  const unresolved = createOllamaClient({ baseUrl: "http://ollama.test:11434", policy, fetch: createProviderFetch(policy, { resolve: async () => { throw new Error("ENOTFOUND"); } }) });
  await assert.rejects(unresolved.version(), code(InferenceUnavailableError, "unreachable"));
});

test("ollama: missing model, memory, context and server errors are typed without echoing the server", async t => {
  const server = await fakeOllama(t, {
    "/missing/api/chat": { status: 404, body: { error: "model \"qwen3:70b\" not found, try pulling it first" } },
    "/oom/api/chat": { status: 500, body: { error: "model requires more system memory (48.0 GiB) than is available (7.6 GiB)" } },
    "/context/api/chat": { status: 400, body: { error: "the input length exceeds the context length" } },
    "/crash/api/chat": { status: 500, raw: "<html>secret internal page</html>" },
    "/refused/api/chat": { status: 403, raw: "forbidden: internal token abc" },
    "/bad/api/chat": { raw: "pas du json" },
    "/odd/api/chat": { body: { unexpected: true } },
    "/truncated/api/chat": { body: { message: { content: "{\"messages\": [" }, done_reason: "length" } },
    "/odd/api/tags": { body: { nothing: [] } },
    "/odd/api/version": { body: { name: "not ollama" } },
  });
  const at = (prefix: string) => createOllamaClient({ baseUrl: `${server.url}/${prefix}`, policy });
  await assert.rejects(at("missing").chat({ ...chat, model: "qwen3:70b" }), (error: Error) => code(InferenceConfigError, "model-missing")(error) && /qwen3:70b/.test(error.message) && /ollama pull/.test(error.message));
  await assert.rejects(at("oom").chat(chat), code(InferenceUnavailableError, "out-of-memory"));
  await assert.rejects(at("context").chat(chat), code(InferenceOutputError, "context-too-large"));
  await assert.rejects(at("crash").chat(chat), (error: Error) => code(InferenceUnavailableError, "http")(error) && !/secret/.test(error.message));
  await assert.rejects(at("refused").chat(chat), (error: Error) => code(InferenceConfigError, "http")(error) && !/token/.test(error.message));
  await assert.rejects(at("bad").chat(chat), code(InferenceOutputError, "invalid-response"));
  await assert.rejects(at("odd").chat(chat), code(InferenceOutputError, "invalid-response"));
  await assert.rejects(at("truncated").chat(chat), (error: Error) => code(InferenceOutputError, "invalid-response")(error) && /incomplète/.test(error.message));
  // Free text may legitimately stop at the limit.
  assert.equal(await at("truncated").chat({ ...chat, json: false }), "{\"messages\": [");
  await assert.rejects(at("odd").models(), code(InferenceOutputError, "invalid-response"));
  await assert.rejects(at("odd").version(), code(InferenceOutputError, "invalid-response"));
  // An unknown path (not an Ollama server) is not mistaken for a missing model on discovery.
  await assert.rejects(at("nowhere").version(), code(InferenceConfigError, "http"));
});

test("network: no redirect, no public or link-local destination, operator host list", async t => {
  const server = await fakeOllama(t, { "/api/version": { status: 302, headers: { Location: "http://169.254.169.254/latest/meta-data" } } });
  await assert.rejects(createOllamaClient({ baseUrl: server.url, policy }).version(), code(InferenceConfigError, "blocked"));
  for (const url of ["http://8.8.8.8:11434", "http://169.254.169.254/", "http://[fe80::1]:11434", "http://0.0.0.0:11434"]) {
    assert.throws(() => createOllamaClient({ baseUrl: url, policy }), code(InferenceConfigError, "blocked"), url);
  }
  for (const url of ["ftp://127.0.0.1/", "http://user:secret@127.0.0.1:11434", "http://127.0.0.1:11434/?debug=1", "http://127.0.0.1:11434/#x", "pas une url", "file:///etc/passwd"]) {
    assert.throws(() => validateBaseUrl(url, policy), code(InferenceConfigError, "bad-url"), url);
  }
  assert.equal(validateBaseUrl(" http://192.168.1.188:11434 ", policy).href, "http://192.168.1.188:11434/");
  assert.equal(validateBaseUrl("http://mac-mini.local:11434/ollama", policy).href, "http://mac-mini.local:11434/ollama/");
  // A host name resolving to a public address (or a mix: rebinding) is refused before connecting.
  const resolvingTo = (...addresses: string[]) => createProviderFetch(policy, { resolve: async () => addresses.map(address => ({ address, family: 4 })) });
  await assert.rejects(createOllamaClient({ baseUrl: "http://cloud.example:11434", policy, fetch: resolvingTo("104.18.6.192") }).version(), code(InferenceConfigError, "blocked"));
  await assert.rejects(createOllamaClient({ baseUrl: "http://pi.test:11434", policy, fetch: resolvingTo("192.168.1.188", "93.184.216.34") }).version(), code(InferenceConfigError, "blocked"));
  // An explicitly allowed public IP is accepted.
  assert.ok(validateBaseUrl("http://203.0.113.10:11434", { allow: ["203.0.113.10"], hosts: null }));
  // XI_LLM_ALLOWED_HOSTS restricts further, by host or host:port; local addresses alone no longer suffice.
  const restricted = destinationPolicyFromEnv({ XI_LLM_ALLOWED_HOSTS: " 192.168.1.188:11434, Mac-Mini.local ", XI_INFERENCE_ALLOW: "203.0.113.10, api.openai.com" });
  assert.deepEqual(restricted, { allow: ["203.0.113.10"], hosts: ["192.168.1.188:11434", "mac-mini.local"] });
  assert.ok(validateBaseUrl("http://192.168.1.188:11434", restricted));
  assert.ok(validateBaseUrl("http://mac-mini.local:8080", restricted));
  assert.throws(() => validateBaseUrl("http://192.168.1.188:8080", restricted), code(InferenceConfigError, "blocked"));
  assert.throws(() => validateBaseUrl("http://10.0.0.2:11434", restricted), code(InferenceConfigError, "blocked"));
  const local = await fakeOllama(t, { "/api/version": { body: { version: "1" } } });
  await assert.rejects(createProviderFetch(restricted)(`${local.url}/api/version`), /Hôte non autorisé/);
  assert.equal(local.requests.length, 0);
  assert.deepEqual(destinationPolicyFromEnv({}), { allow: [], hosts: null });
});
