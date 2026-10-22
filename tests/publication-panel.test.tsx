import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PublicationPanel } from "../src/components/publications/publication-panel";

test("panels expose no speculative indicators and defer source contents until opening", () => {
  assert.equal(renderToStaticMarkup(<PublicationPanel sources={[]} />), "");
  const html = renderToStaticMarkup(<PublicationPanel sources={[{file: "1_report.md", title: "Private report", url: "https://example.org", publisher: "Institute"}]} />);
  assert.match(html, /Sources/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /Private report|https:\/\/example.org|Connexions et corrections/);
});

test("authorized relations and prior versions each enable the context dialog", () => {
  for (const props of [{messageRefs: ["abc/1"]}, {previousVersion: "abc"}]) {
    const html = renderToStaticMarkup(<PublicationPanel sources={[]} {...props} />);
    assert.match(html, /Connexions et corrections/);
    assert.doesNotMatch(html, /Sources \(/);
  }
});
