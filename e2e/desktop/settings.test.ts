/**
 * Tests opening and leaving Settings in the packaged app, signed in to a real
 * controller:
 *
 * - the Settings button in the sidebar's foot opens Settings on Appearance,
 *   and is marked as the current page while Settings is open;
 * - Hercule › Settings… opens it too, and carries ⌘,;
 * - the rows of sections that are not built yet are inert: each says so in
 *   its tooltip, and pressing it leaves the open section as it was;
 * - in a window at its narrowest, a row's control stacks under its label,
 *   and a long username wraps inside the section instead of overflowing it;
 * - a thread row in the sidebar leaves Settings, and the Settings button is
 *   no longer the current page.
 *
 * Playwright's key presses reach the page, not the macOS menu bar, so they
 * cannot fire a menu item's shortcut. The second test checks that ⌘, is the
 * item's shortcut, and chooses the item as a click with the mouse does.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import {
  arrangeFleet,
  chooseMenuItem,
  openSignedIn,
  readMenuItems,
  startControllerForTest,
} from "./harness";

/** The rows of the Settings list whose sections are not built yet. */
const INERT_ROWS = [
  "Threads",
  "Connections",
  "Providers",
  "Machines",
  "Identities",
  "Permission profiles",
  "Secrets",
  "Bounds",
  "Plugins",
];

/** Returns the Settings button in the sidebar's foot. */
function findSettingsButton(page: Page) {
  return page.locator(".side-foot").getByRole("link", { name: "Settings" });
}

/**
 * Returns the label of the Settings list's row marked as the current page.
 * The app keeps its location in memory, so the page's URL never changes and
 * the marked row is where a test reads which section is open.
 */
function readCurrentSection(page: Page): Promise<string | null> {
  return page
    .getByRole("navigation", { name: "Settings" })
    .locator('[aria-current="page"]')
    .textContent();
}

/** Waits until Settings shows `section`, read from the header's title. */
async function waitForSection(page: Page, section: string): Promise<void> {
  await expect
    .poll(() => page.locator(".bar .title").textContent(), {
      message: `Settings did not open on ${section}`,
    })
    .toBe(section);
}

/** Opens Settings from the sidebar's foot, then its Profile section. */
async function openProfile(page: Page): Promise<void> {
  await findSettingsButton(page).click();
  await waitForSection(page, "Appearance");
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByText("Profile", { exact: true })
    .click();
  await waitForSection(page, "Profile");
}

describe("Settings", () => {
  it("opens on Appearance from the Settings button in the sidebar's foot, and marks the button as the current page", async () => {
    const { url } = await arrangeFleet();
    const { page } = await openSignedIn(url);
    const button = findSettingsButton(page);
    expect(await button.getAttribute("aria-current")).toBeNull();

    await button.click();

    await waitForSection(page, "Appearance");
    expect(await readCurrentSection(page)).toBe("Appearance");
    expect(await button.getAttribute("aria-current")).toBe("page");
  });

  it("opens from Hercule › Settings…, which carries ⌘,", async () => {
    const { url } = await arrangeFleet();
    const { app, page } = await openSignedIn(url);
    const items = await readMenuItems(app, "Hercule");
    expect(items.find((item) => item.label === "Settings…")).toEqual({
      label: "Settings…",
      accelerator: "CmdOrCtrl+,",
      enabled: true,
    });

    await chooseMenuItem(app, "Hercule", "Settings…");

    await waitForSection(page, "Appearance");
    expect(await findSettingsButton(page).getAttribute("aria-current")).toBe("page");
  });

  it("draws the rows of unbuilt sections inert: pressing one leaves the open section as it was", async () => {
    const { url } = await arrangeFleet();
    const { page } = await openSignedIn(url);
    await findSettingsButton(page).click();
    await waitForSection(page, "Appearance");
    const list = page.getByRole("navigation", { name: "Settings" });

    for (const label of INERT_ROWS) {
      const row = list.getByRole("button", { name: label, exact: true });
      expect(await row.getAttribute("aria-disabled"), label).toBe("true");
      expect(await row.getAttribute("title"), label).toBe("Not built yet");
      // Playwright waits for a row marked `aria-disabled` to be enabled
      // before it clicks, so the click is forced, as a user's click is.
      await row.click({ force: true });
      expect(await readCurrentSection(page), label).toBe("Appearance");
      expect(await page.locator(".bar .title").textContent(), label).toBe("Appearance");
    }
    // A navigation the clicks started would end after the checks above, so
    // the test waits a moment and checks once more.
    await page.waitForTimeout(300);
    expect(await readCurrentSection(page)).toBe("Appearance");
    expect(await page.locator(".bar .title").textContent()).toBe("Appearance");
  });

  it("stacks a row's control under its label in a window at its narrowest", async () => {
    const { url } = await arrangeFleet();
    const { app, page } = await openSignedIn(url);
    await openProfile(page);

    // 800 by 500 is the window's minimum size.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.setSize(800, 500);
    });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(800);

    const row = page.locator(".set-row", { hasText: "Time zone" });
    const label = await row.locator(".set-label").boundingBox();
    const control = await row.locator(".field--select").boundingBox();
    expect(label).not.toBeNull();
    expect(control).not.toBeNull();
    expect(control!.y).toBeGreaterThanOrEqual(label!.y + label!.height);
    expect(control!.x).toBe(label!.x);
  });

  it("keeps a long username inside the section in a window at its narrowest", async () => {
    // One long word, which a line cannot break between words.
    const username = "AlexanderVanDerMeer";
    const { url } = await startControllerForTest({ setUp: true, username });
    const { app, page } = await openSignedIn(url, username);
    await openProfile(page);

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.setSize(800, 500);
    });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(800);

    const body = page.locator(".set-body");
    const name = page.getByRole("heading", { level: 2, name: username });
    const bodyBox = await body.boundingBox();
    const nameBox = await name.boundingBox();
    expect(bodyBox).not.toBeNull();
    expect(nameBox).not.toBeNull();
    expect(nameBox!.x).toBeGreaterThanOrEqual(bodyBox!.x);
    expect(nameBox!.x + nameBox!.width).toBeLessThanOrEqual(bodyBox!.x + bodyBox!.width);
    expect(await name.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await body.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  });

  it("closes when the user opens a thread from the sidebar", async () => {
    const { url, fleet, waitForStatus } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const [thread] = await fleet.spawnThreads(1, { runner });
    await waitForStatus(thread!.id, "busy");
    const { page } = await openSignedIn(url);
    const button = findSettingsButton(page);
    await button.click();
    await waitForSection(page, "Appearance");

    await page
      .getByRole("navigation", { name: "Threads", exact: true })
      .locator("a.side-row", { hasText: "Thread 1" })
      .first()
      .click();

    await page.locator('section[aria-label="Transcript"]').waitFor();
    expect(await page.getByRole("navigation", { name: "Settings" }).count()).toBe(0);
    expect(await button.getAttribute("aria-current")).toBeNull();
  });
});
