/**
 * Tests the sidebar's two faces in the packaged app, signed in to a real
 * controller whose threads a fleet of scripted runners puts in known states
 * (spec 17, §Design system, **The sidebar**):
 *
 * - the face switch, Threads | Hercule, sits in the window's drag strip and
 *   still takes a click; it, View › Threads and View › Hercule (⌥⌘1, ⌥⌘2),
 *   and ← and → on its focused segment change the face without leaving the
 *   screen;
 * - the Office and Settings keep the Hercule face, and opening a thread shows
 *   the Threads face.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { arrangeFleet, chooseMenuItem, openSignedIn, openThread } from "./harness";

/**
 * Returns which face the sidebar shows, as the face switch's selected segment
 * and the label of the list under it, such as
 * `{ tab: "Hercule", list: "Hercule" }`. The list is the sidebar's `nav`,
 * named "Threads" on the threads face and "Hercule" on the Hercule face.
 */
async function readSidebarFace(page: Page): Promise<{ tab: string | null; list: string | null }> {
  const tab = page.getByRole("tablist", { name: "Sidebar" }).locator('[aria-selected="true"]');
  const list = page.locator('nav[aria-label="Threads"], nav[aria-label="Hercule"]');
  return { tab: await tab.textContent(), list: await list.getAttribute("aria-label") };
}

const THREADS_FACE = { tab: "Threads", list: "Threads" };
const ORCHESTRATION_FACE = { tab: "Hercule", list: "Hercule" };

describe("the sidebar's faces", () => {
  it("changes the face from the switch in the drag strip, from View's items and with ← and →, without leaving the thread", async () => {
    const { url, fleet, waitForStatus } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const [thread] = await fleet.spawnThreads(1, { runner });
    await waitForStatus(thread!.id, "busy");
    const { app, page } = await openSignedIn(url);
    await openThread(page, "Thread 1");
    const transcript = page.locator('section[aria-label="Transcript"]');
    const switchList = page.getByRole("tablist", { name: "Sidebar" });
    const orchestrationTab = switchList.getByRole("tab", { name: "Hercule" });
    const threadsTab = switchList.getByRole("tab", { name: "Threads" });
    expect(await readSidebarFace(page)).toEqual(THREADS_FACE);

    // The switch sits in the shell's 52px drag strip. macOS hands a mouse
    // press in a drag region to the window, to move it, before the page sees
    // it; Playwright's click reaches the page directly and would not notice.
    // So the test reads that the switch opts out of the drag region, as
    // Chromium reports it to macOS, and then clicks it.
    const box = (await switchList.boundingBox())!;
    expect(box.y).toBeLessThan(52);
    expect(
      await switchList.evaluate((element) =>
        getComputedStyle(element).getPropertyValue("-webkit-app-region"),
      ),
    ).toBe("no-drag");
    await orchestrationTab.click();
    await expect.poll(() => readSidebarFace(page)).toEqual(ORCHESTRATION_FACE);
    await transcript.waitFor();

    // Only the selected segment is in the tab order, and the arrow keys move
    // both the selection and the focus.
    expect(await orchestrationTab.evaluate((element) => element === document.activeElement)).toBe(
      true,
    );
    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => readSidebarFace(page)).toEqual(THREADS_FACE);
    expect(await threadsTab.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => readSidebarFace(page)).toEqual(ORCHESTRATION_FACE);

    await chooseMenuItem(app, "View", "Threads");
    await expect.poll(() => readSidebarFace(page)).toEqual(THREADS_FACE);
    await chooseMenuItem(app, "View", "Hercule");
    await expect.poll(() => readSidebarFace(page)).toEqual(ORCHESTRATION_FACE);
    await transcript.waitFor();
  });

  it("keeps the Hercule face in the Office and Settings, and shows the Threads face once a thread opens", async () => {
    const { url, fleet, waitForStatus } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const [thread] = await fleet.spawnThreads(1, { runner });
    await waitForStatus(thread!.id, "busy");
    const { app, page } = await openSignedIn(url);
    await page
      .getByRole("tablist", { name: "Sidebar" })
      .getByRole("tab", { name: "Hercule" })
      .click();
    await expect.poll(() => readSidebarFace(page)).toEqual(ORCHESTRATION_FACE);

    await page.getByRole("link", { name: "Office ⌘⇧O" }).click();
    await page.locator(".office").waitFor();
    expect(await readSidebarFace(page)).toEqual(ORCHESTRATION_FACE);

    await page.locator(".side-foot").getByRole("link", { name: "Settings" }).click();
    await expect.poll(() => page.locator(".bar .title").textContent()).toBe("Appearance");
    expect(await readSidebarFace(page)).toEqual(ORCHESTRATION_FACE);

    // The Hercule face lists no threads that do not wait, so the thread opens
    // from Go, which lists the threads whichever face shows.
    await chooseMenuItem(app, "Go", "Thread 1");
    await page.locator('section[aria-label="Transcript"]').waitFor();
    await expect.poll(() => readSidebarFace(page)).toEqual(THREADS_FACE);
  });
});
