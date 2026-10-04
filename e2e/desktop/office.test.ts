/**
 * Tests opening the Office in the packaged app, signed in to a real
 * controller:
 *
 * - the Office button in the sidebar's actions row opens the Office, and is
 *   marked as the current page while the Office is open;
 * - Go › Office opens it too, and carries ⌘⇧O;
 * - nothing in the window is see-through while the Office is open, and the
 *   glass is back once the user leaves it.
 *
 * Playwright's key presses reach the page, not the macOS menu bar, so they
 * cannot fire a menu item's shortcut. The second test checks that ⌘⇧O is the
 * item's shortcut, and chooses the item as a click with the mouse does.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import type { Locator } from "playwright";
import { describe, expect, it } from "vitest";
import { arrangeFleet, chooseMenuItem, openSignedIn, readMenuItems } from "./harness";

/** Returns the backdrop filter the element `locator` finds is drawn with, such as "none". */
function readBackdropFilter(locator: Locator): Promise<string> {
  return locator.evaluate((element) => getComputedStyle(element).backdropFilter);
}

describe("the Office", () => {
  it("opens from the Office button in the sidebar, and marks the button as the current page", async () => {
    const { url } = await arrangeFleet();
    const { page } = await openSignedIn(url);
    const button = page.getByRole("link", { name: "Office ⌘⇧O" });
    expect(await button.getAttribute("aria-current")).toBeNull();

    await button.click();

    await page.locator(".office").waitFor();
    expect(await button.getAttribute("aria-current")).toBe("page");
  });

  it("opens from Go › Office, which carries ⌘⇧O", async () => {
    const { url } = await arrangeFleet();
    const { app, page } = await openSignedIn(url);
    const [first] = await readMenuItems(app, "Go");
    expect(first).toEqual({ label: "Office", accelerator: "CmdOrCtrl+Shift+O", enabled: true });

    await chooseMenuItem(app, "Go", "Office");

    await page.locator(".office").waitFor();
    expect(await page.getByRole("link", { name: "Office ⌘⇧O" }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("draws no blur while it is open, and the composer is glass again once the user leaves it", async () => {
    const { url, fleet, waitForStatus } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    // An asleep thread has no colleague, so Go opens it on its own screen
    // even while the Office is open.
    const [thread] = await fleet.spawnThreads(1, { runner });
    await waitForStatus(thread!.id, "busy");
    runner.endSession(thread!.id, "crash");
    await waitForStatus(thread!.id, "exited");
    const { app, page } = await openSignedIn(url);

    await chooseMenuItem(app, "Go", "Office");
    const pill = page.locator(".office-top .pill").first();
    await pill.waitFor();
    expect(await readBackdropFilter(pill)).toBe("none");

    await expect
      .poll(async () => (await readMenuItems(app, "Go")).map((item) => item.label))
      .toContain("Thread 1");
    await chooseMenuItem(app, "Go", "Thread 1");
    await page.locator(".office").waitFor({ state: "detached" });
    const composer = page.locator(".composer-card");
    await composer.waitFor();
    expect(await readBackdropFilter(composer)).not.toBe("none");
  });
});
