/**
 * Captures the desktop screens from the specimen pages, with no controller
 * and no Electron: `pnpm --filter @hercule/desktop capture:ui`. The screens,
 * and their variants (six themes, 1x and 2x, glass 40 % and 0 %), are listed
 * in scripts/ui-screens.ts. The pages load in parallel in one Playwright
 * Chromium (see scripts/ui-capture.ts).
 *
 * It deletes `apps/desktop/out/ui/` (git-ignored) and writes:
 * - `<theme>/<screen>-<scale>x-glass<percent>.png`, one screenshot of the
 *   1440 × 900 window per variant;
 * - `manifest.json`, a list that holds each capture's screen, theme, scale,
 *   glassPercent, width and height in device pixels, and file (relative to
 *   `out/ui/`);
 * - `contact-<theme>.png` for each theme, with the `.html` it is drawn from
 *   beside it: the 1x captures at half size, a row per screen, glass 40 % on
 *   the left and glass 0 % on the right. It is for a look by eye.
 *
 * It prints how many captures it wrote and how long it took, and exits with
 * 0. When anything fails, it prints `FAILED:` and a message that names the
 * screen and variant, and exits with 1. It never writes a capture of a page
 * that did not render. It closes the browser and the server in every case,
 * also on Ctrl-C.
 *
 * Setup: Chromium comes from Playwright, installed once with
 * `pnpm exec playwright install chromium`. On a Linux machine where you have
 * sudo, `pnpm exec playwright install --with-deps chromium` also installs the
 * system libraries. On a Linux machine without sudo, Chromium fails with a
 * missing shared library, such as `libatk-1.0.so.0`. Then download the
 * libraries into a folder of your own, once:
 *
 *     mkdir -p ~/.cache/chromium-libs && cd ~/.cache/chromium-libs &&
 *     apt-get download libatk1.0-0t64 libatk-bridge2.0-0t64 libxcomposite1 \
 *       libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64 libatspi2.0-0t64 \
 *       libwayland-server0 libxrender1 libxi6 libxkbcommon0 &&
 *     for f in *.deb; do dpkg-deb -x "$f" root; done && rm *.deb
 *
 * and run the command with that folder on the library path:
 *
 *     LD_LIBRARY_PATH=$HOME/.cache/chromium-libs/root/usr/lib/x86_64-linux-gnu \
 *       pnpm --filter @hercule/desktop capture:ui
 *
 * The page's time zone and language come from the browser context, not from
 * the process, so the process needs no `TZ=UTC` as the Electron captures do.
 *
 * It needs no build: the specimens are served from source.
 *
 * With `--calibration` it does something else, and nothing of the above:
 * `pnpm --filter @hercule/desktop capture:ui --calibration` writes the UI
 * council's calibration images (docs/design/ui-council/BRIEF.md, section 9).
 * Those are the deliberately broken looks `max-contrast`, `cramped` and
 * `noisy` (see src/renderer/specimens/broken-variants.ts), each in Whitehaven
 * and Orient Express, on the thread, sidebar and intake screens, at 1x and
 * glass 40 %. It deletes `docs/design/ui-council/calibration/` and writes
 * there `broken-<variant>-<theme>-<screen>-1x.png` (18 files) and
 * `manifest.json`: the commit the images were made from, this command, and
 * each file with its sha256, sorted by file name.
 *
 * The calibration images are frozen: they exist to detect drift of the
 * reviewer, so they must not move with the UI. Running `--calibration` is an
 * explicit calibration revision, a pull request of its own that says why. It
 * is never part of a normal run, and nothing runs it automatically.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { exitCodeForSignal } from "./processes.ts";
import { runAndSetExitCode, startSpecimenServer, type SpecimenServer } from "./sheet-server.ts";
import { captureVariants, launchCaptureBrowser, screenshotVariant } from "./ui-capture.ts";
import {
  GLASS_PERCENTS,
  listUiVariants,
  UI_SCREENS,
  WINDOW_SIZE,
  type UiVariant,
} from "./ui-screens.ts";
import { BROKEN_VARIANTS, type BrokenVariant } from "../src/renderer/specimens/broken-variants.ts";
import { ALL_THEMES, THEMES } from "../src/renderer/specimens/sheet-themes.ts";

const calibrationDir = fileURLToPath(
  new URL("../../../docs/design/ui-council/calibration/", import.meta.url),
);

/** The command that writes the calibration images, as manifest.json records it. */
const CALIBRATION_COMMAND = "pnpm --filter @hercule/desktop capture:ui --calibration";

/** The screens of the calibration images. */
const CALIBRATION_SCREENS = ["thread", "sidebar", "intake"];

const outputDir = fileURLToPath(new URL("../out/ui/", import.meta.url));

/** The scale of the captures a contact sheet shows. */
const CONTACT_SHEET_SCALE = 1;

/** How wide a captured screen is on a contact sheet, in CSS pixels: half of the window. */
const CONTACT_TILE_WIDTH = WINDOW_SIZE.width / 2;

/** One line of manifest.json: a capture on disk. */
interface CaptureRecord {
  readonly screen: string;
  readonly theme: string;
  readonly scale: number;
  readonly glassPercent: number;
  /** The width of the PNG in device pixels. */
  readonly width: number;
  /** The height of the PNG in device pixels. */
  readonly height: number;
  /** The PNG's path relative to out/ui/. */
  readonly file: string;
}

/** Returns the path of the variant's PNG relative to out/ui/. */
function buildCaptureFile({ screen, theme, scale, glassPercent }: UiVariant): string {
  return `${theme}/${screen.name}-${String(scale)}x-glass${String(glassPercent)}.png`;
}

/**
 * Screenshots the ready page of `variant`, writes the PNG under out/ui/, and
 * returns its record for the manifest. Fails, before writing, when the
 * screenshot has the wrong size or is blank (see `screenshotVariant`).
 */
async function writeCapture(page: Page, variant: UiVariant): Promise<CaptureRecord> {
  const { png, width, height } = await screenshotVariant(page, variant);
  const file = buildCaptureFile(variant);
  await writeFile(join(outputDir, file), png);
  return {
    screen: variant.screen.name,
    theme: variant.theme,
    scale: variant.scale,
    glassPercent: variant.glassPercent,
    width,
    height,
    file,
  };
}

/**
 * Returns the HTML of `theme`'s contact sheet: its 1x captures at half size,
 * one row per screen, one column per glass level, each tile labelled with its
 * screen and glass. The images are referenced by their path relative to
 * out/ui/, where the file is written.
 */
function buildContactSheetHtml(theme: string): string {
  const tiles = UI_SCREENS.flatMap((screen) =>
    GLASS_PERCENTS.map((glassPercent) => {
      const file = buildCaptureFile({ screen, theme, scale: CONTACT_SHEET_SCALE, glassPercent });
      return `<figure><img src="${file}" width="${String(CONTACT_TILE_WIDTH)}" alt="" /><figcaption>${screen.name} - glass ${String(glassPercent)}</figcaption></figure>`;
    }),
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${theme}</title>
<style>
  body { margin: 0; padding: 16px; background: #1b1b1b; color: #ddd; font: 13px/1.4 sans-serif; }
  h1 { margin: 0 0 12px; font-size: 16px; font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(${String(GLASS_PERCENTS.length)}, ${String(CONTACT_TILE_WIDTH)}px); gap: 12px 16px; }
  figure { margin: 0; }
  img { display: block; }
  figcaption { margin-top: 4px; }
</style>
</head>
<body>
<h1>${theme}</h1>
<div class="grid">
${tiles.join("\n")}
</div>
</body>
</html>
`;
}

/**
 * Writes `contact-<theme>.html` and `contact-<theme>.png` under out/ui/, the
 * PNG a full-page screenshot of the HTML opened from disk. Waits until every
 * image has decoded, so the screenshot never shows a half-loaded tile. Fails
 * when an image does not load.
 */
async function writeContactSheet(browser: Browser, theme: string): Promise<void> {
  const htmlFile = join(outputDir, `contact-${theme}.html`);
  await writeFile(htmlFile, buildContactSheetHtml(theme));
  const context = await browser.newContext({
    viewport: {
      width: GLASS_PERCENTS.length * CONTACT_TILE_WIDTH + (GLASS_PERCENTS.length - 1) * 16 + 32,
      height: 900,
    },
  });
  try {
    const page = await context.newPage();
    await page.goto(`file://${htmlFile}`);
    // A string, because this program has no DOM types.
    await page.evaluate(
      "Promise.all(Array.from(document.images, (image) => image.decode())).then(() => undefined)",
    );
    await page.screenshot({ path: join(outputDir, `contact-${theme}.png`), fullPage: true });
  } finally {
    await context.close();
  }
}

/** One line of the calibration manifest: an image on disk. */
interface CalibrationFile {
  readonly file: string;
  readonly sha256: string;
}

/**
 * Captures the calibration images of one broken look (see the docstring of
 * this file) into the calibration folder, and returns them with their sha256.
 * The look reaches the page through `?broken=` in the screen's path.
 */
async function captureBrokenVariant(
  browser: Browser,
  specimensUrl: string,
  broken: BrokenVariant,
): Promise<CalibrationFile[]> {
  const screens = CALIBRATION_SCREENS.map((name) => {
    const screen = UI_SCREENS.find((each) => each.name === name);
    if (screen === undefined)
      throw new Error(`The calibration screen "${name}" is not in UI_SCREENS.`);
    return { ...screen, path: `${screen.path}?broken=${broken}` };
  });
  const variants: UiVariant[] = THEMES.flatMap((theme) =>
    screens.map((screen) => ({ screen, theme, scale: 1, glassPercent: 40 }) as const),
  );
  return captureVariants(browser, specimensUrl, variants, async (page, variant) => {
    const { png } = await screenshotVariant(page, variant);
    const file = `broken-${broken}-${variant.theme}-${variant.screen.name}-1x.png`;
    await writeFile(join(calibrationDir, file), png);
    return { file, sha256: createHash("sha256").update(png).digest("hex") };
  });
}

/**
 * Writes the calibration images and their manifest.json (see the docstring of
 * this file). Returns 0. Fails like `captureUi`.
 */
async function captureCalibration(): Promise<number> {
  await rm(calibrationDir, { recursive: true, force: true });
  await mkdir(calibrationDir, { recursive: true });
  const generatedFrom = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return withBrowser(async (browser, server) => {
    const files: CalibrationFile[] = [];
    for (const broken of BROKEN_VARIANTS) {
      files.push(...(await captureBrokenVariant(browser, server.specimensUrl, broken)));
    }
    files.sort((a, b) => a.file.localeCompare(b.file));
    const manifest = { generatedFrom, command: CALIBRATION_COMMAND, files };
    await writeFile(
      join(calibrationDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    process.stdout.write(`Wrote ${String(files.length)} calibration images to ${calibrationDir}\n`);
    return 0;
  });
}

/**
 * Starts the specimen server and the capture browser, calls `work` with them,
 * and returns what it returns. Closes both in every case, also on Ctrl-C.
 */
async function withBrowser(
  work: (browser: Browser, server: SpecimenServer) => Promise<number>,
): Promise<number> {
  let server: SpecimenServer | undefined;
  let browser: Browser | undefined;
  const closeAll = async (): Promise<void> => {
    await browser?.close();
    await server?.close();
  };
  const exitOnSignal = (signal: NodeJS.Signals): void => {
    // Exits even when closing fails: the user asked to stop.
    void closeAll()
      .catch(() => undefined)
      .finally(() => process.exit(exitCodeForSignal(signal)));
  };
  process.once("SIGINT", exitOnSignal);
  process.once("SIGTERM", exitOnSignal);
  try {
    server = await startSpecimenServer();
    browser = await launchCaptureBrowser();
    return await work(browser, server);
  } finally {
    process.off("SIGINT", exitOnSignal);
    process.off("SIGTERM", exitOnSignal);
    await closeAll();
  }
}

/** Runs the normal capture. Returns 0, or fails with a message that names the variant that failed. */
async function captureUi(): Promise<number> {
  const startedAt = performance.now();
  await rm(outputDir, { recursive: true, force: true });
  await Promise.all(ALL_THEMES.map((theme) => mkdir(join(outputDir, theme), { recursive: true })));
  return withBrowser(async (browser, server) => {
    const variants = listUiVariants();
    const records = await captureVariants(browser, server.specimensUrl, variants, writeCapture);
    await writeFile(join(outputDir, "manifest.json"), `${JSON.stringify(records, null, 2)}\n`);
    await Promise.all(ALL_THEMES.map((theme) => writeContactSheet(browser, theme)));
    const seconds = (performance.now() - startedAt) / 1000;
    process.stdout.write(
      `Wrote ${String(records.length)} captures and ${String(ALL_THEMES.length)} contact sheets to ${outputDir} in ${seconds.toFixed(1)} s.\n`,
    );
    return 0;
  });
}

/** Runs the calibration capture with `--calibration`, the normal capture with no argument. Fails on any other argument. */
async function run(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length === 0) return captureUi();
  if (args.length === 1 && args[0] === "--calibration") return captureCalibration();
  throw new Error(`Unknown arguments: ${args.join(" ")}. The only argument is --calibration.`);
}

await runAndSetExitCode(run);
