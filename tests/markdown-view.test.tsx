import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup as renderStatic } from "react-dom/server";
import type { ReactNode } from "react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
const router = { back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, prefetch: async () => {} };
const renderToStaticMarkup = (children: ReactNode) => renderStatic(<AppRouterContext.Provider value={router}>{children}</AppRouterContext.Provider>);
import { MarkdownView } from "../src/components/publications/markdown-view";

test("mentions link to profiles without rewriting code, email or links", () => {
  const html = renderToStaticMarkup(<MarkdownView markdown="Bonjour @politiks.france et `@code`. mail@exemple.org [@label](https://example.org)." />);
  assert.match(html, /href="\/dashboard\/profiles\?handle=politiks.france"/);
  assert.match(html, /<code>@code<\/code>/);
  assert.match(html, /mail@exemple.org/);
  assert.doesNotMatch(html, /handle=label|handle=code|handle=exemple/);
});

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

test("feed rendering: long threads are shortened with a link, sources open in a panel, empty Sources headings hide", async () => {
  const { PublicationContent } = await import("../src/components/publications/publication-content");
  const messages = Array.from({ length: 5 }, (_, index) => ({ key: String(index), body: `Message numéro ${index + 1}\n\n## Sources\n` }));
  const sources = [{ file: "1_a.md", title: "Article", url: "https://example.org/a", publisher: "Éditeur" }];
  const feed = renderToStaticMarkup(<PublicationContent summary="Résumé" messages={messages} sources={sources} fullHref="/dashboard/publications/x" />);
  assert.match(feed, /Message numéro 3/);
  assert.doesNotMatch(feed, /Message numéro 4/);
  assert.match(feed, /Afficher la suite.*2.*messages/);
  assert.match(feed, /Sources/);
  assert.doesNotMatch(feed, /<details/);
  assert.doesNotMatch(feed, /href="https:\/\/example.org\/a"/);
  assert.doesNotMatch(feed, /<h2>Sources<\/h2>/);
  const long = renderToStaticMarkup(<PublicationContent summary={"mot ".repeat(500)} messages={[]} sources={[]} fullHref="/x" />);
  assert.match(long, /max-h-80 overflow-hidden/);
  assert.doesNotMatch(long, /Afficher la suite/);
  const full = renderToStaticMarkup(<PublicationContent summary="Résumé" messages={messages} sources={sources} sourcesOpen />);
  assert.match(full, /Message numéro 5/);
  assert.match(full, /Sources/);
});

test("thread preview keeps only three main messages with immutable permalink anchors", async () => {
  const { PublicationContent } = await import("../src/components/publications/publication-content");
  const publicationId = "00000000-0000-4000-8000-000000000001";
  const messages = [
    { key: "8_parent.md", body: "Message parent" },
    { key: "9_branch.md", body: "Réponse secondaire", replyTo: `${publicationId}/8` },
    { key: "2_second.md", body: "Deuxième principal" },
    { key: "3_third.md", body: "Troisième principal" },
    { key: "4_fourth.md", body: "Quatrième principal" },
  ];
  const props = { summary: "", messages, sources: [], publicationId, date: "2026-10-20T12:00:00Z", author: { name: "Alice" } };
  const preview = renderToStaticMarkup(<PublicationContent {...props} fullHref="/thread" />);
  assert.match(preview, /Troisième principal/);
  assert.doesNotMatch(preview, /Réponse secondaire|Quatrième principal|id="m-/);
  assert.equal((preview.match(/data-thread-connector/g) ?? []).length, 2);
  const full = renderToStaticMarkup(<PublicationContent {...props} />);
  assert.match(full, /id="m-8"/);
  assert.match(preview, /href="\/dashboard\/publications\/00000000-0000-4000-8000-000000000001\/conversation\/8"/);
  assert.match(full, /id="m-2"/);
});

test("generator and human handles resolve equally with or without @", async () => {
 const {normalizeHandle}=await import("../src/lib/handle");
 for(const [stored,requested] of [["politiks.france","@Politiks.France"],["@xi-12345678","xi-12345678"],["politiks.france","politiks.france"]]) {
  assert.equal(normalizeHandle(stored),normalizeHandle(requested));
 }
});

test("real publication cards wire graph connections for published messages only", async () => {
 const {PublicationCard}=await import("../src/components/publications/publication-card");
 const publication={id:"00000000-0000-4000-8000-000000000001",authorId:"alice",authorType:"human",status:"published",visibility:"public",type:"post",createdAt:"2026-10-20T12:00:00Z",updatedAt:"2026-10-20T12:00:00Z",publishedAt:"2026-10-20T12:00:00Z",score:null,summary:"",sources:[],revision:"",messages:[{file:"1_message.md",body:"Texte"}]} as import("../src/lib/publications/types").PublicationSnapshot;
 assert.match(renderToStaticMarkup(<PublicationCard publication={publication} viewerId="bob" />),/Connexions et corrections/);
 assert.doesNotMatch(renderToStaticMarkup(<PublicationCard publication={{...publication,status:"draft"}} viewerId="bob" />),/Connexions et corrections/);
});
