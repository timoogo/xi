import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownView } from "../src/components/publications/markdown-view";

test("Markdown preview renders Obsidian links without unsafe HTML, scripts or remote images", () => {
  const html = renderToStaticMarkup(<MarkdownView markdown={[
    "---", "secret: frontmatter", "---", "# Titre",
    "Voir [[posts/_users/abc/post_20261019_001/_sources/1_article_le_monde|Le *Monde*]] et ![[image.webp]] `[[code]]`",
    "", "<script>alert(1)</script>", "", "[x](javascript:alert(1)) ![i](https://tracker.example/x.png) [ok](https://example.org)",
    "", "```", "[[kept]]", "```",
  ].join("\n")} />);
  assert.doesNotMatch(html, /secret: frontmatter|<script|javascript:|<img|tracker\.example/);
  assert.match(html, /<h1>Titre<\/h1>/);
  assert.match(html, /<span class="xi-wikilink" title="Obsidian: posts\/_users\/abc\/post_20261019_001\/_sources\/1_article_le_monde\|Le \*Monde\*">Le \*Monde\*<\/span>/);
  assert.match(html, /↳ image.webp/);
  assert.match(html, /<code>\[\[code\]\]<\/code>/);
  assert.match(html, /<code>\[\[kept\]\]\n<\/code>/);
  assert.match(html, /<a href="https:\/\/example.org" target="_blank" rel="noopener noreferrer nofollow">ok<\/a>/);
});

test("feed rendering: long threads are shortened with a link, sources fold, empty Sources headings hide", async () => {
  const { PublicationContent } = await import("../src/components/publications/publication-content");
  const messages = Array.from({ length: 5 }, (_, index) => ({ key: String(index), body: `Message numéro ${index + 1}\n\n## Sources\n` }));
  const sources = [{ file: "1_a.md", title: "Article", url: "https://example.org/a", publisher: "Éditeur" }];
  const feed = renderToStaticMarkup(<PublicationContent summary="Résumé" messages={messages} sources={sources} fullHref="/dashboard/publications/x" />);
  assert.match(feed, /Message numéro 3/);
  assert.doesNotMatch(feed, /Message numéro 4/);
  assert.match(feed, /href="\/dashboard\/publications\/x"[^>]*>Lire le fil complet \(2 messages de plus\)/);
  assert.match(feed, /<details class="group text-sm">/);
  assert.match(feed, /href="https:\/\/example.org\/a"/);
  assert.doesNotMatch(feed, /<h2>Sources<\/h2>/);
  const long = renderToStaticMarkup(<PublicationContent summary={"mot ".repeat(500)} messages={[]} sources={[]} fullHref="/x" />);
  assert.match(long, /max-h-80 overflow-hidden/);
  assert.match(long, /Afficher la suite/);
  const full = renderToStaticMarkup(<PublicationContent summary="Résumé" messages={messages} sources={sources} sourcesOpen />);
  assert.match(full, /Message numéro 5/);
  assert.match(full, /<details open="" class="group text-sm">/);
});
