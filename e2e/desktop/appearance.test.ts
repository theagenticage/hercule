/**
 * Tests Settings > Appearance in the packaged app, signed in to a real
 * controller (spec 17 §Settings, Appearance):
 *
 * - a theme picked on the page repaints the window's background at once;
 * - a theme and a Glass level picked on the page are saved on this Mac, and
 *   the next launch starts in them: the window is created with the theme's
 *   background, and the page has the theme and the level before its first
 *   paint;
 * - the glass filter is `none`, so no backdrop filter is drawn, while the
 *   app's Reduce transparency is on, while the Glass level is 0, and while
 *   macOS's Reduce transparency is on. macOS's setting also shows the switch
 *   as on, and disables it.
 *
 * The glass filter is read as reduce-transparency.test.ts reads it: from the
 * `--glass-filter` token, on a probe element.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { readSettings } from "../../apps/desktop/scripts/packaged-app";
import { arrangeFleet, launchForTest, openSignedIn } from "./harness";

/** Nile's `--bg` in sRGB, which main paints the window with while Nile is in use. */
const NILE_BACKGROUND = "#0e1714";

/** Opens Settings from the sidebar's foot, and waits for its first section, Appearance. */
async function openAppearance(page: Page): Promise<void> {
  await page.locator(".side-foot").getByRole("link", { name: "Settings" }).click();
  await expect.poll(() => page.locator(".bar .title").textContent()).toBe("Appearance");
}

/**
 * Returns what `--glass-filter` computes to on a probe element added to the
 * page's body: `none`, or the blur every glass surface draws.
 */
function readGlassFilter(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.backdropFilter = "var(--glass-filter)";
    document.body.append(probe);
    const filter = getComputedStyle(probe).backdropFilter;
    probe.remove();
    return filter;
  });
}

/**
 * Moves the focused Glass slider by `steps` of 1%, with the arrow keys, as a
 * user does. Each key press changes the level, and its keyup saves it.
 */
async function moveGlassSlider(page: Page, steps: number): Promise<void> {
  const slider = page.getByRole("slider", { name: "Glass" });
  await slider.focus();
  for (let step = 0; step < Math.abs(steps); step++) {
    await slider.press(steps > 0 ? "ArrowRight" : "ArrowLeft");
  }
}

describe("Settings > Appearance", () => {
  it("starts the next launch in the picked theme and Glass level, from its first frame", async () => {
    const { url } = await arrangeFleet();
    const first = await openSignedIn(url);
    await openAppearance(first.page);

    await first.page.getByRole("button", { name: "Nile dark", exact: true }).click();
    await expect
      .poll(() => first.page.evaluate(() => document.documentElement.dataset["theme"]))
      .toBe("nile");
    // Main repaints the window's background as soon as the theme changes,
    // not only at the next launch.
    await expect
      .poll(() =>
        first.app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.getBackgroundColor().toLowerCase(),
        ),
      )
      .toBe(NILE_BACKGROUND);
    await moveGlassSlider(first.page, 30);
    expect(
      await first.page.getByRole("slider", { name: "Glass" }).getAttribute("aria-valuetext"),
    ).toBe("70%");
    // The page shows a change at once and saves it over IPC, so the test
    // waits for the settings file before it quits the app.
    await expect
      .poll(() => readSettings(first.userDataDir)["appearance"])
      .toMatchObject({ theme: "nile", followSystem: false, glassPercent: 70 });
    await first.close();

    let createdBackground: string | undefined;
    let firstTheme: { theme: string | undefined; glassPercent: string } | undefined;
    const second = await launchForTest(first.userDataDir, async (app, page) => {
      // The window exists but has not drawn the page yet: its background is
      // what the window shows first.
      createdBackground = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.getBackgroundColor().toLowerCase(),
      );
      // theme-init.js runs from the document's head, before the body is
      // parsed. Read as soon as the document is parsed, the theme and the
      // level are those of the page's first paint.
      await page.waitForLoadState("domcontentloaded");
      firstTheme = await page.evaluate(() => ({
        theme: document.documentElement.dataset["theme"],
        glassPercent: document.documentElement.style.getPropertyValue("--glass-percent"),
      }));
    });

    expect(createdBackground).toBe(NILE_BACKGROUND);
    expect(firstTheme).toEqual({ theme: "nile", glassPercent: "70" });
    // The level reaches the glass: a blur, not the solid fallback.
    expect(await readGlassFilter(second.page)).toMatch(/^blur\(/);
  });

  it("draws no backdrop filter with Reduce transparency on, at a Glass level of 0, or while macOS reduces transparency", async () => {
    const { url } = await arrangeFleet();
    const { page } = await openSignedIn(url);
    await openAppearance(page);
    // Playwright's `emulateMedia` has no switch for this media feature, so
    // the test asks Chromium directly.
    const session = await page.context().newCDPSession(page);
    const emulateReducedTransparency = (value: "reduce" | "no-preference") =>
      session.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-transparency", value }],
      });
    await emulateReducedTransparency("no-preference");
    const toggle = page.getByRole("switch", { name: "Reduce transparency" });
    expect(await readGlassFilter(page)).toMatch(/^blur\(/);

    // The app's own Reduce transparency.
    await toggle.click();
    await expect.poll(() => toggle.getAttribute("aria-checked")).toBe("true");
    expect(await readGlassFilter(page)).toBe("none");
    await toggle.click();
    await expect.poll(() => toggle.getAttribute("aria-checked")).toBe("false");
    expect(await readGlassFilter(page)).toMatch(/^blur\(/);

    // A Glass level of 0, from the default 40.
    await moveGlassSlider(page, -40);
    expect(await page.getByRole("slider", { name: "Glass" }).getAttribute("aria-valuetext")).toBe(
      "0%",
    );
    expect(await readGlassFilter(page)).toBe("none");
    await moveGlassSlider(page, 40);
    expect(await readGlassFilter(page)).toMatch(/^blur\(/);

    // macOS's Reduce transparency: the switch shows as on and cannot be
    // turned off, and the glass is solid.
    await emulateReducedTransparency("reduce");
    await expect.poll(() => toggle.getAttribute("aria-checked")).toBe("true");
    expect(await toggle.isDisabled()).toBe(true);
    expect(await readGlassFilter(page)).toBe("none");
  });
});
