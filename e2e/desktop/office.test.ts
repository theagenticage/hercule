/**
 * Tests opening the Office in the packaged app, signed in to a real
 * controller:
 *
 * - the Office button in the sidebar's actions row opens the Office, and is
 *   marked as the current page while the Office is open;
 * - Go › Office opens it too, and carries ⌘⇧O.
 *
 * Playwright's key presses reach the page, not the macOS menu bar, so they
 * cannot fire a menu item's shortcut. The second test checks that ⌘⇧O is the
 * item's shortcut, and chooses the item as a click with the mouse does.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import { describe, expect, it } from "vitest";
import { arrangeFleet, chooseMenuItem, openSignedIn, readMenuItems } from "./harness";

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
});
