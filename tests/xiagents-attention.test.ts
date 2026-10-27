import assert from "node:assert/strict";
import { test } from "node:test";
import { agentActivity, agentAttention } from "../src/lib/xiagents/attention";

type Input = Parameters<typeof agentAttention>[0];
const candidate = (storyId: string, status: string, reason = "Raison.") => ({ storyId, title: `Actualité ${storyId}`, status, lane: "night", updatedAt: "2026-10-27T10:00:00.000Z", blocker: { step: status === "published" ? "publiée" : "publication", reason } });
const base = (patch: Partial<Record<keyof Input, unknown>> = {}) => ({
  watch: { valid: true }, running: true, worker: { stale: false, lastTickAt: "2026-10-27T10:00:00.000Z" }, llm: { ok: true }, failedJobs: 0,
  sources: [{ publisher: "Le Quotidien", status: "approved", state: { lastOutcome: "ok" } }], candidates: [], publishBlocks: [], nextWindow: "2026-10-28T02:00:00.000Z", ...patch,
}) as unknown as Input;

test("attention: a running agent without signals works on its own", () => {
  const attention = agentAttention(base());
  assert.equal(attention.healthy, true);
  assert.deepEqual([attention.blocked, attention.decisions, attention.scheduled, attention.waiting], [[], [], [], []]);
});

test("attention: a compliant draft awaiting its window is scheduled, never a human intervention", () => {
  const attention = agentAttention(base({ candidates: [candidate("a", "drafted"), candidate("b", "accepted")] }));
  assert.equal(attention.healthy, true);
  assert.deepEqual(attention.decisions, []);
  assert.equal(attention.scheduled[0].label, "1 publication automatique programmée");
  assert.equal(attention.scheduled[0].at, "2026-10-28T02:00:00.000Z");
  assert.equal(attention.waiting[0].label, "1 information retenue avant rédaction");
  assert.equal(agentActivity(base({ candidates: [candidate("a", "drafted")] }))[0].scheduled, true);
});

test("attention: drafts the publisher cannot publish ask for a review, with the publisher's reasons", () => {
  const data = base({ candidates: [candidate("a", "drafted"), candidate("b", "drafted")], publishBlocks: ["Mode autonome désactivé pour ce ΞAgent."] });
  const attention = agentAttention(data);
  assert.equal(attention.healthy, false);
  assert.deepEqual(attention.decisions.map(item => [item.label, item.detail]), [["2 brouillons à relire", "Publication automatique impossible : Mode autonome désactivé pour ce ΞAgent."]]);
  assert.deepEqual(attention.scheduled, []);
  assert.equal(agentActivity(data)[0].scheduled, false);
});

test("attention: paused, drafts wait for the resume and nothing claims everything works", () => {
  const attention = agentAttention(base({ running: false, worker: { stale: true, lastTickAt: null }, candidates: [candidate("a", "drafted")], publishBlocks: ["Veille arrêtée, en pause ou ΞAgent inactif."] }));
  assert.equal(attention.healthy, false);
  assert.deepEqual([attention.blocked, attention.decisions], [[], []], "a stopped worker does not matter while the agent is paused");
  assert.equal(attention.waiting[0].label, "1 brouillon en attente de la reprise de la veille");
});

test("attention: real blockers and pending sources", () => {
  const attention = agentAttention(base({
    watch: { valid: false }, worker: { stale: true, lastTickAt: null }, llm: { ok: false }, failedJobs: 2,
    sources: [{ publisher: "A", status: "approved", state: { lastOutcome: "error" } }, { publisher: "B", status: "approved", state: { lastOutcome: "robots" } }, { publisher: "C", status: "proposed", state: null }, { publisher: "D", status: "approved", state: null }],
  }));
  assert.deepEqual(attention.blocked.map(item => [item.label, item.href]), [
    ["Paramètres de veille illisibles", "#policy-title"], ["Le worker de veille ne tourne pas", "#xiagent-watch"], ["Modèle d’IA indisponible", "#xiagent-llm"],
    ["2 tâches en échec définitif", "#jobs-title"], ["2 sources actives en échec de collecte", "#sources-title"],
  ]);
  assert.equal(attention.blocked[4].detail, "A, B");
  assert.deepEqual(attention.decisions.map(item => item.label), ["1 source en attente d’approbation"]);
  assert.equal(attention.healthy, false);
});
