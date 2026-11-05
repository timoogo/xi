import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { Job } from "./jobs";
import type { LLMBinding } from "./llm-binding";
import { generationLimit, INFERENCE_STAGES, type InferenceStage } from "./stages";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type WatchEvent = {
  event: "worker.start" | "worker.end" | "worker.error" | "task.start" | "task.end" | "llm.start" | "llm.end" | "llm.heartbeat" | "llm.rejected" | "editorial.decision" | "index.slow";
  level?: LogLevel;
  jobId?: string; kind?: string; agentId?: string; sourceId?: string; storyId?: string;
  model?: string; status?: string; durationMs?: number; timeoutMs?: number;
  pending?: number; concurrency?: number; inferenceConcurrency?: number; deadlineMs?: number;
  autoPublish?: boolean; allowPublic?: boolean; done?: number; waiting?: number;
  retried?: number; failed?: number; lost?: number; interrupted?: number; deferred?: number;
  /** Inference diagnosis: editorial step, effective generation limit, answer attempt within askJson. */
  stage?: InferenceStage; maxTokens?: number; attempt?: number;
} & Partial<ErrorDiagnosis>;
/** A failed inference, described without its prompt, answer or any server-supplied text. */
export type ErrorDiagnosis = { errorType: string; errorCode: string; errorKind: ErrorKind; message: string; cause: string; issues: string[] };
export type ErrorKind = "timeout" | "network" | "truncated" | "invalid-json" | "schema" | "invalid-response" | "server" | "config" | "other";
export type WatchObserver = (event: WatchEvent) => void;
const levels = { debug: 0, info: 1, warn: 2, error: 3 };
// Identifiers are opaque references; arbitrary payload text must never enter the journal.
const reference = (value: unknown) => typeof value === "string" ? createHash("sha256").update(value).digest("hex").slice(0, 16) : undefined;
const numeric = ["durationMs", "timeoutMs", "maxTokens", "attempt", "pending", "concurrency", "inferenceConcurrency", "deadlineMs", "done", "waiting", "retried", "failed", "lost", "interrupted", "deferred"] as const;
const statuses = new Set(["done", "waiting", "retried", "failed", "lost", "interrupted", "deferred", "success", "timeout", "error", "accepted", "rejected", "held", "merged", "drafted", "published", "abandoned", "skipped", "selected"]);
const stages = new Set<string>(INFERENCE_STAGES);
const errorKinds = new Set(["timeout", "network", "truncated", "invalid-json", "schema", "invalid-response", "server", "config", "other"]);
const errorTypes = new Set(["InferenceUnavailableError", "InferenceConfigError", "InferenceOutputError", "FetchError", "Error", "TypeError", "RangeError", "SyntaxError", "AbortError"]);
const kinds = new Set(["collect-source", "discover-sources", "evaluate-story", "draft-candidate", "publication-window", "weekly-review", "publish-alert", "editorial-diffusion"]);

/** One JSON line per event on stderr: immediately visible in a terminal and journalctl. */
export function createWatchLogger(level = process.env.XI_WATCH_LOG_LEVEL, write: (line: string) => void = line => { process.stderr.write(line); }): WatchObserver {
  const threshold = levels[level as LogLevel] ?? levels.info;
  return event => {
    const severity = event.level ?? "info";
    if (levels[severity] < threshold) return;
    const safe: Record<string, unknown> = { timestamp: new Date().toISOString(), level: severity, event: event.event };
    for (const key of ["jobId", "agentId", "sourceId", "storyId"] as const) if (event[key]) safe[key] = reference(event[key]);
    if (event.kind && kinds.has(event.kind)) safe.kind = event.kind;
    // Model tags only, never URLs, instance names or arbitrary configuration text.
    if (event.model) safe.model = /^[a-zA-Z0-9_.:/-]{1,200}$/.test(event.model) && !event.model.includes("://") ? event.model : reference(event.model);
    if (event.status && statuses.has(event.status)) safe.status = event.status;
    for (const key of numeric) if (typeof event[key] === "number" && Number.isFinite(event[key])) safe[key] = event[key];
    for (const key of ["autoPublish", "allowPublic"] as const) if (typeof event[key] === "boolean") safe[key] = event[key];
    if (event.stage && stages.has(event.stage)) safe.stage = event.stage;
    if (event.errorType) safe.errorType = errorTypes.has(event.errorType) ? event.errorType : "other";
    if (event.errorCode && /^[a-z][a-z-]{1,30}$/.test(event.errorCode)) safe.errorCode = event.errorCode;
    if (event.errorKind && errorKinds.has(event.errorKind)) safe.errorKind = event.errorKind;
    // Failure messages only, already reduced to Ξ's fixed templates by diagnoseError; URLs masked again.
    if (event.message && event.event === "llm.end") safe.message = maskUrls(event.message).slice(0, 300);
    if (event.cause && /^[A-Za-z0-9_:>-]{1,120}$/.test(event.cause)) safe.cause = event.cause;
    if (Array.isArray(event.issues) && event.issues.length) safe.issues = event.issues.filter(issue => /^[A-Za-z0-9_.?()]{1,200}: [a-z_]{1,40}$/.test(issue)).slice(0, 5);
    if (event.event === "worker.end") safe.message = `Passe terminée : ${event.done ?? 0} terminées, ${event.waiting ?? 0} en attente, ${event.retried ?? 0} à réessayer, ${event.failed ?? 0} échouées, ${event.interrupted ?? 0} interrompues, ${event.deferred ?? 0} différées, ${event.lost ?? 0} baux perdus.`;
    try { write(`${JSON.stringify(safe)}\n`); } catch { /* Logging must never change a job's outcome. */ }
  };
}
export function emit(observer: WatchObserver | undefined, event: WatchEvent) {
  try { observer?.(event); } catch { /* Observability is best effort. */ }
}
type Scope = { observer?: WatchObserver; context: Pick<WatchEvent, "jobId" | "kind" | "agentId" | "sourceId" | "storyId">; closed: boolean; cleanups: Set<() => void> };
const scopes = new AsyncLocalStorage<Scope>();
export function taskScope(job: Job, observer?: WatchObserver) {
  const payload = job.payload as { agentId?: string; sourceId?: string; storyId?: string } | null;
  const scope: Scope = { observer, context: { jobId: job.id, kind: job.kind, agentId: payload?.agentId, sourceId: payload?.sourceId, storyId: payload?.storyId }, closed: false, cleanups: new Set() };
  return {
    run: <T>(work: () => T) => scopes.run(scope, work),
    emit: (event: WatchEvent) => { if (!scope.closed) emit(observer, { ...scope.context, ...event }); },
    close: () => { for (const cleanup of scope.cleanups) cleanup(); scope.closed = true; },
  };
}
export function editorialDecision(status: string, agentId?: string, storyId?: string) {
  const scope = scopes.getStore();
  if (scope && !scope.closed && statuses.has(status)) emit(scope.observer, { ...scope.context, event: "editorial.decision", status, agentId: agentId ?? scope.context.agentId, storyId: storyId ?? scope.context.storyId });
}

const KIND_BY_CODE: Record<string, ErrorKind> = {
  timeout: "timeout", unreachable: "network", interrupted: "network",
  truncated: "truncated", "invalid-json": "invalid-json", schema: "schema", "invalid-response": "invalid-response",
  http: "server", "out-of-memory": "server", "context-too-large": "server", "model-missing": "config",
  "bad-url": "config", blocked: "config", disabled: "config", "not-configured": "config",
};
const maskUrls = (text: string) => text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]");
const SYSTEM_CODE = /^E[A-Z0-9_]{2,30}$/;
const FETCH_CODES = new Set(["blocked-url", "blocked-address", "redirect", "too-large", "timeout", "network", "http", "robots", "throttled"]);

/**
 * Type, code, kind, message and technical cause of an inference failure. The message is kept only
 * for Ξ's own error classes, whose texts are fixed templates (an Ollama explanation is never
 * echoed); URLs are masked anyway. The cause is the chain of codes only: FetchError code, then the
 * system code of the socket error (`network>ECONNRESET`).
 */
export function diagnoseError(error: unknown): Omit<ErrorDiagnosis, "issues"> {
  const value = error as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown } | null;
  const name = typeof value?.name === "string" ? value.name : typeof error;
  const code = typeof value?.code === "string" ? value.code : "";
  const own = ["InferenceUnavailableError", "InferenceConfigError", "InferenceOutputError"].includes(name);
  const message = own && typeof value?.message === "string" ? maskUrls(value.message).slice(0, 300) : "";
  const chain: string[] = [];
  for (let cause = value?.cause as { code?: unknown; cause?: unknown } | undefined, depth = 0; cause && depth < 4; cause = cause.cause as typeof cause, depth++) {
    if (typeof cause.code === "string" && (SYSTEM_CODE.test(cause.code) || FETCH_CODES.has(cause.code))) chain.push(cause.code);
  }
  return { errorType: errorTypes.has(name) ? name : "other", errorCode: code, errorKind: KIND_BY_CODE[code] ?? "other", message, cause: chain.join(">") };
}

/** askJson refused an answer (no JSON, or JSON off the schema): reported with the step, before any retry. */
export function reportRejectedOutput({ stage, errorKind, errorCode, attempt, issues }: { stage?: InferenceStage; errorKind: ErrorKind; errorCode: string; attempt: number; issues: string[] }) {
  const scope = scopes.getStore();
  if (scope && !scope.closed) emit(scope.observer, { ...scope.context, event: "llm.rejected", level: "warn", stage, errorKind, errorCode, errorType: "InferenceOutputError", attempt, issues });
}

/** Observe the real client timeout; do not introduce a second deadline or alter retries. */
export function observeBinding(binding: LLMBinding): LLMBinding {
  if (!binding.ok) return binding;
  return { ...binding, inference: { async complete(request) {
    const scope = scopes.getStore();
    if (!scope?.observer || scope.closed) return binding.inference.complete(request);
    const started = performance.now();
    const context = { ...scope.context, model: binding.resolved.model, timeoutMs: binding.resolved.options.timeoutMs, stage: request.stage, maxTokens: generationLimit(binding.resolved.options.maxTokens, request.stage) };
    const send = (event: WatchEvent) => { if (!scope.closed) emit(scope.observer, { ...context, ...event }); };
    send({ event: "llm.start" });
    let ended = false;
    const finish = (status: string, diagnosis?: Omit<ErrorDiagnosis, "issues">) => {
      if (ended) return;
      ended = true;
      clearInterval(timer);
      scope.cleanups.delete(interrupt);
      send({ event: "llm.end", status, durationMs: Math.round(performance.now() - started), level: status === "success" ? "info" : "warn", ...diagnosis });
    };
    const interrupt = () => finish("interrupted");
    const timer = setInterval(() => send({ event: "llm.heartbeat", durationMs: Math.round(performance.now() - started) }), 30_000);
    timer.unref();
    scope.cleanups.add(interrupt);
    try { const result = await binding.inference.complete(request); finish("success"); return result; }
    catch (error) { const diagnosis = diagnoseError(error); finish(diagnosis.errorKind === "timeout" ? "timeout" : "error", diagnosis); throw error; }
    finally { clearInterval(timer); scope.cleanups.delete(interrupt); }
  } } };
}

export function emitIndexSlow(durationMs: number) {
  const scope = scopes.getStore();
  if (scope && !scope.closed) emit(scope.observer, { ...scope.context, event: "index.slow", level: "warn", durationMs });
}
