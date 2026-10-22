import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationTree, messageAnchor } from "../src/lib/publications/conversation";
import { parseMessage } from "../src/lib/publications/message-metadata";
const id = "00000000-0000-4000-8000-000000000001";

test("branches use stable message numbers independently of display order", () => {
  const messages = [
    { key: "8_parent.md", body: "parent" },
    { key: "2_main.md", body: "main" },
    { key: "9_reply.md", body: "reply", replyTo: `${id}/8` },
    { key: "10_nested.md", body: "nested", replyTo: `${id}/9` },
  ];
  const tree = conversationTree(messages, id);
  assert.deepEqual(tree.main.map(m => m.key), ["8_parent.md", "2_main.md"]);
  assert.equal(tree.branches.get("8_parent.md")?.[0].key, "9_reply.md");
  assert.equal(tree.branches.get("9_reply.md")?.[0].key, "10_nested.md");
  assert.equal(messageAnchor("8_renamed.md"), "m-8");
});

test("cycles, missing parents and external replies never lose content", () => {
  const messages = [
    { key: "1_a.md", body: "a", replyTo: `${id}/2` },
    { key: "2_b.md", body: "b", replyTo: `${id}/1` },
    { key: "3_c.md", body: "c", replyTo: `${id}/99` },
    { key: "4_d.md", body: "d", replyTo: "00000000-0000-4000-8000-000000000002/1" },
  ];
  assert.equal(conversationTree(messages, id).main.length, 4);
});

test("reply metadata accepts only immutable message references and preserves Markdown", () => {
  const body = `---\nreply_to: ${id}/8\n---\nResponse`;
  assert.deepEqual(parseMessage("9_response.md", body), { file: "9_response.md", body, replyTo: `${id}/8` });
  assert.equal(parseMessage("1_a.md", "---\nreply_to: javascript:alert(1)\n---\nx").replyTo, null);
});
