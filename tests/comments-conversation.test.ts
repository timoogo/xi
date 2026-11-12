import test from "node:test";
import assert from "node:assert/strict";
import { conversationContext, shouldAgentReply } from "../src/lib/comments/conversation";

const parent = { id: "parent", parent: "root", author: "Alpha", agent: "alpha", body: "@beta Que manque-t-il ?", state: "done" };
test("le contexte inclut les réponses voisines, leurs rôles et la sollicitation explicite", () => {
  const context = conversationContext("Sujet : jardins", [
    { id: "root", parent: null, author: "Alice", agent: null, body: "Question initiale", state: "done" },
    { id: "sibling", parent: "root", author: "Beta", agent: "beta", body: "Le sol est argileux", state: "done" }, parent,
  ], parent);
  assert.match(context, /Sujet : jardins/);
  assert.match(context, /Alice \(humain/);
  assert.match(context, /Beta \(ΞAgent, répond à Alice\).*sol est argileux/);
  assert.ok(context.indexOf("sol est argileux") < context.indexOf("Que manque-t-il"));
});
test("une sollicitation entre agents peut être acceptée ou refusée sans reprise automatique", async () => {
  for (const decision of [true, false]) {
    let count = 0;
    const inference = { complete: async ({ prompt }: { prompt: string }) => { count++; assert.match(prompt, /reformulation/); return JSON.stringify({ intervenir: decision }); } };
    assert.equal(await shouldAgentReply(inference, "local", "role", "contexte"), decision);
    assert.equal(count, 1);
  }
  await assert.rejects(shouldAgentReply({ complete: async () => '{"intervenir":"oui"}' }, "local", "role", "contexte"));
});
