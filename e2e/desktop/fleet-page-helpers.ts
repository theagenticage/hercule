/**
 * What the Fleet page's end-to-end files share (`fleet-page.test.ts` and
 * `fleet-machine.test.ts`): arranging the machines the page lists.
 */
import type { Page } from "playwright";

/** Returns the label of the sidebar's list, "Threads" or "Hercule": the face it shows. */
export function readSidebarList(page: Page): Promise<string | null> {
  return page
    .locator('nav[aria-label="Threads"], nav[aria-label="Hercule"]')
    .getAttribute("aria-label");
}
