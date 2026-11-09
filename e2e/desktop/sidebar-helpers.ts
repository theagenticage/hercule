/**
 * What the sidebar's end-to-end files share (`sidebar.test.ts`,
 * `sidebar-faces.test.ts` and `sidebar-large-project.test.ts`): reading the
 * sidebar's rows and arranging the threads they list.
 */
import type { Page } from "playwright";

/** Returns the counts line at the foot of the sidebar, such as "3 working · 1 waiting · 0 idle". */
export function readCounts(page: Page): Promise<string | null> {
  return page.locator(".side-sum").textContent();
}
