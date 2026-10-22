import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSource, serializeSource } from "../src/lib/publications/markdown";

test("source panels retain dated metadata and authored evidence without inferring reliability", () => {
  const source = parseSource(`---\ntitle: Étude\nauthor: Alice\npublisher: Institut\npublished_at: '2026-10-20'\nurl: https://example.org/report\ncategories: [étude, données]\nexcerpts: [Extrait exact]\nclaims: [Affirmation sourcée]\n---\n## Faits utilisés\n\n- Résultat utilisé\n\n## Réserves\n\n- Échantillon limité\n`);
  assert.equal(source.date, "2026-10-20");
  assert.equal(source.author, "Alice");
  assert.deepEqual(source.kinds, ["étude", "données"]);
  assert.deepEqual(source.excerpts, ["Extrait exact"]);
  assert.deepEqual(source.claims, ["Affirmation sourcée", "Résultat utilisé"]);
  assert.deepEqual(source.reservations, ["Échantillon limité"]);
  assert.equal("reliability" in source, false);
});

test("existing source notes expose their facts and reservations; unsafe URLs stay absent", () => {
  const source = parseSource(serializeSource({ title: "Rapport", publisher: "Institut", url: "https://example.org", facts: ["Un fait"], reservations: ["Une réserve"] }, "2026-10-20"));
  assert.deepEqual(source.claims, ["Un fait"]);
  assert.deepEqual(source.reservations, ["Une réserve"]);
  assert.equal(parseSource("---\nurl: javascript:alert(1)\n---\n").url, null);
});
