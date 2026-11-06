import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { Browser } from "playwright-core";

/**
 * Browser test diagnostics, written only when the test fails: a screenshot, URL and title of every
 * open page, the server's recent output and the vault tree, under `XI_E2E_ARTIFACTS` (CI uploads it).
 * Register it before the hook that closes the browser and stops the server: node:test runs after
 * hooks in registration order. Collection errors are reported, never thrown over the test's own.
 */
export function diagnoseOnFailure(t: TestContext, app: { output: () => string; vaultPath: string }, browser: () => Browser | undefined) {
  t.after(async () => {
    // TestContext.passed exists since Node 20.12; the installed @types/node 20 does not declare it.
    if ((t as TestContext & { readonly passed: boolean }).passed) return;
    const directory = join(process.env.XI_E2E_ARTIFACTS || join(tmpdir(), "xi-e2e-artifacts"), `${t.name.replace(/[^\w-]+/g, "-").slice(0, 80)}-${Date.now()}`);
    const step = async (label: string, task: () => Promise<unknown>) => {
      try { await task(); } catch (error) { console.error(`E2E diagnostics: ${label} failed: ${error instanceof Error ? error.message : error}`); }
    };
    await mkdir(directory, { recursive: true });
    await step("server output", () => writeFile(join(directory, "server.log"), app.output()));
    await step("vault tree", async () => writeFile(join(directory, "vault.txt"), (await readdir(app.vaultPath, { recursive: true })).sort().join("\n") + "\n"));
    const pages = browser()?.contexts().flatMap(context => context.pages()) ?? [];
    const summary: string[] = [];
    for (const [index, page] of pages.entries()) {
      await step(`page ${index}`, async () => {
        summary.push(`page-${index}: ${page.url()} — ${await page.title()}`);
        await page.screenshot({ path: join(directory, `page-${index}.png`), fullPage: true, timeout: 10_000 });
      });
    }
    await step("pages", () => writeFile(join(directory, "pages.txt"), summary.join("\n") + "\n"));
    console.error(`E2E diagnostics for "${t.name}": ${directory}`);
  });
}
