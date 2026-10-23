import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { createTestServer } from "./helpers/next-server";

test("publication design: connected threads, mobile, media privacy and visible-only Bloub motion", { timeout: 120_000 }, async t => {
  const app = await createTestServer();
  await app.migrate();
  const generator = randomUUID();
  const account = join(app.vaultPath, "generators", "science.biologie");
  await mkdir(account, { recursive: true });
  await writeFile(join(account, "index.md"), `---\nid: ${generator}\nslug: science.biologie\ntitle: Science Biologie\nowner_id: fixture-owner\nvisibility: public\ncreated_at: 2026-10-20T12:00:00Z\n---\n`);
  const ids: string[] = [];
  for (const count of [1, 2, 3, 4]) {
    const id = randomUUID(); ids.push(id);
    const folder = join(app.vaultPath, "posts", "_generators", generator, `post_20261020_00${count}`);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "index.md"), `---\nid: ${id}\ntype: ${count === 1 ? "post" : "thread"}\nauthor_type: ai\nauthor_id: ${generator}\nstatus: published\nvisibility: public\ncreated_at: 2026-10-20T12:00:00Z\nupdated_at: 2026-10-20T12:00:00Z\npublished_at: 2026-10-20T12:00:00Z\n---\n${Array.from({length: count}, (_, i) => `![[${i + 1}_message.md]]`).join("\n")}`);
    for (let n = 1; n <= count; n++) await writeFile(join(folder, `${n}_message.md`), `# Message ${n}\n\nTexte **riche**, @science.biologie et une [source](https://example.org).\n\n${n === 1 ? "![Illustration](https://example.org/design.png)" : "Suite de la conversation."}`);
  }
  await app.start();
  const browser = await chromium.launch({ executablePath: process.env.XI_E2E_CHROME ?? "/usr/bin/google-chrome-stable", headless: true });
  t.after(async () => { await browser.close(); await app.dispose(); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${app.origin}/auth/register`);
  await page.fill('input[name="name"]', "Design Reader");
  await page.fill('input[name="email"]', "design@example.com");
  await page.fill('input[name="password"]', "design browser password");
  await page.fill('input[name="rePassword"]', "design browser password");
  await page.click('button[type="submit"]');
  await page.waitForURL(`${app.origin}/dashboard`);
  let mediaRequests = 0;
  await page.route("https://example.org/design.png", async route => {
    mediaRequests++;
    await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="teal"/></svg>' });
  });
  for (const [i, id] of ids.entries()) {
    const card = page.locator(`[data-feed-id="${id}"]`);
    await card.waitFor();
    const count = Math.min(i + 1, 3);
    assert.equal(await card.locator("[data-bloub]").count(), count);
    assert.equal(await card.locator("[data-thread-connector]").count(), count - 1);
    assert.equal(await card.getByRole("button", { name: "Répondre", exact: true }).count(), 1);
    assert.equal(await card.getByRole("button", { name: "Partager", exact: true }).count(), 1);
    assert.equal(await card.locator('[data-animating="true"]').count(), 0);
  }
  assert.equal(mediaRequests, 0);
  const card = page.locator(`[data-feed-id="${ids[2]}"]`);
  await card.scrollIntoViewIfNeeded();
  const avatar = card.locator("[data-bloub]").first();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.waitForFunction(() => !!document.querySelector('[data-bloub][data-animating="true"]'));
  await avatar.scrollIntoViewIfNeeded();
  await page.waitForFunction(id => document.querySelector(`[data-feed-id="${id}"] [data-bloub]`)?.getAttribute("data-animating") === "true", ids[2]);
  const eyeBefore = await avatar.locator("rect").first().getAttribute("transform");
  await page.waitForFunction(({ id, before }) => document.querySelector(`[data-feed-id="${id}"] [data-bloub] rect`)?.getAttribute("transform") !== before, { id: ids[2], before: eyeBefore });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(() => !document.querySelector('[data-bloub][data-animating="true"]'));
  const media = card.getByRole("button", { name: /Afficher l’image/ });
  const before = await media.locator("..").boundingBox();
  await media.click();
  await card.getByRole("img", { name: "Illustration", exact: true }).waitFor();
  assert.equal(mediaRequests, 1);
  const after = await card.getByRole("img", { name: "Illustration", exact: true }).locator("..").boundingBox();
  assert.equal(before?.height, after?.height);
  await page.screenshot({ path: "/tmp/xi-publications-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await card.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const avatars = await card.locator("[data-bloub]").all();
  const connectors = await card.locator("[data-thread-connector]").all();
  for (let i = 0; i < connectors.length; i++) {
    const a = await avatars[i].boundingBox(); const b = await avatars[i + 1].boundingBox(); const line = await connectors[i].boundingBox();
    assert.ok(a && b && line);
    assert.ok(Math.abs(line.x + line.width / 2 - (a.x + a.width / 2)) < 1);
    assert.ok(line.y >= a.y + a.height && Math.abs(line.y + line.height - b.y) <= 1);
  }
  await page.screenshot({ path: "/tmp/xi-publications-mobile.png" });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(id => {
    const avatar = document.querySelector(`[data-feed-id="${id}"] [data-bloub]`)!;
    const top = avatar.getBoundingClientRect().top + scrollY;
    window.scrollTo(0, top > innerHeight ? 0 : document.documentElement.scrollHeight);
  }, ids[2]);
  await page.waitForFunction(id => document.querySelector(`[data-feed-id="${id}"] [data-bloub]`)?.getAttribute("data-animating") !== "true", ids[2]);
  assert.deepEqual(errors, []);
});
