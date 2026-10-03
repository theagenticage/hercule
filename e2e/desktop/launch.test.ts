/**
 * Tests how the window appears at launch (spec 17, §Native behaviour). Main
 * keeps the window hidden until the page reports its first screen, and the
 * page reports only once the frame that draws that screen, fonts included,
 * has reached the window. So the first frame the user sees already holds the
 * whole first screen, never the bare background or a part of the screen.
 *
 * The tests check that:
 *
 * - main shows the window on the page's report, after the frame was presented,
 *   and not on its own time limit;
 * - the "connecting" screen reports when the saved controller never answers;
 * - the page already holds the whole first screen, the focused field's focus
 *   ring included, when main calls `show()`: a capture of the page taken
 *   then is identical to one taken a second later.
 *
 * What the window itself shows first is out of these tests' reach: a capture
 * of the page reads the page's pixels, not the window's. The first-frame
 * check, `apps/desktop/scripts/first-frame.ts`, records the window instead.
 *
 * Run `pnpm build:desktop` first.
 */
import type { ElectronApplication, Page } from "playwright";
import { expect, it } from "vitest";
import {
  FIRST_SCREEN_TIMEOUT_MS,
  SHOWN_WITHOUT_FIRST_SCREEN_ERROR,
} from "../../apps/desktop/src/main/window-visibility";
import { writeSettings } from "../../apps/desktop/scripts/packaged-app";
import {
  createUserDataDirForTest,
  findUnusedLoopbackUrl,
  launchForTest,
  launchWithSavedController,
  startServerForTest,
  type LaunchedApp,
} from "./harness";

/** The origin the app's page is served from. */
const APP_ORIGIN = "app://hercule";

/**
 * Reads when main showed the window, from the `window-shown` mark main sets
 * as it calls `show()`, as milliseconds since the epoch. Returns null when
 * the mark is missing.
 */
function readWindowShownTime(app: ElectronApplication): Promise<number | null> {
  return app.evaluate(() => {
    const [mark] = performance.getEntriesByName("window-shown");
    return mark === undefined ? null : performance.timeOrigin + mark.startTime;
  });
}

/**
 * Reads when the page recorded the performance entry `name`, as milliseconds
 * since the epoch. Returns null when the page has no such entry.
 */
function readPageEntryTime(page: Page, name: string): Promise<number | null> {
  return page.evaluate((entryName) => {
    const [entry] = performance.getEntriesByName(entryName);
    return entry === undefined ? null : performance.timeOrigin + entry.startTime;
  }, name);
}

/** The parts of Electron's `NativeImage` that the capture comparison reads. */
interface Capture {
  getSize(): { width: number; height: number };
  toBitmap(): Buffer;
}

/**
 * What main records about the window's first show, for the capture test.
 * It is kept on main's `globalThis`, because a function handed to
 * `app.evaluate` cannot close over anything in this file. Times are on main's
 * performance timeline.
 */
interface FirstShowRecord {
  /** When the style that hides the caret had reached the page, or null before then. */
  caretHiddenAt: number | null;
  /** When main first called the window's `show()`, or null before then. */
  shownAt: number | null;
  /** The capture of the page main asked for as it first called `show()`, or null before then. */
  shownCapture: Promise<Capture> | null;
}

type FirstShowGlobal = typeof globalThis & { firstShow?: FirstShowRecord };

/**
 * Turns Playwright's focus emulation on or off for `page`. While it is on,
 * the page draws as focused, whichever window has the system's focus.
 *
 * Each DevTools session keeps its own switch, and ignores a request that
 * matches it. A new session's switch is off, so turning emulation off takes
 * turning it on first.
 */
async function setFocusEmulation(page: Page, enabled: boolean): Promise<void> {
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  if (!enabled) await session.send("Emulation.setFocusEmulationEnabled", { enabled: false });
}

/**
 * Prepares the app, before its window shows, for `compareShowCaptureWithSettled`:
 *
 * - Main asks for a capture of the window's page as it calls the window's
 *   `show()` for the first time, just before the real call. Chromium reads
 *   the capture from the page's surface, not from the window, shortly
 *   after the call. So the capture holds what the page held about when
 *   `show()` was called, not the frame the window appeared with. The
 *   window's `show` event would come later still.
 * - Playwright's focus emulation is turned off. Playwright makes every page it
 *   drives draw as focused, so a page in a hidden window would draw its focus
 *   ring at once, and a ring that in real use appears only after the window
 *   shows would go unnoticed.
 * - The page's text caret is hidden, because it blinks, and two captures of
 *   the same screen would differ by it.
 * - The window lets the pointer through, so a pointer that moves over it
 *   cannot change the screen with a hover style.
 */
async function prepareFirstShowCapture(app: ElectronApplication, page: Page): Promise<void> {
  await setFocusEmulation(page, false);
  await app.evaluate(({ BrowserWindow }, appOrigin) => {
    const record: FirstShowRecord = { caretHiddenAt: null, shownAt: null, shownCapture: null };
    (globalThis as FirstShowGlobal).firstShow = record;
    const [window] = BrowserWindow.getAllWindows();
    if (window === undefined) throw new Error("the app has no window");
    const contents = window.webContents;

    const hideCaret = () => {
      void contents.insertCSS("* { caret-color: transparent !important; }").then(() => {
        record.caretHiddenAt ??= performance.now();
      });
    };
    // A style inserted into a page is lost when the window navigates, and the
    // window may still be on its first, empty page.
    if (contents.getURL().startsWith(appOrigin)) hideCaret();
    else contents.once("did-navigate", hideCaret);
    window.setIgnoreMouseEvents(true);

    const show = window.show.bind(window);
    window.show = () => {
      if (record.shownAt === null) {
        record.shownAt = performance.now();
        record.shownCapture = contents.capturePage(undefined, { stayHidden: true });
      }
      show();
    };
  }, APP_ORIGIN);
}

/**
 * Starts the app prepared by `prepareFirstShowCapture`, and returns it once
 * main has shown the window with the preparation in place: main asked for
 * the capture, and the caret was hidden before then.
 *
 * Playwright hands the test the window only once its page is running, so on
 * a busy machine main can show the window before the preparation is done. A
 * launch like that can check nothing, so it is quit and the app is started
 * again. Fails after 3 such launches.
 *
 * The app starts with a saved controller that nothing answers at, so it opens
 * on the connect screen, whose address field has focus. With no saved
 * controller it would open on the first run's welcome, which has no focused
 * field and shows a spinner while it looks for Hercule, so its first screen
 * changes after the window shows.
 */
async function launchWithFirstShowCapture(): Promise<LaunchedApp> {
  for (let launch = 1; launch <= 3; launch += 1) {
    const userDataDir = createUserDataDirForTest();
    writeSettings(userDataDir, { controllerUrl: await findUnusedLoopbackUrl() });
    const launched = await launchForTest(userDataDir, prepareFirstShowCapture);
    const preparedBeforeShow = await launched.app.evaluate(() => {
      const { caretHiddenAt, shownAt } = (globalThis as FirstShowGlobal).firstShow!;
      return shownAt !== null && caretHiddenAt !== null && caretHiddenAt < shownAt;
    });
    if (preparedBeforeShow) return launched;
    await launched.close();
  }
  throw new Error(
    "main showed the window before the test could prepare to capture its page, in 3 launches",
  );
}

/**
 * Captures the window's page 1 second after main first showed it, and
 * compares that capture, pixel by pixel, with the one main asked for as it
 * showed the window. The app must come from `launchWithFirstShowCapture`.
 *
 * Returns how many device pixels differ, and the smallest rectangle, in
 * device pixels, that holds them (null when none differ). Fails when the two
 * captures differ in size.
 */
function compareShowCaptureWithSettled(app: ElectronApplication): Promise<{
  differingPixels: number;
  box: { left: number; top: number; right: number; bottom: number } | null;
}> {
  return app.evaluate(async ({ BrowserWindow }) => {
    const { shownAt, shownCapture } = (globalThis as FirstShowGlobal).firstShow!;
    if (shownAt === null || shownCapture === null) {
      throw new Error("the app did not come from launchWithFirstShowCapture");
    }
    await new Promise((resolve) => setTimeout(resolve, shownAt + 1000 - performance.now()));
    const [window] = BrowserWindow.getAllWindows();
    const first: Capture = await shownCapture;
    const settled: Capture = await window!.webContents.capturePage();

    const { width, height } = first.getSize();
    const settledSize = settled.getSize();
    if (settledSize.width !== width || settledSize.height !== height) {
      throw new Error(
        `the capture taken at show() is ${String(width)}x${String(height)} device pixels, and the settled one ${String(settledSize.width)}x${String(settledSize.height)}`,
      );
    }
    const firstPixels = first.toBitmap();
    const settledPixels = settled.toBitmap();
    let differingPixels = 0;
    let [left, top, right, bottom] = [width, height, -1, -1];
    for (let offset = 0; offset < firstPixels.length; offset += 4) {
      if (firstPixels.readUInt32LE(offset) === settledPixels.readUInt32LE(offset)) continue;
      differingPixels += 1;
      const x = (offset / 4) % width;
      const y = Math.floor(offset / 4 / width);
      [left, top, right, bottom] = [Math.min(left, x), Math.min(top, y), Math.max(right, x), y];
    }
    return {
      differingPixels,
      box: differingPixels === 0 ? null : { left, top, right, bottom },
    };
  });
}

it("shows the window once its first screen has been presented, on the page's report", async () => {
  const { app, page, readMainOutput } = await launchForTest();

  // The page sets `first-screen` at the moment the frame that drew its first
  // screen was presented, and reports to main after that. Main and the page
  // measure time in separate processes, but both count from the machine's
  // clock, so their times compare to well under a millisecond.
  const windowShownAt = await readWindowShownTime(app);
  const firstScreenAt = await readPageEntryTime(page, "first-screen");
  const firstPaintAt = await readPageEntryTime(page, "first-paint");
  expect(windowShownAt).not.toBeNull();
  expect(firstScreenAt).not.toBeNull();
  expect(firstPaintAt).not.toBeNull();

  expect(
    windowShownAt! - firstScreenAt!,
    "the window showed before its first screen had been presented",
  ).toBeGreaterThan(0);
  // Main logs the error just before it shows the window, and the launch
  // waits 200 ms after the show, so an error would have arrived by now.
  expect(readMainOutput()).not.toContain(SHOWN_WITHOUT_FIRST_SCREEN_ERROR);
  // Main's time limit fires at the earliest this long after the first paint.
  // A window shown sooner was shown by the page's report.
  expect(
    windowShownAt! - firstPaintAt!,
    "the window was shown by main's time limit, not by the page's report",
  ).toBeLessThan(FIRST_SCREEN_TIMEOUT_MS);
});

it("shows the window on the connecting screen's report when the saved controller never answers", async () => {
  // The server accepts every request and never answers it, so the entry guard
  // waits, and the first navigation cannot land for 5 seconds. Before that,
  // only the connecting screen can report, 1 second after the navigation
  // started.
  const server = await startServerForTest(() => {});
  const { app, page, readMainOutput } = await launchWithSavedController(server.url);

  expect(await page.getByText(`Connecting to ${server.url}…`).isVisible()).toBe(true);
  expect(readMainOutput()).not.toContain(SHOWN_WITHOUT_FIRST_SCREEN_ERROR);
  const windowShownAt = await readWindowShownTime(app);
  const firstPaintAt = await readPageEntryTime(page, "first-paint");
  expect(windowShownAt).not.toBeNull();
  expect(firstPaintAt).not.toBeNull();
  expect(
    windowShownAt! - firstPaintAt!,
    "the window was shown by main's time limit, not by the connecting screen's report",
  ).toBeLessThan(FIRST_SCREEN_TIMEOUT_MS);
});

it("the page already holds the whole first screen, the focus ring included, when main calls show()", async () => {
  const { app, page } = await launchWithFirstShowCapture();

  // The settled screen is the one a focused window draws. Another window can
  // take the focus from this one by now, such as a test running beside this
  // one, and the page would then drop its focus ring. With focus emulation
  // back on, the page draws as focused whichever window has the focus.
  await setFocusEmulation(page, true);
  // The connect screen focuses its address field, so the first screen holds
  // a focus ring.
  expect(
    await page.evaluate(() => document.activeElement?.matches(":focus-visible")),
    "the connect screen's address field has no focus ring, so the test checks nothing",
  ).toBe(true);
  const comparison = await compareShowCaptureWithSettled(app);
  expect(
    comparison.differingPixels,
    `the page's capture at show() differs from the settled screen in ${JSON.stringify(comparison.box)} (device pixels): main showed the window before its page had drawn all of the first screen`,
  ).toBe(0);
});
