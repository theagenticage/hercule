/**
 * Tests the desktop app's one window as a user meets it: where it opens, how it
 * looks in light and dark, what closing it does, what a second launch does, and
 * that it reopens where it was (spec 17, §Process model and §Native behaviour).
 *
 * Every test starts the packaged test package with a fresh user data directory,
 * so no test sees another's settings. Run `pnpm build:desktop` first.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright";
import { describe, expect, it } from "vitest";
import { isWindowVisible } from "../../apps/desktop/scripts/packaged-app";
import {
  createUserDataDirForTest,
  launchForTest,
  runSecondInstance,
  type PageGlobal,
} from "./harness";

/**
 * `--bg` of the two themes the window follows, in sRGB: Whitehaven when macOS
 * is light, Orient Express when it is dark (spec 17, §Native behaviour). Main
 * paints the window with it before the page draws, so the window never flashes
 * another colour.
 */
const BACKGROUND = { light: "#f4f3f0", dark: "#1a1310" } as const;

/**
 * The appearances a test flips the app through, with the theme each one
 * gives. Light, dark, light: whichever appearance the machine starts in, the
 * window changes at least once in each direction.
 */
const APPEARANCE_FLIPS = [
  { source: "light", background: BACKGROUND.light, theme: "whitehaven" },
  { source: "dark", background: BACKGROUND.dark, theme: "orient-express" },
  { source: "light", background: BACKGROUND.light, theme: "whitehaven" },
] as const;

/**
 * Sets the app's own appearance, as macOS does when the user switches between
 * light and dark. It changes `nativeTheme.themeSource` rather than the
 * machine's appearance, so nothing outside the app changes.
 */
function setAppearance(app: ElectronApplication, source: "light" | "dark"): Promise<void> {
  return app.evaluate(({ nativeTheme }, themeSource) => {
    nativeTheme.themeSource = themeSource;
  }, source);
}

/** Reads the theme the page is on. */
function readTheme(page: Page): Promise<string | undefined> {
  return page.evaluate(() => document.documentElement.dataset["theme"]);
}

/** The page's record of each theme change; see the test that installs it. */
type ThemeChangeLog = typeof globalThis & {
  themeChanges?: Array<{ theme: string | undefined; running: string[] }>;
};

/** Counts the app's windows, hidden ones included. */
function countWindows(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
}

describe("the window", () => {
  it("opens once, at app://hercule/, and the bridge reads no saved controller", async () => {
    const { app, page } = await launchForTest();

    expect(page.url()).toBe("app://hercule/");
    expect(await countWindows(app)).toBe(1);
    expect(
      await page.evaluate(() => (globalThis as PageGlobal).bridge.controllerUrl.read()),
    ).toBeNull();
  });

  it("sits the traffic lights where the Bureau pages draw them", async () => {
    const { app } = await launchForTest();

    const position = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.getWindowButtonPosition(),
    );
    expect(position).toEqual({ x: 19, y: 16 });
  });

  it("paints --bg of the current appearance, and follows the appearance live", async () => {
    const { app, page } = await launchForTest();

    const readBackground = () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.getBackgroundColor().toLowerCase(),
      );

    const darkAtLaunch = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
    expect(await readBackground()).toBe(darkAtLaunch ? BACKGROUND.dark : BACKGROUND.light);

    for (const { source, background, theme } of APPEARANCE_FLIPS) {
      await setAppearance(app, source);
      await expect.poll(readBackground).toBe(background);
      await expect.poll(() => readTheme(page)).toBe(theme);
    }
  });

  it("snaps to the new theme when the appearance changes, with no control fading to its new colours", async () => {
    const { app, page } = await launchForTest();

    // The check means something only if a control on screen has a transition
    // that a theme change would start. The welcome's Open the office button
    // fades its background, which differs between the two themes. The test
    // waits for the button to turn on, when the welcome has stopped looking
    // for Hercule, because its spinner would otherwise be running.
    const button = page.getByRole("button", { name: "Open the office", disabled: false });
    await button.waitFor();
    expect(
      await button.evaluate((element) => getComputedStyle(element).transitionProperty),
    ).toContain("background");

    // Records, right after each theme change, the transitions and animations
    // that are running. `getAnimations` recalculates the page's style first,
    // so a transition that the change starts is in the list. The observer's
    // callback runs in the same task as the change, before the next frame.
    await page.evaluate(() => {
      const changes: NonNullable<ThemeChangeLog["themeChanges"]> = [];
      (globalThis as ThemeChangeLog).themeChanges = changes;
      new MutationObserver(() => {
        changes.push({
          theme: document.documentElement.dataset["theme"],
          running: document
            .getAnimations()
            .map((animation) =>
              animation instanceof CSSTransition
                ? animation.transitionProperty
                : animation instanceof CSSAnimation
                  ? animation.animationName
                  : animation.constructor.name,
            ),
        });
      }).observe(document.documentElement, { attributeFilter: ["data-theme"] });
    });

    for (const { source, theme } of APPEARANCE_FLIPS) {
      await setAppearance(app, source);
      await expect.poll(() => readTheme(page)).toBe(theme);
    }

    const changes = await page.evaluate(() => (globalThis as ThemeChangeLog).themeChanges);
    // The first flip changes nothing when the machine is already light, so
    // only the last two changes are certain to happen.
    expect(changes?.slice(-2)).toEqual([
      { theme: "orient-express", running: [] },
      { theme: "whitehaven", running: [] },
    ]);
    expect(changes?.flatMap(({ running }) => running)).toEqual([]);
  });

  it("can be made full screen by the user", async () => {
    const { app } = await launchForTest();

    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.isFullScreenable(),
      ),
    ).toBe(true);
  });

  it("puts New Thread, ⌘N, and Close Window, ⌘W, in the File menu", async () => {
    const { app } = await launchForTest();

    // macOS runs the menu item itself, and only for a focused window, which
    // a test cannot count on: its screen may be locked. So the test checks
    // the menu main installs, and the next test checks what closing does.
    const file = await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()!
        .items.find((item) => item.label === "File")
        ?.submenu?.items.filter((item) => item.type !== "separator")
        .map(({ label, role, accelerator }) => ({ label, role, accelerator })),
    );
    expect(file).toEqual([
      { label: "New Thread", role: null, accelerator: "CmdOrCtrl+N" },
      { label: "Close Window", role: "close", accelerator: "CmdOrCtrl+W" },
    ]);
  });

  it("hides when it is closed, the app keeps running, and activating the app shows it again", async () => {
    const { app } = await launchForTest();

    // The red traffic light and ⌘W both close the window this way.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.close();
    });
    await expect.poll(() => isWindowVisible(app)).toBe(false);
    expect(await countWindows(app)).toBe(1);
    expect(app.process().exitCode).toBeNull();

    // A click on the dock icon emits `activate` on the app.
    await app.evaluate(({ app }) => {
      app.emit("activate", {}, false);
    });
    await expect.poll(() => isWindowVisible(app)).toBe(true);
  });

  it("ignores a hide reported after the window has closed, so quitting shows no error", async () => {
    const { app, userDataDir, close } = await launchForTest();
    const errorFile = join(userDataDir, "late-hide-error.txt");

    // As the app quits, Electron destroys the window. macOS can still report
    // afterwards that the window was hidden, up to about 100 ms later on a
    // busy machine, and Electron then emits `hide` on the destroyed window.
    // The test emits `hide` right after `closed` instead, and writes down
    // any error the emit throws. It writes to a file because the app has
    // exited by the time the test can read anything from it.
    await app.evaluate(({ BrowserWindow }, file) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.once("closed", () => {
        process.nextTick(() => {
          try {
            window.emit("hide");
          } catch (error) {
            process.getBuiltinModule("node:fs").writeFileSync(file, String(error));
          }
        });
      });
    }, errorFile);

    await close();
    expect(existsSync(errorFile) ? readFileSync(errorFile, "utf8") : null).toBeNull();
  });

  it("hands a second launch over to the running window, which shows and takes focus, and the second launch exits", async () => {
    const { app, userDataDir } = await launchForTest();

    // Which app macOS puts in front depends on every other app on the
    // machine, the suite's other apps included, so the test cannot rely on
    // the window ending up focused. It counts the calls main makes to the
    // window's `focus` instead, through a wrapper around it.
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      const focus = window.focus.bind(window);
      const counter = globalThis as { focusCalls?: number };
      counter.focusCalls = 0;
      window.focus = () => {
        counter.focusCalls = (counter.focusCalls ?? 0) + 1;
        focus();
      };
      window.hide();
    });

    expect(await runSecondInstance("test", userDataDir)).toBe(0);

    await expect.poll(() => isWindowVisible(app)).toBe(true);
    expect(await app.evaluate(() => (globalThis as { focusCalls?: number }).focusCalls)).toBe(1);
    expect(await countWindows(app)).toBe(1);
  });
});

describe("the window's state", () => {
  /** Reads the window's position and size, in screen points. */
  const readBounds = (app: ElectronApplication) =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());

  it("reopens at the size and position it had when the app quit", async () => {
    const userDataDir = createUserDataDirForTest();

    const first = await launchForTest(userDataDir);
    // Near the right edge of the main display, because with Stage Manager on,
    // macOS moves a new window out of a strip along the left edge.
    const area = await first.app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
    const width = Math.min(1000, area.width - 40);
    const height = Math.min(700, area.height - 80);
    const bounds = { x: area.x + area.width - width - 20, y: area.y + 40, width, height };
    await first.app.evaluate(({ BrowserWindow }, saved) => {
      BrowserWindow.getAllWindows()[0]!.setBounds(saved);
    }, bounds);
    expect(await readBounds(first.app)).toEqual(bounds);
    await first.close();

    const second = await launchForTest(userDataDir);
    expect(await readBounds(second.app)).toEqual(bounds);
  });

  it("moves a window saved where no display is back onto a display", async () => {
    const userDataDir = createUserDataDirForTest();
    // macOS keeps part of a window on a display, so the app cannot be made to
    // save a position on none. The test writes the settings file itself,
    // with a position far off every display, as when the display the window
    // was on has been unplugged since.
    const offScreen = { x: -30_000, y: -30_000, width: 1000, height: 700 };
    writeFileSync(
      join(userDataDir, "settings.json"),
      JSON.stringify({ window: { bounds: offScreen, fullScreen: false } }),
    );

    const { app } = await launchForTest(userDataDir);
    const { bounds, workAreas } = await app.evaluate(({ BrowserWindow, screen }) => ({
      bounds: BrowserWindow.getAllWindows()[0]!.getBounds(),
      workAreas: screen.getAllDisplays().map((display) => display.workArea),
    }));
    expect({ width: bounds.width, height: bounds.height }).toEqual({ width: 1000, height: 700 });
    const insideWorkArea = workAreas.some(
      (area) =>
        bounds.x >= area.x &&
        bounds.y >= area.y &&
        bounds.x + bounds.width <= area.x + area.width &&
        bounds.y + bounds.height <= area.y + area.height,
    );
    expect(insideWorkArea, JSON.stringify({ bounds, workAreas })).toBe(true);
  });
});
