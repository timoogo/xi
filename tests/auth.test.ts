import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { verifyPassword } from "better-auth/crypto";
import { loginSchema, registerSchema } from "../src/lib/scheme/auth-scheme";
import { createTestServer } from "./helpers/next-server";
import { createPublicationStore } from "../src/lib/publications/store";
import { openVault } from "../src/lib/publications/vault";

const credentials = { email: "xi-test@example.com", password: "a long test password" };
const registration = { name: "Xi Test", ...credentials, rePassword: credentials.password };

test("form validation accepts email/password without phone", () => {
  assert.equal(registerSchema.safeParse(registration).success, true);
  assert.equal("phone" in registerSchema.parse({ ...registration, phone: "ignored" }), false);
  for (const change of [{ email: "bad" }, { name: "" }, { password: "short" }, { password: "x".repeat(129) }, { rePassword: "different" }]) {
    assert.equal(registerSchema.safeParse({ ...registration, ...change }).success, false);
  }
  assert.equal(loginSchema.safeParse({ ...credentials, password: "legacy" }).success, true);
  assert.equal(loginSchema.safeParse({ ...credentials, password: "" }).success, false);
});

// Exercise the exact Server Actions referenced by the built forms, over real HTTP.
async function actionIds() {
  const ids: Record<string, string> = {};
  async function scan(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await scan(path);
      else if (entry.name.endsWith(".js")) {
        const source = await readFile(path, "utf8");
        for (const match of source.matchAll(/createServerReference\)\("([a-f0-9]+)",[^)]*?"(\w+)"\)/g)) ids[match[2]] = match[1];
      }
    }
  }
  await scan(join(process.env.NEXT_DIST_DIR || ".next", "static/chunks"));
  for (const name of ["Register", "logIn", "Logout", "savePublication"]) assert.ok(ids[name], `Build first with pnpm build (missing ${name} action).`);
  return ids;
}

test("real Next.js authentication with temporary SQLite and process restart", { timeout: 120000 }, async (t) => {
  const ids = await actionIds();
  const app = await createTestServer();
  const { origin, databasePath, vaultPath, migrate, start, stop } = app;
  t.after(app.dispose);
  function cookieFrom(response: Response) {
    const value = response.headers.getSetCookie().find((cookie) => cookie.startsWith("xi.session_token="));
    assert.ok(value, "A real session cookie must be set");
    assert.match(value, /HttpOnly/i);
    assert.match(value, /SameSite=Lax/i);
    return value.split(";")[0];
  }
  async function action(name: string, args: unknown[], cookie = "", path = `/auth/${name === "Register" ? "register" : "login"}`) {
    const response = await fetch(`${origin}${path}`, {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/json", "Next-Action": ids[name], Origin: origin, Cookie: cookie },
      body: JSON.stringify(args),
    });
    const body = await response.text();
    assert.equal(response.status, 200, `${name} returned HTTP ${response.status}`);
    const result = body.match(/\d+:(\{"ok":(?:true|false)[^\n]*\})/);
    assert.ok(result, `Missing ${name} action result: ${body.slice(0, 300)}`);
    return { response, result: JSON.parse(result[1]) as { ok: boolean; message?: string } };
  }
  async function session(cookie: string) {
    const response = await fetch(`${origin}/api/auth/get-session`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    return response.json();
  }
  async function denied(cookie = "") {
    const response = await fetch(`${origin}/dashboard/profile`, { redirect: "manual", headers: { Cookie: cookie } });
    assert.equal(response.status, 307);
    assert.equal(new URL(response.headers.get("location")!, origin).pathname, "/auth/login");
  }
  await migrate();
  await migrate();
  await start();
  let cookie = "";

  await t.test("anonymous and forged cookies cannot access the dashboard", async () => {
    await denied();
    await denied("token=old-twitty-token");
    await denied("xi.session_token=forged");
  });
  await t.test("registration through the form's Server Action persists a hashed password, without phone", async () => {
    const invalid = await action("Register", [{ ...registration, rePassword: "wrong" }]);
    assert.equal(invalid.result.ok, false);
    const created = await action("Register", [registration]);
    assert.equal(created.result.ok, true);
    cookie = cookieFrom(created.response);
    const db = new Database(databasePath, { readonly: true });
    try {
      const user = db.prepare('SELECT * FROM "user" WHERE email = ?').get(credentials.email) as Record<string, unknown>;
      assert.equal(user.name, registration.name);
      assert.equal("phone" in user, false);
      const account = db.prepare('SELECT password FROM account WHERE "userId" = ?').get(user.id) as { password: string };
      assert.notEqual(account.password, credentials.password);
      assert.equal(await verifyPassword({ hash: account.password, password: credentials.password }), true);
    } finally { db.close(); }
    assert.equal((await session(cookie)).user.email, credentials.email);
    const duplicate = await action("Register", [registration]);
    assert.equal(duplicate.result.ok, false);
    assert.match(duplicate.result.message!, /already registered/);
  });
  await t.test("private pages show only the current account, with no demo content", async () => {
    const otherCredentials = { email: "xi-other@example.com", password: "another private password" };
    const other = await action("Register", [{ name: "Xi Other", ...otherCredentials, rePassword: otherCredentials.password }]);
    assert.equal(other.result.ok, true);
    const otherCookie = cookieFrom(other.response);
    const firstUser = (await session(cookie)).user;
    const otherUser = (await session(otherCookie)).user;
    const paths = ["/dashboard", "/dashboard/profile", "/dashboard/notifications", "/dashboard/communites", "/dashboard/explore", "/dashboard/about-us", "/dashboard/terms"];
    const demo = /Ramy Esam|ramyesam|Jesus For Ever|AIDailyNews|Lorem ipsum|Retweeted|Recommended People|Post has been published|images\.unsplash\.com/;
    for (const path of paths) {
      // Concurrent requests must not share a cached identity; query IDs cannot select another user.
      const [firstResponse, otherResponse, anonymous] = await Promise.all([
        fetch(`${origin}${path}?userId=${otherUser.id}`, { headers: { Cookie: cookie }, redirect: "manual" }),
        fetch(`${origin}${path}?userId=${firstUser.id}`, { headers: { Cookie: otherCookie }, redirect: "manual" }),
        fetch(`${origin}${path}`, { redirect: "manual" }),
      ]);
      assert.equal(firstResponse.status, 200);
      assert.equal(otherResponse.status, 200);
      assert.match(firstResponse.headers.get("cache-control") || "", /private|no-store/);
      assert.equal(anonymous.status, 307);
      assert.doesNotMatch(await anonymous.text(), /xi-test@example.com|xi-other@example.com/);
      const firstHtml = await firstResponse.text();
      const otherHtml = await otherResponse.text();
      assert.ok(firstHtml.includes(registration.name));
      assert.ok(otherHtml.includes("Xi Other"));
      assert.ok(!firstHtml.includes("Xi Other"));
      assert.ok(!otherHtml.includes(registration.name));
      assert.ok(!firstHtml.includes(otherCredentials.email));
      assert.ok(!otherHtml.includes(credentials.email));
      for (const html of [firstHtml, otherHtml]) {
        assert.doesNotMatch(html, demo);
        assert.ok(!html.includes('href="/dashboard/communites"'));
        assert.ok(!html.includes('href="/dashboard/profile/') );
        assert.ok(html.includes('aria-label="Ouvrir le menu"'));
        assert.ok(html.includes('href="/dashboard/notifications"'));
        assert.ok(html.includes('aria-label="Default avatar"'));
      }
      if (path === "/dashboard/profile") {
        assert.ok(firstHtml.includes(credentials.email));
        assert.ok(otherHtml.includes(otherCredentials.email));
        assert.ok(firstHtml.includes(`@xi-${firstUser.id.slice(0, 8)}`));
        assert.ok(otherHtml.includes(`@xi-${otherUser.id.slice(0, 8)}`));
        assert.ok(!firstHtml.includes(`@xi-${firstUser.id}`));
        assert.ok(firstHtml.includes("Rien de publié pour l’instant"));
        assert.ok(firstHtml.includes("Il n’y a encore aucune publication."));
      }
      if (path === "/dashboard") {
        assert.ok(firstHtml.includes("Votre fil vous attend"));
        assert.ok(firstHtml.includes("Il n’y a encore aucune publication."));
        assert.ok(firstHtml.includes("Quoi de neuf ?"));
      }
      if (path === "/dashboard/notifications") assert.ok(firstHtml.includes("Les notifications ne sont pas encore disponibles"));
      if (path === "/dashboard/communites") assert.ok(firstHtml.includes("Les communautés ne sont pas encore disponibles"));
      if (path === "/dashboard/explore") assert.ok(firstHtml.includes("L’exploration arrive bientôt"));
    }
    for (const path of ["/", "/auth/login", "/auth/register"]) {
      const publicPage = await fetch(`${origin}${path}`);
      assert.equal(publicPage.status, 200);
      assert.doesNotMatch(await publicPage.text(), /xi-test@example.com|xi-other@example.com|Forget Password/);
    }
    const db = new Database(databasePath);
    try { db.prepare('UPDATE "user" SET image = ? WHERE id = ?').run("/xi.svg", otherUser.id); }
    finally { db.close(); }
    const withAvatar = await fetch(`${origin}/dashboard/profile`, { headers: { Cookie: otherCookie } });
    assert.match(await withAvatar.text(), /alt="Xi Other[^"]*avatar"/);
    const ownSession = await fetch(`${origin}/api/auth/get-session?userId=${otherUser.id}`, { headers: { Cookie: cookie } });
    const ownPayload = await ownSession.json();
    assert.equal(ownPayload.user.email, credentials.email);
    assert.ok(!JSON.stringify(ownPayload).includes(otherCredentials.email));
    const otherLogout = await action("Logout", [], otherCookie);
    assert.equal(otherLogout.result.ok, true);
    await denied(otherCookie);
    assert.equal((await session(cookie)).user.email, credentials.email);
  });
  await t.test("logout revokes the session; correct credentials sign in again", async () => {
    const loggedOut = await action("Logout", [], cookie);
    assert.equal(loggedOut.result.ok, true);
    assert.equal(await session(cookie), null);
    await denied(cookie);
    const invalid = await action("logIn", [{ ...credentials, password: "wrong password" }]);
    assert.equal(invalid.result.ok, false);
    assert.match(invalid.result.message!, /Invalid email or password/);
    assert.equal(invalid.response.headers.getSetCookie().some((value) => value.startsWith("xi.session_token=")), false);
    const loggedIn = await action("logIn", [credentials]);
    assert.equal(loggedIn.result.ok, true);
    cookie = cookieFrom(loggedIn.response);
    const page = await fetch(`${origin}/dashboard/profile`, { headers: { Cookie: cookie }, redirect: "manual" });
    assert.equal(page.status, 200);
    const loginPage = await fetch(`${origin}/auth/login`, { headers: { Cookie: cookie }, redirect: "manual" });
    assert.equal(loginPage.status, 307);
  });
  await t.test("publications: Markdown files, private drafts, public reading and trash over HTTP", async () => {
    const reader = await action("Register", [{ name: "Xi Reader", email: "xi-reader@example.com", password: "reader password", rePassword: "reader password" }]);
    const readerCookie = cookieFrom(reader.response);
    const author = (await session(cookie)).user;
    const db = new Database(databasePath);
    db.pragma("busy_timeout = 5000");
    t.after(() => db.close());
    // The test process writes the same vault and index a second process (Obsidian, sync) could.
    const store = createPublicationStore({ vault: await openVault(vaultPath), db });
    const id = await store.create(author);
    const draft = await store.getEditable(author, id);
    const page = (path: string, cookieValue: string) => fetch(`${origin}${path}`, { headers: { Cookie: cookieValue }, redirect: "manual" });

    assert.equal((await page(`/dashboard/publications/${id}/edit`, cookie)).status, 200);
    for (const path of [`/dashboard/publications/${id}`, `/dashboard/publications/${id}/edit`]) {
      assert.equal((await page(path, readerCookie)).status, 404);
      assert.equal((await page(path, "")).status, 307);
    }
    const foreign = await action("savePublication", [id, { baseRevision: draft.revision, summary: "hijack", visibility: "public", messages: [] }], readerCookie, `/dashboard/publications/${id}/edit`);
    assert.equal(foreign.result.ok, false);
    // Anonymous action calls never reach the action: the middleware redirects them to the login page.
    const anonymous = await fetch(`${origin}/dashboard/publications/${id}/edit`, {
      method: "POST", redirect: "manual", headers: { "Content-Type": "application/json", "Next-Action": ids.savePublication, Origin: origin },
      body: JSON.stringify([id, { baseRevision: draft.revision, summary: "hijack", visibility: "public", messages: [] }]),
    });
    assert.equal(anonymous.status, 307);
    const saved = await action("savePublication", [id, { baseRevision: draft.revision, summary: "Résumé **public**", visibility: "public", messages: [{ key: "a", file: null, body: "Premier message [[Note Obsidian]]" }] }], cookie, `/dashboard/publications/${id}/edit`);
    assert.equal(saved.result.ok, true);
    const indexFile = join(vaultPath, "posts", "_users", author.id, "post_" + draft.createdAt.slice(0, 10).replaceAll("-", "") + "_001", "index.md");
    assert.match(await readFile(indexFile, "utf8"), /status: draft\nvisibility: public[\s\S]*Résumé \*\*public\*\*/);
    assert.equal((await page(`/dashboard/publications/${id}`, readerCookie)).status, 404);
    assert.doesNotMatch(await (await page("/dashboard", readerCookie)).text(), /Résumé/);

    const current = await store.getEditable(author, id);
    assert.ok((await store.publish(author, id, current.revision)).ok);
    const view = await page(`/dashboard/publications/${id}`, readerCookie);
    assert.equal(view.status, 200);
    const html = await view.text();
    assert.match(html, /<strong>public<\/strong>/);
    assert.match(html, /class="xi-wikilink"[^>]*>Note Obsidian/);
    assert.doesNotMatch(html, new RegExp(vaultPath.replaceAll("/", "\\/")));
    assert.match(await (await page("/dashboard", readerCookie)).text(), /Résumé <strong>public<\/strong>/);

    await store.trash(author, id);
    assert.equal((await page(`/dashboard/publications/${id}`, readerCookie)).status, 404);
    assert.doesNotMatch(await (await page("/dashboard", readerCookie)).text(), /Résumé <strong>public<\/strong>/);
    assert.match(await (await page("/dashboard/publications/trash", cookie)).text(), /Résumé public/);
    assert.doesNotMatch(await (await page("/dashboard/publications/trash", readerCookie)).text(), /Résumé public/);
  });
  await t.test("session and account survive process restart and a repeated migration", async () => {
    await stop();
    await migrate();
    await start();
    assert.equal((await session(cookie)).user.email, credentials.email);
    const page = await fetch(`${origin}/dashboard/profile`, { headers: { Cookie: cookie }, redirect: "manual" });
    assert.equal(page.status, 200);
  });
  await t.test("HTTP auth endpoints reject cross-origin mutation and accept real credentials", async () => {
    const blocked = await fetch(`${origin}/api/auth/sign-out`, {
      method: "POST", headers: { Origin: "https://untrusted.example", Cookie: cookie, "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(blocked.status, 403);
    assert.ok(await session(cookie));
    const logout = await fetch(`${origin}/api/auth/sign-out`, {
      method: "POST", headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(logout.status, 200);
    assert.equal(await session(cookie), null);
    await denied(cookie);
    const login = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(credentials),
    });
    assert.equal(login.status, 200);
    cookie = cookieFrom(login);
    assert.equal((await session(cookie)).user.email, credentials.email);
  });
  await t.test("expired sessions cannot access protected pages", async () => {
    const db = new Database(databasePath);
    try { db.prepare('UPDATE session SET expiresAt = 0').run(); }
    finally { db.close(); }
    assert.equal(await session(cookie), null);
    await denied(cookie);
  });

});
