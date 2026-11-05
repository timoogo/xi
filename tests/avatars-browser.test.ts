import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import sharp from "sharp";
import { chromium, type Browser } from "playwright-core";
import { createTestServer } from "./helpers/next-server";
import { hydrated } from "./helpers/hydration";
import { createPublicationStore } from "../src/lib/publications/store";
import { openVault } from "../src/lib/publications/vault";

test("avatars: secure local uploads, settings, all human surfaces, replacement, concurrency and removal", { timeout: 120_000 }, async t => {
  const app = await createTestServer();
  const resources: { browser?: Browser } = {};
  t.after(async () => { await resources.browser?.close(); await app.dispose(); });
  await app.migrate(); await app.start();
  const browser = resources.browser = await chromium.launch({ executablePath: process.env.XI_E2E_CHROME ?? "/usr/bin/google-chrome-stable", headless: true });
  const alice = await browser.newContext();
  const bob = await browser.newContext();
  const anonymous = await browser.newContext();
  async function register(context: typeof alice, name: string) {
    const result = await context.request.post(`${app.origin}/api/auth/sign-up/email`, {
      headers: { Origin: app.origin }, data: { name, email: `${name}@example.com`, password: "avatar test password" },
    });
    assert.equal(result.status(), 200);
    return (await result.json()).user as { id: string };
  }
  const user = await register(alice, "Alice");
  const other = await register(bob, "Bob");
  const png = await sharp({ create: { width: 80, height: 60, channels: 3, background: "teal" } }).png().withMetadata().toBuffer();
  const jpeg = await sharp({ create: { width: 60, height: 80, channels: 3, background: "orange" } }).jpeg().toBuffer();
  const upload = (context: typeof alice, data = png, type = "image/png", origin = app.origin, query = "") =>
    context.request.put(`${app.origin}/api/account/avatar${query}`, { headers: { Origin: origin, "Content-Type": type }, data });
  assert.equal((await upload(anonymous)).status(), 401);
  assert.equal((await upload(alice, png, "image/png", "https://foreign.example")).status(), 403);
  assert.equal((await upload(alice, Buffer.from("<svg onload='alert(1)'/>"))).status(), 400);
  assert.equal((await upload(alice, png, "image/svg+xml")).status(), 415);
  assert.equal((await upload(alice, Buffer.alloc(5 * 1024 * 1024 + 1))).status(), 413);
  const session = async (context: typeof alice) => (await (await context.request.get(`${app.origin}/api/auth/get-session`)).json()).user;
  assert.equal((await session(alice)).image ?? null, null);

  const page = await alice.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${app.origin}/dashboard/profile`);
  await page.getByRole("link", { name: "Modifier le profil" }).click();
  await page.getByRole("heading", { name: "Paramètres du compte" }).waitFor();
  const preferences = new Database(app.databasePath);
  t.after(() => preferences.close());
  const preference = (id = user.id) => preferences.prepare("SELECT seed, mode, revision FROM user_avatar WHERE user_id=?").get(id) as { seed: string; mode: string; revision: number };
  const original = preference();
  assert.equal(original.mode, "bloub"); assert.notEqual(original.seed, preference(other.id).seed);
  const preview = page.getByLabel("Aperçu de l’avatar").locator("[data-bloub]");
  assert.equal(await preview.getAttribute("data-seed"), original.seed);
  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "Régénérer" }).click();
  assert.notEqual(await preview.getAttribute("data-seed"), original.seed);
  assert.deepEqual(preference(), original);
  await page.reload(); assert.equal(await preview.getAttribute("data-seed"), original.seed);
  await hydrated(page.getByRole("button", { name: "Régénérer" }));
  await page.getByRole("button", { name: "Régénérer" }).click();
  const chosen = await preview.getAttribute("data-seed");
  await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Avatar enregistré." }).waitFor();
  assert.equal(preference().seed, chosen);
  await page.reload(); assert.equal(await preview.getAttribute("data-seed"), chosen);
  // Human Bloubs are still frames: no animation loop, whatever the motion preference.
  for (const reducedMotion of ["reduce", "no-preference"] as const) {
    await page.emulateMedia({ reducedMotion });
    const staticEyes = await preview.locator('mask path[fill="#000"]').first().getAttribute("transform");
    await page.waitForTimeout(150);
    assert.equal(await preview.getAttribute("data-animating"), "false");
    assert.equal(await preview.locator('mask path[fill="#000"]').first().getAttribute("transform"), staticEyes);
  }
  const patch = (context: typeof alice, data: unknown, origin = app.origin) => context.request.patch(`${app.origin}/api/account/avatar`, { headers: { Origin: origin }, data });
  assert.equal((await patch(anonymous, preference())).status(), 401);
  assert.equal((await patch(alice, preference(), "https://foreign.example")).status(), 403);
  assert.equal((await patch(alice, original)).status(), 409);
  assert.equal((await patch(alice, { ...preference(), seed: "bad" })).status(), 400);
  assert.equal((await patch(alice, { ...preference(), userId: other.id })).status(), 400);
  assert.equal((await patch(alice, { ...preference(), seed: preference(other.id).seed })).status(), 409);
  assert.equal((await patch(alice, { ...preference(), mode: "photo" })).status(), 400);
  const picker = page.getByLabel("Choisir une photo de profil");
  await hydrated(picker);
  await picker.setInputFiles({ name: "portrait.png", mimeType: "image/png", buffer: png });
  await page.getByRole("status").filter({ hasText: "Photo de profil enregistrée." }).waitFor();
  const first = (await session(alice)).image as string;
  assert.match(first, /^\/api\/avatars\/[a-f0-9-]+\.webp$/);
  await page.getByRole("button", { name: "Compte et réglages" }).locator(`img[src$="${first}"]`).waitFor();
  assert.equal((await anonymous.request.get(app.origin + first)).status(), 401);
  const served = await bob.request.get(app.origin + first);
  assert.equal(served.status(), 200);
  assert.equal(served.headers()["content-type"], "image/webp");
  assert.equal(served.headers()["x-content-type-options"], "nosniff");
  assert.match(served.headers()["cache-control"], /no-store/);
  const meta = await sharp(await served.body()).metadata();
  assert.equal(meta.width, 512); assert.equal(meta.height, 512); assert.equal(meta.exif, undefined);

  await page.getByRole("button", { name: "Mon Bloub", exact: true }).click();
  await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Avatar enregistré." }).waitFor();
  assert.equal((await session(alice)).image, first);
  assert.equal((await bob.request.get(app.origin + first)).status(), 200);
  await page.getByRole("button", { name: "Ma photo", exact: true }).click();
  await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Avatar enregistré." }).waitFor();
  assert.equal((await session(alice)).image, first);

  // A bad replacement leaves both the old file and Better Auth image untouched.
  await picker.setInputFiles({ name: "bad.png", mimeType: "image/png", buffer: Buffer.from("not an image") });
  await page.getByRole("alert").filter({ hasText: /Image invalide/ }).waitFor();
  assert.equal((await session(alice)).image, first);
  assert.equal((await bob.request.get(app.origin + first)).status(), 200);

  const db = new Database(":memory:"); t.after(() => db.close());
  const store = createPublicationStore({ vault: await openVault(app.vaultPath), db });
  async function publish(author: { id: string }, parent?: string) {
    const id = await store.create(author, parent);
    const draft = await store.getEditable(author, id);
    const saved = await store.save(author, id, { baseRevision: draft.revision, summary: "", visibility: "public", messages: [
      { key: "one", file: null, body: parent ? `---\nreply_to: ${parent}\n---\nRéponse avec avatar` : "Premier message avec avatar" },
      ...(!parent ? [{ key: "two", file: null, body: "Deuxième message avec avatar" }] : []),
    ] });
    assert.ok(saved.ok); await store.publish(author, id, saved.snapshot.revision); return id;
  }
  const id = await publish(user);
  await publish(other, `${id}/1`);
  const bobResult = await upload(bob, jpeg, "image/jpeg"); assert.equal(bobResult.status(), 200);
  const bobImage = (await bobResult.json()).image as string;
  for (const path of ["/dashboard", "/dashboard/profile", `/dashboard/profiles/${user.id}`, `/dashboard/publications/${id}`]) {
    await page.goto(app.origin + path);
    const card = page.getByRole("article", { name: "Publication de Alice", exact: true });
    await card.locator(`img[src$="${first}"]`).first().waitFor();
    assert.equal(await card.locator(`img[src$="${first}"]`).count(), 2);
    assert.equal(await card.locator("[data-bloub]").count(), 0);
  }
  await page.goto(`${app.origin}/dashboard/publications/${id}/conversation/1`);
  await page.locator(`#m-1 img[src$="${first}"]`).first().waitFor();
  await page.getByRole("list", { name: "Réponses chronologiques" }).locator(`img[src$="${bobImage}"]`).waitFor();

  await app.stop(); await app.start();
  assert.equal((await session(alice)).image, first);
  assert.equal((await alice.request.get(app.origin + first)).status(), 200);
  await page.goto(`${app.origin}/dashboard/settings`);
  await hydrated(page.getByRole("button", { name: "Modifier la photo" }));
  await page.getByRole("button", { name: "Modifier la photo" }).focus();
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  await (await chooser).setFiles({ name: "replacement.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await page.getByRole("status").filter({ hasText: "Photo de profil enregistrée." }).waitFor();
  const replacement = (await session(alice)).image as string;
  assert.notEqual(replacement, first);
  assert.equal((await alice.request.get(app.origin + first)).status(), 404);
  assert.equal((await session(bob)).image, bobImage);

  const concurrent = await Promise.all([upload(alice), upload(alice, jpeg, "image/jpeg")]);
  assert.ok(concurrent.every(response => response.status() === 200));
  const images = await Promise.all(concurrent.map(async response => (await response.json()).image as string));
  const current = (await session(alice)).image as string;
  assert.ok(images.includes(current));
  for (const image of images) assert.equal((await alice.request.get(app.origin + image)).status(), image === current ? 200 : 404);
  assert.equal((await readdir(join(dirname(app.databasePath), "avatars"))).filter(name => name.endsWith(".webp")).length, 2);
  assert.equal((await alice.request.delete(`${app.origin}/api/account/avatar`, { headers: { Origin: "https://foreign.example" } })).status(), 403);

  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: "/tmp/xi-avatar-settings-mobile.png" });
  await hydrated(page.getByRole("button", { name: "Supprimer la photo" }));
  await page.getByRole("button", { name: "Supprimer la photo" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("status").filter({ hasText: "Photo de profil supprimée." }).waitFor();
  assert.equal((await session(alice)).image, null);
  assert.equal((await alice.request.get(app.origin + current)).status(), 404);
  assert.equal((await session(bob)).image, bobImage);
  assert.deepEqual(await readdir(join(dirname(app.databasePath), "avatars")), [bobImage.split("/").at(-1)]);
  assert.ok(await page.locator("[data-bloub]").count() > 0);
  await page.getByRole("button", { name: "Importer une photo" }).waitFor();
  await page.getByRole("region", { name: "Avatar" }).getByRole("img", { name: "Avatar Bloub de Alice" }).waitFor();

  for (const path of ["/dashboard", "/dashboard/profile", `/dashboard/profiles/${user.id}`, `/dashboard/publications/${id}`, `/dashboard/publications/${id}/conversation/1`]) {
    await page.goto(app.origin + path);
    await page.locator(`main [data-seed="${chosen}"]`).first().waitFor();
    assert.equal(preference().seed, chosen);
  }
  await app.stop(); await app.start();
  await alice.request.post(`${app.origin}/api/auth/sign-out`, { headers: { Origin: app.origin } });
  const login = await alice.request.post(`${app.origin}/api/auth/sign-in/email`, { headers: { Origin: app.origin }, data: { email: "Alice@example.com", password: "avatar test password" } });
  assert.equal(login.status(), 200);
  await page.goto(`${app.origin}/dashboard/settings`);
  assert.equal(await preview.getAttribute("data-seed"), chosen);
  await page.screenshot({ path: "/tmp/xi-bloub-settings-mobile.png" });

  // Target identifiers are never accepted from the browser.
  const injected = await upload(alice, png, "image/png", app.origin, `?userId=${other.id}`);
  assert.equal(injected.status(), 200);
  await alice.request.delete(`${app.origin}/api/account/avatar?userId=${other.id}`, { headers: { Origin: app.origin } });
  assert.equal((await session(alice)).image, null);
  assert.equal((await session(bob)).image, bobImage);
  assert.deepEqual(errors, []);
});
