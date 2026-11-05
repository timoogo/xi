import type { Locator } from "playwright-core";

/**
 * Resolves once React has hydrated `locator`'s element (its props are attached). A server-rendered
 * control is visible and focusable before that, but a click, a key or a select change sent earlier
 * reaches no handler and is lost: wait for this after `goto`/`reload`, before interacting.
 * Bounded by the page's default timeout.
 */
export async function hydrated(locator: Locator) {
  const element = await locator.elementHandle();
  await locator.page().waitForFunction(node => !!node && Object.keys(node).some(key => key.startsWith("__reactProps$")), element);
}
