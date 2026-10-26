/**
 * The core `pnpm capture:ui` is built on, and what the UI metrics and the
 * UI goldens reuse: it loads each variant of the desktop screens (see
 * scripts/ui-screens.ts) in a plain Playwright Chromium, waits until the
 * page is ready, and hands the page to a callback. The callback decides what
 * to do with the page: capture:ui takes a screenshot, a metric inspects the
 * page's elements.
 *
 * The browser is Playwright's Chromium, not Electron, so it runs on Linux and
 * on macOS and needs no controller. It draws the pages the way the Electron
 * captures do (see the switches in scripts/sheet-server.ts), but it is not
 * the same renderer, so its pixels are compared only with its own.
 *
 * Runs on plain Node by stripping types, so it uses only syntax that
 * stripping can erase: no enums, namespaces or parameter properties.
 */
import { availableParallelism } from "node:os";
import { PNG } from "pngjs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  buildVariantUrl,
  describeVariant,
  isDarkTheme,
  WINDOW_SIZE,
  type UiVariant,
} from "./ui-screens.ts";

/** How long a page may take to load, draw and set `data-ready`. */
const READY_TIMEOUT_MS = 30_000;

/** How many pages load at once when the caller does not say: one per CPU, at most 8. */
const DEFAULT_CONCURRENCY = Math.min(availableParallelism(), 8);

/**
 * The Chromium switches that fix how the pages are drawn, as the Electron
 * captures fix them (see scripts/sheet-server.ts for the reasons). Playwright
 * adds some of them itself; they are listed here so the captures do not depend
 * on a Playwright release. The GPU switches of the Electron captures are
 * left out: `--disable-gpu` would turn off the backdrop filter, which the
 * glass needs.
 */
const BROWSER_ARGS = [
  "--force-color-profile=srgb",
  "--disable-gpu-rasterization",
  "--disable-partial-raster",
  "--hide-scrollbars",
];

/**
 * Starts Playwright's Chromium with the switches the captures need. Returns
 * the browser. Fails when Chromium cannot start, with a message that says
 * how to install it or its system libraries.
 */
export async function launchCaptureBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ args: BROWSER_ARGS });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Chromium did not start. If it is not installed, run \`pnpm exec playwright install chromium\` ` +
        "(with `--with-deps` on a machine where you have sudo, which also installs the system libraries). " +
        "On a Linux machine without sudo, where Chromium fails with a missing shared library, " +
        "download the libraries into a folder of your own and set LD_LIBRARY_PATH: see the " +
        `docstring of scripts/capture-ui.ts.\nPlaywright said: ${reason}`,
      { cause: error },
    );
  }
}

/** What `captureVariants` accepts besides the variants. */
export interface CaptureVariantsOptions {
  /** How many pages load at once. The default is the number of CPUs, at most 8. */
  readonly concurrency?: number;
}

/**
 * Loads every variant's page and calls `onReadyPage` with it once the page is
 * ready, then returns what the callbacks returned, in the order of
 * `variants`.
 *
 * Each variant gets a browser context of its own, closed afterwards, because
 * a fixture may keep state in localStorage or IndexedDB, which the pages of
 * one context share. The context fixes what the page could read from the
 * machine: the 1440 × 900 window, the scale, UTC and en-US (the fixtures'
 * times read the same everywhere), the colour scheme a Mac would report for
 * the theme, and no Reduce motion.
 *
 * A page is ready when `<html>` has `data-ready` and the screen's content
 * selector matches a visible element. Any uncaught exception or console error
 * while the page loads fails the variant. Up to `options.concurrency`
 * variants run at once.
 *
 * Fails with the first error, naming the variant (screen, theme, scale and
 * glass) and the cause. The variants that were already running finish and
 * close their contexts; no new variant starts.
 */
export async function captureVariants<Result>(
  browser: Browser,
  specimensUrl: string,
  variants: ReadonlyArray<UiVariant>,
  onReadyPage: (page: Page, variant: UiVariant) => Promise<Result>,
  options: CaptureVariantsOptions = {},
): Promise<Result[]> {
  const results: Result[] = new Array<Result>(variants.length);
  const workerCount = Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, variants.length);
  let nextIndex = 0;
  let failure: { readonly error: unknown } | undefined;

  const work = async (): Promise<void> => {
    while (failure === undefined && nextIndex < variants.length) {
      const index = nextIndex++;
      const variant = variants[index]!;
      try {
        results[index] = await loadVariant(browser, specimensUrl, variant, onReadyPage);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: workerCount }, work));
  if (failure !== undefined) throw failure.error;
  return results;
}

/**
 * Opens the variant's page in a fresh browser context, waits until it is
 * ready, and returns what `onReadyPage` returns for it. Closes the context
 * either way. Fails with an error that names the variant, also when the
 * browser dies while the context is created or closed, and also when the page
 * raises an uncaught exception or a console error while `onReadyPage` works.
 * When both the work and the close fail, the error of the work is the one
 * reported.
 */
async function loadVariant<Result>(
  browser: Browser,
  specimensUrl: string,
  variant: UiVariant,
  onReadyPage: (page: Page, variant: UiVariant) => Promise<Result>,
): Promise<Result> {
  const problems: string[] = [];
  const buildFailure = (error: unknown): Error => {
    const cause = error instanceof Error ? error.message : String(error);
    // A page that fails to load often logs why; the timeout alone would hide it.
    const logged = problems.filter((problem) => !cause.includes(problem));
    return new Error(
      `Capturing ${describeVariant(variant)} failed: ${cause}` +
        (logged.length > 0 ? `\n${logged.join("\n")}` : ""),
      { cause: error },
    );
  };
  let context: BrowserContext | undefined;
  let outcome: { readonly result: Result } | { readonly failure: Error };
  try {
    context = await browser.newContext({
      viewport: WINDOW_SIZE,
      deviceScaleFactor: variant.scale,
      timezoneId: "UTC",
      locale: "en-US",
      // Settings > Appearance presses the card of the theme the system's
      // appearance puts in use, so the context reports the appearance that
      // matches the theme (see scripts/sheet-window.ts).
      colorScheme: isDarkTheme(variant.theme) ? "dark" : "light",
      reducedMotion: "no-preference",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(READY_TIMEOUT_MS);
    page.on("pageerror", (error) => problems.push(`Uncaught exception: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`Console error: ${message.text()}`);
    });
    await page.goto(buildVariantUrl(specimensUrl, variant), { waitUntil: "load" });
    await page.waitForSelector("html[data-ready]", { state: "attached" });
    await page.waitForSelector(variant.screen.contentSelector, { state: "visible" });
    if (problems.length > 0) throw new Error(problems.join("\n"));
    const result = await onReadyPage(page, variant);
    // The callback may take a screenshot or measure for a while, and the page
    // can fail meanwhile.
    if (problems.length > 0) throw new Error(problems.join("\n"));
    outcome = { result };
  } catch (error) {
    outcome = { failure: buildFailure(error) };
  }
  try {
    await context?.close();
  } catch (error) {
    // Reports a close failure only when the work itself succeeded.
    if ("result" in outcome) outcome = { failure: buildFailure(error) };
  }
  if ("failure" in outcome) throw outcome.failure;
  return outcome.result;
}

/** A rectangle in CSS pixels, measured from the top left of the window. */
interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** What `screenshotVariant` returns: the PNG file and its size in device pixels. */
export interface Screenshot {
  readonly png: Buffer;
  readonly width: number;
  readonly height: number;
}

/**
 * Takes the screenshot of the ready page of `variant` and returns it with its
 * size. Fails when the PNG is not the window's size times the scale, which
 * would mean the page was not drawn at the size the variant names, and when
 * the screen's content has drawn nothing: a page can pass the
 * visibility check with `opacity: 0` and still produce a one-colour image.
 */
export async function screenshotVariant(page: Page, variant: UiVariant): Promise<Screenshot> {
  const boxes = await measureVisibleContentBoxes(page, variant);
  // "disabled" fast-forwards every finite animation and transition to its end
  // and cancels every infinite one, such as a working face, to its first frame
  // (Playwright plays them again afterwards). So a face that taps its paws is
  // captured in the same pose on every run.
  const png = await page.screenshot({ animations: "disabled", caret: "hide" });
  const image = PNG.sync.read(png);
  const expectedWidth = WINDOW_SIZE.width * variant.scale;
  const expectedHeight = WINDOW_SIZE.height * variant.scale;
  if (image.width !== expectedWidth || image.height !== expectedHeight) {
    throw new Error(
      `The screenshot is ${String(image.width)}x${String(image.height)} device pixels, not ${String(expectedWidth)}x${String(expectedHeight)}.`,
    );
  }
  if (!hasTwoColoursIn(image, boxes, variant.scale)) {
    throw new Error(
      `The capture is blank: the content ${variant.screen.contentSelector} drew a single colour.`,
    );
  }
  return { png, width: image.width, height: image.height };
}

/** The part of an element `measureVisibleContentBoxes` reads, typed by what it uses, because this program has no DOM types. */
interface MeasuredElement {
  readonly parentElement: MeasuredElement | null;
  readonly ownerDocument: {
    readonly defaultView: {
      readonly innerWidth: number;
      readonly innerHeight: number;
      getComputedStyle(element: MeasuredElement): {
        readonly overflowX: string;
        readonly overflowY: string;
      };
    } | null;
  };
  getBoundingClientRect(): Box;
}

/**
 * Returns the visible part of every element the screen's content selector
 * matches, in CSS pixels: each element's box cut to the window and to every
 * ancestor that clips its content (any overflow but `visible`). Elements with
 * no visible part are left out. Each box is kept apart, not joined into one
 * enclosing box, so the pixels between them, such as a header above a
 * scrolled transcript, never count as content. Fails when nothing matches,
 * or when nothing that matches is visible.
 */
async function measureVisibleContentBoxes(page: Page, variant: UiVariant): Promise<Box[]> {
  // Playwright runs this function inside the page.
  const boxes = await page
    .locator(variant.screen.contentSelector)
    .evaluateAll((elements: ReadonlyArray<MeasuredElement>): Box[] =>
      elements.flatMap((element) => {
        const view = element.ownerDocument.defaultView!;
        let { left, top, right, bottom } = element.getBoundingClientRect();
        left = Math.max(left, 0);
        top = Math.max(top, 0);
        right = Math.min(right, view.innerWidth);
        bottom = Math.min(bottom, view.innerHeight);
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const style = view.getComputedStyle(ancestor);
          if (style.overflowX === "visible" && style.overflowY === "visible") continue;
          const clip = ancestor.getBoundingClientRect();
          left = Math.max(left, clip.left);
          top = Math.max(top, clip.top);
          right = Math.min(right, clip.right);
          bottom = Math.min(bottom, clip.bottom);
        }
        return right > left && bottom > top ? [{ left, top, right, bottom }] : [];
      }),
    );
  if (boxes.length === 0) {
    throw new Error(
      `The content selector ${variant.screen.contentSelector} matches nothing visible in the window.`,
    );
  }
  return boxes;
}

/**
 * Returns whether the parts of `image` under `boxes` hold at least two
 * different colours between them. The boxes are in CSS pixels; each is
 * multiplied by `scale` and clamped to the image.
 */
function hasTwoColoursIn(image: PNG, boxes: ReadonlyArray<Box>, scale: number): boolean {
  let first: number | undefined;
  for (const box of boxes) {
    const left = Math.max(0, Math.floor(box.left * scale));
    const top = Math.max(0, Math.floor(box.top * scale));
    const right = Math.min(image.width, Math.ceil(box.right * scale));
    const bottom = Math.min(image.height, Math.ceil(box.bottom * scale));
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const colour = image.data.readUInt32BE((y * image.width + x) * 4);
        first ??= colour;
        if (colour !== first) return true;
      }
    }
  }
  return false;
}
