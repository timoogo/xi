import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { BloubBot, EXPRESSIONS, SHAPES } from "bloub-react";
import { BloubAvatar } from "../src/components/bloub/bloub-avatar";
import { READABLE_COLORS } from "../src/lib/bloub/colors";
import { BloubEditor } from "../src/components/bloub/bloub-editor";
import { EXPRESSION_LABELS, SHAPE_LABELS } from "../src/components/bloub/labels";
import { UserAvatar } from "../src/components/user-avatar";
import { PublicationContent } from "../src/components/publications/publication-content";
import { DEFAULT_BLOUB_CONFIG } from "../src/lib/bloub/config";
import { OPEN_EYES_AT } from "../src/lib/bloub/state-mapping";
import type { BloubActivity } from "../src/lib/bloub/types";

const render = (activity: BloubActivity, config = DEFAULT_BLOUB_CONFIG) => renderToStaticMarkup(<BloubAvatar config={config} activity={activity} label="Avatar test" size={40} />);
/** Mask paths filled black are the eye holes; their matrix `d` term is the on-screen eye height. */
const eyeHeights = (html: string) => [...html.matchAll(/<path d="[^"]+" transform="matrix\(([^)]+)\)"[^>]*fill="#000"/g)].map(m => Math.abs(Number(m[1].split(",")[3])));
const eyeMatrices = (html: string) => [...html.matchAll(/<path d="[^"]+" transform="matrix\(([^)]+)\)"[^>]*fill="#000"/g)].map(m => m[1].split(",").map(Number));
const body = (html: string) => /<mask[^>]*><path d="([^"]+)"/.exec(html)![1];

test("universal states render as specified with a black body and white eyes", () => {
  const html = Object.fromEntries((["idle", "sleeping", "working", "unavailable"] as const).map(a => [a, render(a)]));
  for (const markup of Object.values(html)) {
    assert.match(markup, /fill="#0a0a0c"/, "black body ink");
    assert.match(markup, /fill="#ffffff"/, "white eyes (paper)");
    assert.match(markup, /role="img" aria-label="Avatar test"/);
    assert.match(markup, /data-animating="false"/, "server rendering is always a still frame");
  }
  const open = eyeHeights(html.idle), closed = eyeHeights(html.sleeping);
  assert.equal(open.length, 2); assert.equal(closed.length, 2);
  // Closed lids: flat, horizontal and wide, yet thick enough to survive the mask at avatar sizes.
  const lids = eyeMatrices(html.sleeping);
  for (const [a, b, , d] of lids) {
    const width = 45 * Math.hypot(a, b), height = 47 * Math.abs(d);
    assert.ok(height >= 6 && height <= 12, `visible lid (${height})`);
    assert.ok(width >= 3 * height, `flat lid (${width} × ${height})`);
    assert.ok(Math.abs(b / a) < 0.1, "horizontal lid");
  }
  assert.ok(closed.every((h, i) => h < open[i] * 0.5), "shorter than open eyes");
  const triangle = renderToStaticMarkup(<BloubBot shape="triangle" frozenAt={OPEN_EYES_AT} paper="#ffffff" />);
  assert.equal(body(html.unavailable), body(triangle));
  assert.notEqual(body(html.unavailable), body(html.idle));
  assert.equal(eyeHeights(html.unavailable).length, 2, "unavailable keeps open white eyes");
  assert.match(html.working, /data-activity="working"/);
});

test("state transitions and customisation change the rendered avatar", () => {
  const states = ["idle", "sleeping", "unavailable"] as const;
  assert.equal(new Set(states.map(state => render(state))).size, 3);
  const custom = render("idle", { ...DEFAULT_BLOUB_CONFIG, shape: "nuage", expression: "heureux" });
  assert.notEqual(body(custom), body(render("idle")));
  assert.notDeepEqual(eyeHeights(custom), eyeHeights(render("idle")));
});

test("many avatars render independently without shared ids", () => {
  const html = renderToStaticMarkup(<>{Array.from({ length: 60 }, (_, i) => <BloubAvatar key={i} config={DEFAULT_BLOUB_CONFIG} activity={i % 2 ? "working" : "idle"} label={`A${i}`} />)}</>);
  const masks = [...html.matchAll(/<mask id="([^"]+)"/g)].map(m => m[1]);
  assert.equal(masks.length, 60); assert.equal(new Set(masks).size, 60);
  assert.equal((html.match(/data-animating="true"/g) ?? []).length, 0);
});

test("identity avatars are always neutral: real activity never reaches profiles or publications", () => {
  const agent = { config: { ...DEFAULT_BLOUB_CONFIG, shape: "goutte" as const }, activity: "sleeping" as const };
  const identity = renderToStaticMarkup(<UserAvatar name="Veilleur" bloub={agent} />);
  assert.match(identity, /data-activity="idle"[^]*aria-label="Avatar Bloub de Veilleur"/);
  assert.equal(body(identity), body(render("idle", agent.config)), "custom shape kept");
  assert.match(renderToStaticMarkup(<UserAvatar name="Alice" bloubSeed={"ab".repeat(16)} />), /data-activity="idle"[^]*aria-label="Avatar Bloub de Alice"/);
  const router = { push() {}, replace() {}, refresh() {}, prefetch() {}, back() {}, forward() {} } as unknown as AppRouterInstance;
  const post = renderToStaticMarkup(<AppRouterContext.Provider value={router}><PublicationContent summary="Résumé" messages={[{ key: "1_message.md", body: "Bonjour" }]} sources={[]} publicationId="p" author={{ name: "Veilleur", ai: true, bloub: { ...agent, activity: "working" } }} /></AppRouterContext.Provider>);
  assert.match(post, /data-bloub="true" data-activity="idle" data-animating="false"/);
  assert.doesNotMatch(post, /data-activity="working"/);
});

test("editor exposes the library catalogs, the four states and accessible controls", () => {
  const html = renderToStaticMarkup(<BloubEditor value={DEFAULT_BLOUB_CONFIG} onChange={() => {}} name="Veilleur" />);
  for (const shape of SHAPES) assert.ok(html.includes(`aria-label="${SHAPE_LABELS[shape.id]}"`), shape.id);
  for (const expression of EXPRESSIONS) assert.ok(html.includes(`aria-label="${EXPRESSION_LABELS[expression.id]}"`), expression.id);
  assert.equal((html.match(/<button[^>]*aria-pressed="true"[^>]*title=/g) ?? []).length, 3, "selected shape, colour and expression");
  assert.equal((html.match(/title="/g) ?? []).length, SHAPES.length + EXPRESSIONS.length + READABLE_COLORS.length);
  for (const label of ["En veille", "Disponible", "Au travail", "Indisponible", "Suivre le curseur", "Exporter l’image (SVG)", "Séquence de démonstration"]) assert.ok(html.includes(label), label);
  assert.match(html, /aria-label="Aperçu de l’avatar de Veilleur"/);
  // Colour (P2): only colours keeping the white eyes readable, black by default.
  assert.match(html, /aria-label="Encre \(par défaut\)" aria-pressed="true"/);
  assert.doesNotMatch(html, /aria-label="Crème"|aria-label="Gris"/);
});
