import test from "node:test";
import assert from "node:assert/strict";
import { references } from "../src/lib/comments/references";

test("mentions et topics progressifs, sans reconnaître les emails et URL", () => {
  const text = "@ @pol # #politique #climat.local, alice@example.com https://local.test/@agent https://local.test/#tag ( @alpha )";
  assert.deepEqual(references(text).map(item => item.text), ["@", "@pol", "#", "#politique", "#climat.local", "@alpha"]);
});
test("plusieurs références et retours à la ligne gardent leurs positions", () => {
  const text = "Bonjour @alice\n#sujet et @bob";
  for (const ref of references(text)) assert.equal(text.slice(ref.start, ref.end), ref.text);
  assert.deepEqual(references(text).map(ref => ref.kind), ["mention", "topic", "mention"]);
});
