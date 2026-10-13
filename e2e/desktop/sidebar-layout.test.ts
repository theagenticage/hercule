/**
 * Tests the sidebar's layout in the packaged app, signed in to a real
 * controller (spec 17, §The sidebar's layout): dragging its edge, a
 * double-click on the edge, hiding and showing it from the menu and its
 * buttons, and the layout kept across a relaunch.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { readSettings } from "../../apps/desktop/scripts/packaged-app";
import { arrangeFleet, chooseMenuItem, launchForTest, openSignedIn } from "./harness";

/** Returns the sidebar's drawn width, and whether the shell shows it, as the page lays them out. */
const readSidebar = (page: Page) =>
  page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".app")!;
    return {
      state: shell.dataset["sidebar"],
      width: Math.round(document.querySelector(".side-slot")!.getBoundingClientRect().width),
    };
  });

/** Drags the sidebar's edge from where it is by `dx` pixels, in steps, as a hand does. */
const dragEdge = async (page: Page, dx: number): Promise<void> => {
  const box = (await page.getByRole("separator", { name: "Resize the sidebar" }).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 8 });
  await page.mouse.up();
};

describe("the sidebar's layout", () => {
  it("resizes by its edge, hides and shows, and keeps its layout across a relaunch", async () => {
    const { url } = await arrangeFleet();
    const first = await openSignedIn(url);
    const { app, page } = first;
    await expect.poll(() => readSettings(first.userDataDir)["token"]).toBeTypeOf("string");
    expect(await readSidebar(page)).toEqual({ state: "open", width: 272 });

    // The edge runs through the 52px drag strip, so it must opt out of it:
    // macOS hands a press in a drag region to the window, to move it, before
    // the page sees it, which Playwright's events would not notice.
    const handle = page.getByRole("separator", { name: "Resize the sidebar" });
    expect((await handle.boundingBox())!.y).toBeLessThan(52);
    expect(
      await handle.evaluate((element) =>
        getComputedStyle(element).getPropertyValue("-webkit-app-region"),
      ),
    ).toBe("no-drag");

    await dragEdge(page, 60);
    expect(await readSidebar(page)).toEqual({ state: "open", width: 332 });
    // Past the widest width, the sidebar stops at it.
    await dragEdge(page, 400);
    expect(await readSidebar(page)).toEqual({ state: "open", width: 420 });

    await handle.dblclick();
    expect(await readSidebar(page)).toEqual({ state: "open", width: 272 });

    // Let go far enough left, the sidebar hides, and opens again at the
    // width it had before the drag.
    await dragEdge(page, 40);
    await dragEdge(page, -200);
    await expect.poll(() => readSidebar(page)).toEqual({ state: "closed", width: 0 });
    const show = page.getByRole("button", { name: "Show the sidebar ⌘B" });
    expect(
      await show.evaluate((element) =>
        getComputedStyle(element).getPropertyValue("-webkit-app-region"),
      ),
    ).toBe("no-drag");
    await show.click();
    await expect.poll(() => readSidebar(page)).toEqual({ state: "open", width: 312 });

    await chooseMenuItem(app, "View", "Toggle Sidebar");
    await expect.poll(() => readSidebar(page)).toEqual({ state: "closed", width: 0 });
    await chooseMenuItem(app, "View", "Toggle Sidebar");
    await expect.poll(() => readSidebar(page)).toEqual({ state: "open", width: 312 });

    await page.getByRole("button", { name: "Hide the sidebar ⌘B" }).click();
    await expect.poll(() => readSidebar(page)).toEqual({ state: "closed", width: 0 });
    // Once it has slid shut, the hidden sidebar is out of the accessibility
    // tree, so no role query finds its list.
    await expect
      .poll(() => page.getByRole("navigation", { name: "Threads", exact: true }).count())
      .toBe(0);
    await first.close();

    const { page: relaunched } = await launchForTest(first.userDataDir);
    await relaunched.getByRole("button", { name: "Show the sidebar ⌘B" }).waitFor();
    expect(await readSidebar(relaunched)).toEqual({ state: "closed", width: 0 });
    await relaunched.getByRole("button", { name: "Show the sidebar ⌘B" }).click();
    await expect.poll(() => readSidebar(relaunched)).toEqual({ state: "open", width: 312 });
  });
});
