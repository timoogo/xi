import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { chromium, type Browser } from "playwright-core";
import { createTestServer } from "./helpers/next-server";
import { openVault } from "../src/lib/publications/vault";
import { createPublicationStore } from "../src/lib/publications/store";

test("real browser: SSE feed banner, message edits, revocation, conversation pagination and keyboard", { timeout: 180_000 }, async t => {
  const app = await createTestServer();
  await app.migrate(); await app.start();
  const browser = await chromium.launch({ executablePath: process.env.XI_E2E_CHROME ?? "/usr/bin/google-chrome-stable", headless: true });
  // node:test runs after hooks in registration order: close the browser's live connections first.
  t.after(async () => { await browser.close(); await app.dispose(); });
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${app.origin}/auth/register`);
  await page.fill('input[name="name"]', "Live Reader");
  await page.fill('input[name="email"]', "live@example.com");
  await page.fill('input[name="password"]', "live browser password");
  await page.fill('input[name="rePassword"]', "live browser password");
  await page.click('button[type="submit"]');
  await page.waitForURL(`${app.origin}/dashboard`);
  const db = new Database(":memory:"); t.after(() => db.close());
  const vault = await openVault(app.vaultPath);
  const store = createPublicationStore({ vault, db });
  // Seed through the Markdown writer with an independent disposable index.
  // Only the server writes its SQLite database; its watcher observes the files.
  const author = { id: "external-author" };
  async function publish(body: string, parent?: string) {
    const id = await store.create(author, parent);
    const draft = await store.getEditable(author, id);
    const saved = await store.save(author, id, { baseRevision: draft.revision, summary: "", visibility: "public", messages: [{ key: "new", file: null, body: parent ? `---\nreply_to: ${parent}\n---\n${body}` : body }] });
    assert.ok(saved.ok); await store.publish(author, id, saved.snapshot.revision); return id;
  }
  const id = await publish("Publication arrivée en direct");
  await page.getByRole("button", { name: /Nouvelles publications/ }).waitFor({ timeout: 15_000 });
  assert.equal(await page.getByText("Publication arrivée en direct", { exact: true }).count(), 0);
  await page.getByRole("button", { name: /Nouvelles publications/ }).click();
  await page.getByText("Publication arrivée en direct", { exact: true }).waitFor();
  const snap = await store.getEditable(author, id);
  const saved = await store.save(author, id, { baseRevision: snap.revision, summary: "", visibility: "public", messages: snap.messages.map(message => ({ key: message.file, file: message.file, body: "Publication modifiée en direct" })) });
  assert.ok(saved.ok);
  await page.getByText("Publication modifiée en direct", { exact: true }).waitFor({ timeout: 15_000 });
  await page.getByText("Modifié", { exact: true }).waitFor();
  const parent = `${id}/1`;
  const replyIds = [];
  for (let n = 0; n < 12; n++) replyIds.push(await publish(`Réponse de test ${n}`, parent));
  const nested = await publish("Niveau deux", `${replyIds[0]}/1`);
  const deep = await publish("Niveau trois", `${nested}/1`);
  await publish("Niveau quatre", `${deep}/1`);
  await page.goto(`${app.origin}/dashboard/publications/${id}/conversation/1`);
  await page.getByRole("heading", { name: "Sous-conversation" }).waitFor();
  await page.getByRole("navigation", { name: "Fil d’Ariane" }).waitFor();
  const replies = page.getByRole("list", { name: "Réponses chronologiques" }).first();
  await replies.locator(":scope > li").nth(9).waitFor();
  assert.equal(await replies.locator(":scope > li").count(), 10);
  const more = page.getByRole("button", { name: "Afficher plus de réponses" });
  await more.focus(); await page.keyboard.press("Enter");
  await replies.locator(":scope > li").nth(11).waitFor();
  assert.equal(await replies.locator(":scope > li").count(), 12);
  const firstReply = replies.locator(":scope > li").filter({hasText:"Réponse de test 0"});
  await firstReply.getByRole("button", {name:"Développer les réponses",exact:true}).click();
  await page.getByText("Niveau deux",{exact:true}).waitFor();
  await firstReply.getByRole("link",{name:"Voir la sous-conversation",exact:true}).click();
  await page.waitForURL(`${app.origin}/dashboard/publications/${nested}/conversation/1`);
  await page.getByText("Niveau trois",{exact:true}).waitFor();
  assert.equal(await page.getByRole("navigation",{name:"Fil d’Ariane"}).getByRole("link").count(),3);
  await page.getByRole("button",{name:"← Retour",exact:true}).click();
  await page.waitForURL(`${app.origin}/dashboard/publications/${id}/conversation/1`);
  await replies.locator(":scope > li").nth(11).waitFor();
  await page.getByRole("button", { name: "Réduire les réponses", exact: true }).first().click();
  await publish("Réponse pendant branche repliée", parent);
  await page.getByRole("button", { name: /Développer les réponses.*Nouvelles réponses/ }).waitFor({ timeout: 15_000 });
  assert.equal(await page.getByText("Réponse pendant branche repliée", { exact: true }).count(), 0);
  await page.getByRole("button", { name: /Développer les réponses/ }).click();
  await page.getByText("Réponse pendant branche repliée", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), true);
  const beforeRemoval = await store.getEditable(author,id);
  const removed = await store.save(author,id,{baseRevision:beforeRemoval.revision,summary:"",visibility:"public",messages:[]});
  assert.ok(removed.ok);
  await page.getByText("Ce message a été supprimé",{exact:true}).waitFor({timeout:15_000});
  assert.equal(await page.getByText("Publication modifiée en direct",{exact:true}).count(),0);
  await page.getByText("Réponse de test 0",{exact:true}).waitFor();
  // Direct Obsidian visibility change must remove the loaded content without navigation.
  const row = db.prepare("SELECT path FROM publication WHERE id = ?").get(id) as { path: string };
  const indexPath = join(app.vaultPath, row.path, "index.md");
  await writeFile(indexPath, (await readFile(indexPath, "utf8")).replace("visibility: public", "visibility: private"));
  await page.getByText("Cette conversation est indisponible.", { exact: false }).waitFor({ timeout: 15_000 });
  assert.equal(await page.getByText("Publication modifiée en direct", { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
});


test("browser regressions: handles, graph connections, multi-page bursts, reconnect and cross-tab unfollow", { timeout: 240_000 }, async t => {
  const app = await createTestServer();
  const resources: { browser?: Browser; db?: Database.Database } = {};
  t.after(async () => { await resources.browser?.close(); resources.db?.close(); await app.dispose(); });
  await app.migrate(); await app.start();
  const browser = await chromium.launch({ executablePath: process.env.XI_E2E_CHROME ?? "/usr/bin/google-chrome-stable", headless: true });
  resources.browser = browser;
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${app.origin}/auth/register`);
  await page.fill('input[name="name"]', "Regression Reader");
  await page.fill('input[name="email"]', "regression@example.com");
  await page.fill('input[name="password"]', "regression browser password");
  await page.fill('input[name="rePassword"]', "regression browser password");
  await page.click('button[type="submit"]');
  await page.waitForURL(`${app.origin}/dashboard`);
  const authorContext = await browser.newContext();
  const response = await authorContext.request.post(`${app.origin}/api/auth/sign-up/email`, { data: {name:"Regression Author",email:"author-regression@example.com",password:"regression browser password"}, headers:{Origin:app.origin} });
  assert.ok(response.ok());
  const author = { id: (await response.json()).user.id as string };
  const db = new Database(":memory:");
  resources.db = db;
  const vault = await openVault(app.vaultPath);
  const store = createPublicationStore({ vault, db });
  async function publish(body: string, visibility: "public" | "followers" | "private" = "public") {
    const id = await store.create(author); const draft = await store.getEditable(author,id);
    const saved = await store.save(author,id,{baseRevision:draft.revision,summary:"",visibility,messages:[{key:"new",file:null,body}]});
    assert.ok(saved.ok); await store.publish(author,id,saved.snapshot.revision); return id;
  }
  const generator = randomUUID();
  await mkdir(join(app.vaultPath,"generators","politiks.france"),{recursive:true});
  await writeFile(join(app.vaultPath,"generators","politiks.france","index.md"),`---\nid: ${generator}\nslug: politiks.france\ntitle: Politiks France\nowner_id: ${author.id}\nvisibility: public\ncreated_at: 2026-10-20T12:00:00Z\n---\n`);
  for(const handle of ["politiks.france","@POLITIKS.FRANCE"]) {
    await page.goto(`${app.origin}/dashboard/profiles?handle=${encodeURIComponent(handle)}`);
    await page.waitForURL(`${app.origin}/dashboard/profiles/${generator}`);
    await page.getByRole("heading",{name:"Politiks France",exact:true}).first().waitFor();
  }
  const ids: string[] = [];
  for(let n=0;n<25;n++) ids.push(await publish(`Initial publication ${n}`));
  const followerId = await publish("Followers only", "followers");
  const privateId = await publish("Private must never leak", "private");
  const rejected = await context.request.put(`${app.origin}/api/feed/preferences`,{data:{authorId:author.id,following:true},headers:{Origin:"https://foreign.example"}});
  assert.equal(rejected.status(),403);
  const settings = await context.newPage();
  await settings.goto(`${app.origin}/dashboard/profiles/${author.id}`);
  const preferenceResponse = settings.waitForResponse(response => response.url().endsWith("/api/feed/preferences") && response.request().method() === "PUT");
  await settings.getByRole("button",{name:"S’abonner",exact:true}).click();
  const preferenceResult = await preferenceResponse;
  assert.equal(preferenceResult.status(),200,preferenceResult.status() === 200 ? "" : await preferenceResult.text());
  await settings.getByRole("button",{name:"Se désabonner",exact:true}).waitFor();
  await page.goto(`${app.origin}/dashboard?tab=following`);
  await page.locator(`[data-feed-id="${followerId}"]`).waitFor();
  assert.equal(await page.locator(`[data-feed-id="${privateId}"]`).count(),0);
  await page.getByRole("button",{name:"Afficher plus de publications",exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll("[data-feed-id]").length===26,undefined,{timeout:15_000});
  // Keep the feed mounted while more than two pages arrive.
  for(let n=0;n<45;n++) ids.push(await publish(`Burst publication ${n}`));
  await page.getByRole("button",{name:"Nouvelles publications",exact:true}).waitFor({timeout:20_000});
  await page.getByRole("button",{name:"Nouvelles publications",exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll("[data-feed-id]").length===71,undefined,{timeout:30_000});
  const displayed = await page.locator("[data-feed-id]").evaluateAll(nodes=>nodes.map(node=>node.getAttribute("data-feed-id")));
  assert.equal(new Set(displayed).size,71);
  assert.deepEqual(new Set(displayed),new Set([...ids,followerId]));
  // A dropped EventSource connection must recover events that were never delivered.
  await context.setOffline(true);
  const offlineIds=[];
  for(let n=0;n<3;n++) offlineIds.push(await publish(`Offline publication ${n}`));
  await context.setOffline(false);
  await page.getByRole("button",{name:"Nouvelles publications",exact:true}).waitFor({timeout:30_000});
  await page.getByRole("button",{name:"Nouvelles publications",exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll("[data-feed-id]").length===74,undefined,{timeout:30_000});
  for(const id of offlineIds) assert.equal(await page.locator(`[data-feed-id="${id}"]`).count(),1);
  const returnId = ids[5];
  const returnCard = page.locator(`[data-feed-id="${returnId}"]`);
  await returnCard.scrollIntoViewIfNeeded();
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await returnCard.locator(".xi-markdown").first().click();
  await page.waitForURL(`${app.origin}/dashboard/publications/${returnId}/conversation/1`);
  await page.getByRole("button",{name:"← Retour",exact:true}).click();
  await page.waitForURL(`${app.origin}/dashboard?tab=following`);
  await page.waitForFunction(expected => Math.abs(window.scrollY-expected)<8,scrollBefore,{timeout:15_000});
  assert.equal(await page.locator(`[data-feed-id="${returnId}"]`).count(),1);
  // Public content remains readable but must leave the following feed on unfollow.
  await settings.getByRole("button",{name:"Se désabonner",exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll("[data-feed-id]").length===0,undefined,{timeout:20_000});
  assert.equal((await context.request.get(`${app.origin}/api/publications/${ids[0]}`)).status(),200);
  assert.equal((await context.request.get(`${app.origin}/api/publications/${followerId}`)).status(),404);
  // Relations are loaded from a real card and the graph still filters private endpoints.
  await mkdir(join(app.vaultPath,"relations"),{recursive:true});
  for(const target of [ids[1],privateId]) {
    const id=randomUUID();
    await writeFile(join(app.vaultPath,"relations",`${id}.md`),`---\nid: ${id}\ntype: supports\nsource: ${ids[0]}/1\ntarget: ${target}/1\nstatus: validated\nneeds_review: false\norigin: human\ncreated_by: ${author.id}\ncreated_at: 2026-10-20T12:00:00Z\nvalidated_by: ${author.id}\nvalidated_at: 2026-10-20T12:00:00Z\n---\n`);
  }
  await page.goto(`${app.origin}/dashboard/publications/${ids[0]}`);
  await page.getByRole("button",{name:"Connexions et corrections",exact:true}).click();
  const dialog=page.getByRole("dialog");
  await dialog.getByText("1 relation validée",{exact:true}).waitFor({timeout:15_000});
  assert.equal(await dialog.getByRole("list",{name:"Relations",exact:true}).locator(":scope > li").count(),1);
  assert.equal(await dialog.getByText("Private must never leak").count(),0);
  await page.keyboard.press("Escape");
  // Hiding changes feed membership, not access or live updates on a detail page.
  const hiddenPreference = settings.waitForResponse(response => response.url().endsWith("/api/feed/preferences") && response.request().method() === "PUT");
  await settings.getByLabel("Préférence éditoriale").selectOption("hidden");
  assert.equal((await hiddenPreference).status(),200);
  const beforeHiddenEdit = await store.getEditable(author,ids[0]);
  const hiddenEdit = await store.save(author,ids[0],{baseRevision:beforeHiddenEdit.revision,summary:"",visibility:"public",messages:beforeHiddenEdit.messages.map(message=>({key:message.file,file:message.file,body:"Still live while hidden"}))});
  assert.ok(hiddenEdit.ok);
  await page.getByText("Still live while hidden",{exact:true}).waitFor({timeout:15_000});
  await page.goto(`${app.origin}/dashboard`);
  await page.getByRole("heading",{name:"Votre fil vous attend",exact:true}).waitFor();
  assert.equal(await page.locator("[data-feed-id]").count(),0);
  assert.deepEqual(errors,[]);
});
