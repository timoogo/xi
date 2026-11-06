import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { diagnoseOnFailure } from "./helpers/diagnostics";
import { createTestServer } from "./helpers/next-server";

// Real browser journeys against the production build (`pnpm build` first) in a local Chrome.
const executablePath = process.env.XI_E2E_CHROME ?? "/usr/bin/google-chrome-stable";

test("browser: feed, editor, deletion, undo, trash and restore", { timeout: 240_000 }, async (t) => {
  const app = await createTestServer();
  await app.migrate();
  await app.start();
  const browser: Browser = await chromium.launch({ executablePath, headless: true });
  diagnoseOnFailure(t, app, () => browser);
  // node:test runs after hooks in registration order: close the browser's live connections first.
  t.after(async () => { await browser.close(); await app.dispose(); });
  const errors: string[] = [];

  async function register(name: string, email: string) {
    const page = await (await browser.newContext()).newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${app.origin}/auth/register`);
    await page.fill('input[name="name"]', name);
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', "browser password");
    await page.fill('input[name="rePassword"]', "browser password");
    await page.click('button[type="submit"]');
    await page.waitForURL(`${app.origin}/dashboard`);
    return page;
  }
  const userDir = async () => {
    const users = join(app.vaultPath, "posts", "_users");
    return join(users, (await readdir(users))[0]);
  };
  async function write(page: Page, summary: string, message: string, visibility: "Moi uniquement" | "Public") {
    await page.goto(`${app.origin}/dashboard`);
    await page.getByRole("button", { name: "Quoi de neuf ?" }).click();
    await page.waitForURL(/\/edit$/);
    const id = page.url().split("/").at(-2)!;
    await page.getByRole("button", { name: "Modifier « Résumé »" }).click();
    await page.getByRole("textbox", { name: "Résumé", exact: true }).fill(summary);
    // Regression: this click used to be swallowed by the summary collapsing on blur.
    await page.getByRole("button", { name: "Ajouter un message" }).click();
    await page.getByRole("textbox", { name: "Message 1", exact: true }).fill(message);
    await page.getByLabel("Visibilité").selectOption({ label: visibility });
    await page.getByText("Modifications enregistrées dans le vault").waitFor();
    await page.getByRole("main").getByRole("button", { name: "Publier", exact: true }).click();
    await page.waitForURL(`${app.origin}/dashboard/publications/${id}`);
    return id;
  }

  const author = await register("Browser Author", "author@example.com");
  await author.getByText("Votre fil vous attend").waitFor();
  const reader = await register("Browser Reader", "reader@example.com");

  const id = await write(author, "Résumé **navigateur**", "# Premier message\n\n- point un\n- point deux\n\n## Sources\n", "Public");
  const folder = join(await userDir(), "post_" + new Date().toISOString().slice(0, 10).replaceAll("-", "") + "_001");
  assert.match(await readFile(join(folder, "index.md"), "utf8"), /status: published\nvisibility: public/);
  assert.match(await readFile(join(folder, "1_premier_message.md"), "utf8"), /^# Premier message/);
  const secret = await write(author, "Note privée", "Seulement moi", "Moi uniquement");

  await t.test("the home feed shows rendered publications with only available actions", async () => {
    await reader.goto(`${app.origin}/dashboard`);
    const card = reader.getByRole("article", { name: "Publication de Browser Author" });
    await card.getByRole("heading", { name: "Premier message" }).waitFor();
    assert.equal(await card.locator("strong", { hasText: "navigateur" }).count(), 1);
    assert.equal(await card.locator(".xi-markdown li", { hasText: "point deux" }).count(), 1);
    for (const action of ["J’aime", "Pas intéressé", "Enregistrer", "Approfondir", "Dériver"]) {
      assert.equal(await card.getByRole("button", { name: `${action} (bientôt disponible)` }).count(), 0);
    }
    assert.equal(await card.getByRole("button", { name: "Supprimer" }).count(), 0);
    assert.equal(await card.getByRole("link", { name: "Modifier" }).count(), 0);
    await card.getByRole("button", { name: "Actions du message" }).first().click();
    assert.equal(await reader.getByRole("menuitem", { name: /Modifier|Supprimer/ }).count(), 0);
    await reader.keyboard.press("Escape");
    assert.equal(await reader.getByText("Note privée").count(), 0);
    await author.goto(`${app.origin}/dashboard`);
    const privateCard = author.getByRole("article", { name: "Publication de Browser Author" }).filter({ hasText: "Note privée" });
    await privateCard.getByText("Moi uniquement").waitFor();
    assert.ok((await author.locator("article").allInnerTexts()).findIndex((text) => text.includes("Note privée")) === 0, "newest first");
  });

  await t.test("deleting from the feed hides it everywhere, and Undo restores it", async () => {
    const card = author.getByRole("article", { name: "Publication de Browser Author" }).filter({ hasText: "Premier message" });
    await card.getByRole("button", { name: "Actions du message" }).first().focus();
    await author.keyboard.press("Enter");
    await author.getByRole("menuitem", { name: "Supprimer", exact: true }).click();
    await author.getByRole("dialog").getByRole("button", { name: "Supprimer", exact: true }).click();
    await author.getByRole("button", { name: "Mettre à la corbeille" }).click();
    await author.getByText("Déplacée dans votre corbeille").waitFor();
    await author.getByRole("article", { name: "Publication de Browser Author" }).filter({ hasText: "Premier message" }).waitFor({ state: "detached" });
    const trashed = join(app.vaultPath, "posts", ".trash", folder.split("/").at(-2)!, id);
    assert.deepEqual((await readdir(trashed)).sort(), [folder.split("/").at(-1)!, "trash.json"]);
    await reader.goto(`${app.origin}/dashboard`);
    assert.equal(await reader.getByText("Premier message").count(), 0);
    const old = await reader.goto(`${app.origin}/dashboard/publications/${id}`);
    assert.equal(old?.status(), 404);
    await reader.getByText("Publication indisponible").waitFor();

    await author.getByRole("button", { name: "Annuler", exact: true }).click();
    await author.getByText("Publication restaurée dans son dossier d’origine.").waitFor();
    await author.getByRole("article", { name: "Publication de Browser Author" }).filter({ hasText: "Premier message" }).waitFor();
    assert.match(await readFile(join(folder, "index.md"), "utf8"), /status: published/);
    assert.equal((await reader.goto(`${app.origin}/dashboard/publications/${id}`))?.status(), 200);
  });

  await t.test("deleting from the publication page, then restoring from the trash, with a folder collision", async () => {
    await author.goto(`${app.origin}/dashboard/publications/${id}`);
    await author.getByRole("button", { name: "Actions du message" }).first().click();
    await author.getByRole("menuitem", { name: "Supprimer", exact: true }).click();
    await author.getByRole("dialog").getByRole("button", { name: "Supprimer", exact: true }).click();
    await author.getByRole("button", { name: "Mettre à la corbeille" }).click();
    await author.waitForURL(`${app.origin}/dashboard/publications`);
    await author.getByText("Déplacée dans votre corbeille").waitFor();
    // Something else now occupies the original folder (for example created in Obsidian).
    await mkdir(folder);
    await writeFile(join(folder, "autre.md"), "Ne pas toucher");
    await author.goto(`${app.origin}/dashboard/publications/trash`);
    await author.getByText("Résumé navigateur").waitFor();
    await author.getByRole("button", { name: "Restaurer" }).click();
    await author.getByText(/elle se trouve maintenant dans post_\d{8}_003/).waitFor();
    await author.waitForURL(`${app.origin}/dashboard/publications/${id}/edit`);
    assert.equal(await readFile(join(folder, "autre.md"), "utf8"), "Ne pas toucher");
    await author.goto(`${app.origin}/dashboard/publications/trash`);
    await author.getByText("La corbeille est vide").waitFor();
    assert.equal((await reader.goto(`${app.origin}/dashboard/publications/${id}`))?.status(), 200);
  });

  await t.test("deleting from the editor saves pending edits first, without errors", async () => {
    await author.goto(`${app.origin}/dashboard/publications/${secret}/edit`);
    await author.getByRole("button", { name: "Modifier « Résumé »" }).click();
    await author.getByRole("textbox", { name: "Résumé", exact: true }).fill("Note privée modifiée");
    await author.getByRole("button", { name: "Enregistrer", exact: true }).waitFor();
    await author.getByRole("button", { name: "Supprimer" }).click();
    await author.getByRole("button", { name: "Mettre à la corbeille" }).click();
    await author.waitForURL(`${app.origin}/dashboard/publications`);
    await author.getByText("Déplacée dans votre corbeille").waitFor();
    const trashed = join(app.vaultPath, "posts", ".trash", (await userDir()).split("/").at(-1)!, secret);
    const [name] = (await readdir(trashed)).filter((entry) => entry.startsWith("post_"));
    assert.match(await readFile(join(trashed, name, "index.md"), "utf8"), /Note privée modifiée/);
    assert.equal(await author.getByText("Non enregistré").count(), 0);
  });

  assert.deepEqual(errors, []);
});
