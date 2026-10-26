import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { createWatchLogger, diagnoseError, observeBinding, taskScope, type WatchEvent } from "../src/lib/watch/events";
import { createJobQueue, type Job } from "../src/lib/watch/jobs";
import { drainJobs } from "../src/lib/watch/worker";
import { BUILTIN_INFERENCE_OPTIONS } from "../src/lib/llm/types";
import { askJson, InferenceOutputError, InferenceUnavailableError } from "../src/lib/watch/inference";
import { z } from "zod";
import type { LLMBinding } from "../src/lib/watch/llm-binding";

const job = { id: "job", kind: "evaluate-story", payload: { agentId: "agent", storyId: "story", sourceId: "source", secret: "PRIVATE" } } as Job;
const binding = (complete: () => Promise<string>): LLMBinding => ({ ok: true, inference: { complete }, resolved: { model: "qwen3:8b", instanceSource: "global", modelSource: "instance", instance: { id: "private", key: "private", name: "PRIVATE", type: "ollama" }, options: BUILTIN_INFERENCE_OPTIONS } });

test("logger allowlists metadata, filters levels and never serializes payloads or errors", () => {
  const lines: string[] = [];
  const log = createWatchLogger(undefined, line => lines.push(line));
  log({ event: "task.end", level: "debug" });
  log({ event: "task.end", status: "done", agentId: "PRIVATE", sourceId: "https://user:PRIVATE@example.test", prompt: "PRIVATE", response: "PRIVATE", error: new Error("PRIVATE"), model: "https://PRIVATE" } as WatchEvent);
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes("PRIVATE"));
  assert.ok(!lines[0].includes("https://"));
  assert.equal(JSON.parse(lines[0]).status, "done");
  for (const [level, expected] of [["debug", 4], ["info", 3], ["warn", 2], ["error", 1], ["invalid", 3]] as const) {
    const output: string[] = [];
    const logger = createWatchLogger(level, line => output.push(line));
    for (const severity of ["debug", "info", "warn", "error"] as const) logger({ event: "task.end", level: severity });
    assert.equal(output.length, expected);
  }
});

for (const outcome of ["success", "timeout", "error", "interrupted"] as const) test(`LLM ${outcome}: heartbeat every 30s and cleanup, no content leaks`, async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const events: WatchEvent[] = [];
  const lines: string[] = [];
  const logger = createWatchLogger("debug", line => lines.push(line));
  const scope = taskScope(job, event => { events.push(event); logger(event); });
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  const observed = observeBinding(binding(() => pending));
  assert.ok(observed.ok);
  const work = scope.run(() => observed.inference.complete({ model: "qwen3:8b", prompt: "PRIVATE", system: "PRIVATE" }));
  t.mock.timers.tick(29_999);
  assert.equal(events.length, 1);
  t.mock.timers.tick(1);
  assert.equal(events[1].event, "llm.heartbeat");
  assert.equal(events[1].timeoutMs, 180_000);
  if (outcome === "interrupted") scope.close();
  if (outcome === "timeout" || outcome === "error") {
    // Ξ's fixed message is logged; a URL inside it would be masked.
    reject(new InferenceUnavailableError("Délai de réponse d’Ollama dépassé. http://PRIVATE:11434", null, outcome === "timeout" ? "timeout" : "unreachable"));
    await assert.rejects(work);
  } else { resolve("PRIVATE"); assert.equal(await work, "PRIVATE"); }
  scope.close();
  const end = events.filter(event => event.event === "llm.end");
  assert.equal(end.length, 1);
  assert.equal(end[0].status, outcome);
  const count = events.length;
  t.mock.timers.tick(90_000);
  assert.equal(events.length, count);
  assert.ok(!lines.join("").includes("PRIVATE"));
});

test("drain keeps outcomes, logs lifecycle and decisions; observer failures are harmless", async () => {
  const db = new Database(":memory:");
  try {
    const queue = createJobQueue(db);
    queue.enqueue({ kind: "evaluate-story", key: "one", payload: job.payload });
    const events: WatchEvent[] = [];
    const summary = await drainJobs({ queue, handlers: { "evaluate-story": async () => ({ status: "done", result: { outcome: "accepted", secret: "PRIVATE" } }) }, observer: event => { events.push(event); throw new Error("broken sink"); } });
    assert.equal(summary.done, 1);
    assert.deepEqual(events.map(event => event.event), ["task.start", "editorial.decision", "task.end"]);
    assert.equal(events[1].status, "accepted");
    assert.equal(events[2].status, "done");
    assert.ok(!JSON.stringify(events).includes("PRIVATE"));
    queue.enqueue({ kind: "sync-error", key: "two", payload: {} });
    const failed = await drainJobs({ queue, handlers: { "sync-error": () => { throw new Error("PRIVATE"); } } });
    assert.equal(failed.retried, 1);
  } finally { db.close(); }
});

test("task deadline stops inference heartbeats even when the client resolves later", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const db = new Database(":memory:");
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    const queue = createJobQueue(db);
    queue.enqueue({ kind: job.kind, key: "interrupt", payload: job.payload });
    const events: WatchEvent[] = [];
    let resolve!: (value: string) => void;
    const observed = observeBinding(binding(() => new Promise<string>(yes => { resolve = yes; })));
    assert.ok(observed.ok);
    const summary = await drainJobs({ queue, observer: event => events.push(event), control: { db, owner: async () => null, admit: async () => ({ allowed: true, deadline: Date.now() + 10, trigger: "calendar" }) }, handlers: { [job.kind]: async () => { await observed.inference.complete({ model: "qwen3:8b", system: "PRIVATE", prompt: "PRIVATE" }); return { status: "done" }; } } });
    assert.equal(summary.interrupted, 1);
    assert.equal(queue.get("interrupt")?.attempts, 0);
    assert.equal(events.find(event => event.event === "llm.end")?.status, "interrupted");
    const count = events.length;
    t.mock.timers.tick(90_000);
    resolve("PRIVATE");
    await new Promise<void>(yes => setImmediate(yes));
    assert.equal(events.length, count);
  } finally { clearTimeout(keepAlive); db.close(); }
});


test("default sink writes events to stderr and leaves stdout JSON parseable", async () => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--import", "tsx", "tests/helpers/watch-logs.ts"]);
  assert.ok(stdout, `missing stdout; stderr=${stderr}`);
  assert.deepEqual(JSON.parse(stdout), { done: 2 });
  const events = stderr.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.event), ['worker.start', 'worker.end']);
  assert.match(events[1].message, /2 terminées/);
  assert.ok(events.every(event => Number.isFinite(Date.parse(event.timestamp))));
});

test("inference failures are logged with their step, type, code, kind, message and cause, never the prompt or answer", async () => {
  const events: WatchEvent[] = [];
  const lines: string[] = [];
  const logger = createWatchLogger("debug", line => lines.push(line));
  const scope = taskScope(job, event => { events.push(event); logger(event); });
  const fail = (error: Error) => observeBinding(binding(async () => { throw error; }));
  const socket = Object.assign(new Error("read ECONNRESET PRIVATE"), { code: "ECONNRESET" });
  const cut = Object.assign(new InferenceUnavailableError("Connexion à Ollama interrompue pendant la réponse.", null, "interrupted"), { cause: Object.assign(new Error("PRIVATE"), { code: "network", cause: socket }) });
  const truncated = new InferenceOutputError("Réponse incomplète : la génération s’est arrêtée (limite de 2048 tokens atteinte) avant la fin de l’objet JSON.", "truncated");
  for (const [error, stage] of [[cut, "merge"], [truncated, "extraction"], [new InferenceUnavailableError("Délai de réponse d’Ollama dépassé.", null, "timeout"), "novelty"], [new TypeError("PRIVATE"), "relevance"]] as const) {
    const observed = fail(error);
    assert.ok(observed.ok);
    await assert.rejects(scope.run(() => observed.inference.complete({ model: "qwen3:8b", system: "PRIVATE", prompt: "PRIVATE", stage })));
  }
  const ends = lines.map(line => JSON.parse(line)).filter(line => line.event === "llm.end");
  assert.deepEqual(ends.map(end => [end.stage, end.status, end.errorType, end.errorCode ?? null, end.errorKind, end.cause ?? null]), [
    ["merge", "error", "InferenceUnavailableError", "interrupted", "network", "network>ECONNRESET"],
    ["extraction", "error", "InferenceOutputError", "truncated", "truncated", null],
    ["novelty", "timeout", "InferenceUnavailableError", "timeout", "timeout", null],
    ["relevance", "error", "TypeError", null, "other", null],
  ]);
  assert.match(ends[1].message, /limite de 2048 tokens/);
  assert.equal(ends[3].message, undefined, "a foreign error's message is never logged");
  // The effective generation budget of the step is on every inference event.
  assert.deepEqual(ends.map(end => end.maxTokens), [2_048, 2_048, 2_048, 2_048]);

  // askJson rejections: invalid JSON vs. schema validation, with Zod paths and codes but no values.
  const replies = ["pas du json PRIVATE", "{\"claims\": [{\"text\": \"PRIVATE\"}]}"];
  const answering = observeBinding(binding(async () => replies.shift()!));
  assert.ok(answering.ok);
  await assert.rejects(scope.run(() => askJson(answering.inference, { model: "qwen3:8b", system: "PRIVATE", prompt: "PRIVATE", stage: "extraction" }, z.object({ claims: z.array(z.object({ text: z.string(), quote: z.string() })) }))),
    (error: Error) => error instanceof InferenceOutputError && error.code === "schema");
  const rejected = lines.map(line => JSON.parse(line)).filter(line => line.event === "llm.rejected");
  assert.deepEqual(rejected.map(line => [line.stage, line.errorKind, line.attempt, line.issues ?? null]), [["extraction", "invalid-json", 1, null], ["extraction", "schema", 2, ["claims.0.quote: invalid_type"]]]);
  scope.close();
  assert.ok(!lines.join("").includes("PRIVATE"));
  assert.ok(!lines.join("").includes("http"));
  // Classification, independent of logging.
  assert.equal(diagnoseError(new InferenceOutputError("x", "schema")).errorKind, "schema");
  assert.equal(diagnoseError(new InferenceOutputError("x", "invalid-json")).errorKind, "invalid-json");
  assert.equal(diagnoseError(null).errorType, "other");
});
