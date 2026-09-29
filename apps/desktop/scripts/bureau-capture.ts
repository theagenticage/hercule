/**
 * Electron's main process for `pnpm compare:bureau`. scripts/compare-bureau.ts
 * starts it, with the address of the specimen sheets as `--sheets-url` and
 * the switches that fix the capture's scale, its colour profile and how its
 * pixels are drawn.
 *
 * For each theme, Whitehaven and Orient Express, it:
 * - opens the reference sheet (the Bureau book's crew.js) and the app's
 *   specimen sheet, each in its own hidden 1440 × 900 window, and waits
 *   until each page sets `data-ready`;
 * - checks that both sheets lay out the same cells in the same places, so
 *   that every pixel reported later is a drawing difference, not a placement
 *   one;
 * - captures both windows, compares them pixel for pixel, and writes
 *   reference.png, app.png and diff.png to out/bureau-compare/<theme>/.
 *
 * Then it prints the report and exits with 0 when every pixel matches, and 1
 * when one does not or anything fails on the way.
 *
 * Electron loads this file as TypeScript by stripping its types, so it uses
 * only syntax that stripping can erase: no enums, namespaces or parameter
 * properties.
 */
import { app, BrowserWindow, nativeImage, type NativeImage } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDiffBitmap,
  compareBitmaps,
  OUTSIDE_CELLS,
  type Bitmap,
  type CellDifference,
} from "./compare-bitmaps.ts";

/** The window's content size in CSS pixels: the size of a Bureau page. */
const WIDTH = 1440;
const HEIGHT = 900;
/** The device pixel ratio every supported Mac's built-in display shows, forced by a switch. */
const DPR = 2;
const THEMES = ["whitehaven", "orient-express"];
/** How long a sheet may take to draw its cells and load its fonts. */
const READY_TIMEOUT_MS = 30_000;

const repositoryDir = fileURLToPath(new URL("../../../", import.meta.url));
const outputDir = fileURLToPath(new URL("../out/bureau-compare/", import.meta.url));

/** A rectangle as the page's `getBoundingClientRect()` returns it, in CSS pixels. */
interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Where a sheet lays out one cell: the cell's rectangle, and the rectangle of the piece inside it. */
interface CellLayout {
  readonly name: string;
  readonly cell: Rect;
  readonly piece: Rect;
}

/** The outcome of one theme's comparison. */
interface ThemeResult {
  readonly theme: string;
  readonly cells: number;
  readonly faces: number;
  readonly differences: ReadonlyArray<CellDifference>;
  /** The specimen window's renderer process's working set, in kilobytes. */
  readonly rendererMemoryKb: number;
}

// Runs in each sheet: every [data-cell] and its piece, the cell's first
// element (the face's or icon's `svg`, or the mark's `span`).
const READ_LAYOUT = `[...document.querySelectorAll("[data-cell]")].map((cell) => {
  const measure = (element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  };
  return { name: cell.dataset.cell, cell: measure(cell), piece: measure(cell.firstElementChild) };
})`;

/**
 * Opens `url` in a hidden window with a 1440 × 900 content area and waits
 * until the page sets `data-ready` on `<html>`. Returns the window. Fails when
 * the page does not load or does not become ready in time; the window is then
 * closed, and the error lists the page's console errors.
 */
async function openSheet(url: string): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    // Hidden, so that the display's size can never shrink the window.
    show: false,
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    // A hidden window would otherwise throttle animation frames, and the
    // page's readiness waits for two of them.
    webPreferences: { backgroundThrottling: false },
  });
  const errors: string[] = [];
  window.webContents.on("console-message", ({ level, message }) => {
    if (level === "error") errors.push(message);
  });
  try {
    await window.loadURL(url);
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (
      !(await window.webContents.executeJavaScript(
        `document.documentElement.hasAttribute("data-ready")`,
      ))
    ) {
      if (Date.now() > deadline) {
        throw new Error(
          `${url} did not set data-ready within ${String(READY_TIMEOUT_MS / 1000)} s.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return window;
  } catch (error) {
    window.destroy();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      message + (errors.length > 0 ? `\nThe page's console errors:\n${errors.join("\n")}` : ""),
      { cause: error },
    );
  }
}

/** Returns where the sheet in `window` lays out each of its cells, in document order. */
async function readLayout(window: BrowserWindow): Promise<ReadonlyArray<CellLayout>> {
  return (await window.webContents.executeJavaScript(READ_LAYOUT)) as ReadonlyArray<CellLayout>;
}

/**
 * Checks that the two sheets lay out the same cells in the same places: the
 * same names in the same order, each with the same cell and piece
 * rectangles, all inside the window. Fails with "layout differs" and the
 * first differences otherwise.
 */
function assertSameLayout(
  reference: ReadonlyArray<CellLayout>,
  specimen: ReadonlyArray<CellLayout>,
): void {
  const differences: string[] = [];
  if (reference.length !== specimen.length) {
    differences.push(
      `the reference has ${String(reference.length)} cells and the app's sheet ${String(specimen.length)}`,
    );
  }
  const describeRect = ({ x, y, width, height }: Rect) =>
    `${String(width)}x${String(height)} at ${String(x)},${String(y)}`;
  reference.forEach((expected, index) => {
    const actual = specimen[index];
    if (actual === undefined) return;
    if (actual.name !== expected.name) {
      differences.push(
        `cell ${String(index)} is ${expected.name} in the reference and ${actual.name} in the app's sheet`,
      );
      return;
    }
    for (const part of ["cell", "piece"] as const) {
      if (describeRect(actual[part]) !== describeRect(expected[part])) {
        differences.push(
          `${expected.name}: the ${part} is ${describeRect(expected[part])} in the reference and ${describeRect(actual[part])} in the app's sheet`,
        );
      }
    }
    const { x, y, width, height } = expected.cell;
    if (x < 0 || y < 0 || x + width > WIDTH || y + height > HEIGHT) {
      differences.push(
        `${expected.name} lies outside the ${String(WIDTH)}x${String(HEIGHT)} window`,
      );
    }
  });
  if (differences.length > 0) {
    throw new Error(
      `The layout differs:\n  ${differences.slice(0, 10).join("\n  ")}\n` +
        "Match the app's piece to the book's size and position, then run pnpm compare:bureau again.",
    );
  }
}

/** Captures the hidden window's page. Returns the image and its raw pixels. Fails unless it is exactly 2880 × 1800. */
async function captureSheet(
  window: BrowserWindow,
): Promise<{ image: NativeImage; bitmap: Bitmap }> {
  const image = await window.webContents.capturePage(undefined, { stayHidden: true });
  const { width, height } = image.getSize();
  if (width !== WIDTH * DPR || height !== HEIGHT * DPR) {
    throw new Error(
      `A capture is ${String(width)}x${String(height)} device pixels, not ${String(WIDTH * DPR)}x${String(HEIGHT * DPR)}. ` +
        "Electron must run with --force-device-scale-factor=2; scripts/compare-bureau.ts passes it.",
    );
  }
  return { image, bitmap: { width, height, pixels: image.toBitmap() } };
}

/** Returns the working set of the renderer process behind `window`, in kilobytes, as `app.getAppMetrics()` reports it. */
function readRendererMemoryKb(window: BrowserWindow): number {
  const pid = window.webContents.getOSProcessId();
  const metric = app.getAppMetrics().find((each) => each.pid === pid);
  if (metric === undefined) {
    throw new Error(`app.getAppMetrics() lists no process ${String(pid)} for a sheet's renderer.`);
  }
  return metric.memory.workingSetSize;
}

/**
 * Compares the two sheets in `theme`, and writes the reference, the app's
 * capture and the picture of their differences to out/bureau-compare/<theme>/.
 * Returns the theme's result. Fails when a sheet does not load, the layouts
 * differ, or a capture has the wrong size.
 */
async function compareTheme(sheetsUrl: string, theme: string): Promise<ThemeResult> {
  const [reference, specimen] = await Promise.all([
    openSheet(`${sheetsUrl}reference.html?theme=${theme}`),
    openSheet(`${sheetsUrl}index.html?theme=${theme}`),
  ]);
  try {
    const [referenceLayout, specimenLayout] = await Promise.all([
      readLayout(reference),
      readLayout(specimen),
    ]);
    assertSameLayout(referenceLayout, specimenLayout);
    const referenceCapture = await captureSheet(reference);
    const specimenCapture = await captureSheet(specimen);
    const cells = referenceLayout.map(({ name, cell }) => ({
      name,
      left: cell.x * DPR,
      top: cell.y * DPR,
      width: cell.width * DPR,
      height: cell.height * DPR,
    }));
    const differences = compareBitmaps(referenceCapture.bitmap, specimenCapture.bitmap, cells);

    const themeDir = join(outputDir, theme);
    mkdirSync(themeDir, { recursive: true });
    writeFileSync(join(themeDir, "reference.png"), referenceCapture.image.toPNG());
    writeFileSync(join(themeDir, "app.png"), specimenCapture.image.toPNG());
    const diff = buildDiffBitmap(referenceCapture.bitmap, specimenCapture.bitmap);
    const diffImage = nativeImage.createFromBitmap(Buffer.from(diff.pixels.buffer), {
      width: diff.width,
      height: diff.height,
    });
    writeFileSync(join(themeDir, "diff.png"), diffImage.toPNG());

    return {
      theme,
      cells: cells.length,
      faces: cells.filter(({ name }) => name.startsWith("face/")).length,
      differences,
      rendererMemoryKb: readRendererMemoryKb(specimen),
    };
  } finally {
    reference.destroy();
    specimen.destroy();
  }
}

/** Builds the report of every theme's comparison, as `pnpm compare:bureau` prints it. */
function buildReport(results: ReadonlyArray<ThemeResult>): string {
  // THEMES is a fixed, non-empty list, so there is always a first result.
  const first = results[0]!;
  const lines = [
    `Bureau comparison: ${String(first.cells)} cells, ${String(WIDTH)}x${String(HEIGHT)} at DPR ${String(DPR)}, sRGB`,
  ];
  const failing = results.filter(({ differences }) => differences.length > 0);
  for (const { theme, cells, differences } of results) {
    const differingCells = differences.filter(({ cell }) => cell !== OUTSIDE_CELLS).length;
    lines.push(`${theme.padEnd(17)}${String(differingCells)} of ${String(cells)} cells differ`);
    if (differences.length === 0) continue;
    const nameWidth = Math.max(22, ...differences.map(({ cell }) => cell.length)) + 2;
    lines.push(`  ${"cell".padEnd(nameWidth)}pixels  max diff  box (device px)`);
    for (const { cell, pixels, maxDiff, box } of differences) {
      lines.push(
        `  ${cell.padEnd(nameWidth)}${String(pixels).padStart(6)}  ${String(maxDiff).padStart(8)}  ` +
          `x ${String(box.left)}-${String(box.right)}, y ${String(box.top)}-${String(box.bottom)}`,
      );
    }
  }
  lines.push(
    `Specimen renderer (${String(first.faces)} faces): ${String(Math.round(first.rendererMemoryKb / 1024))} MB (indicative)`,
  );
  const imagesDir = relative(repositoryDir, outputDir);
  const themes = (failing.length > 0 ? failing : results).map(({ theme }) => theme);
  for (const theme of themes) {
    lines.push(`Images: ${join(imagesDir, theme)}/{reference,app,diff}.png`);
  }
  // A cell that differs in both themes is counted once.
  const differing = new Set(
    failing.flatMap(({ differences }) => differences.map(({ cell }) => cell)),
  ).size;
  lines.push(
    differing === 0
      ? "PASSED: every cell matches the Bureau book."
      : `FAILED: ${String(differing)} ${differing === 1 ? "cell differs" : "cells differ"} from the Bureau book.`,
  );
  return `${lines.join("\n")}\n`;
}

/**
 * Writes `text` to `stream` and exits with `code` once the text has been
 * handed to the operating system. Exiting at once could cut the report short,
 * because a pipe on macOS is written asynchronously.
 */
function writeAndExit(stream: NodeJS.WriteStream, text: string, code: number): void {
  stream.write(text, () => app.exit(code));
}

// No Dock icon: the tool's windows are never shown.
app.dock?.hide();
// Each theme's windows close before the next theme's open. With no listener
// for this event, Electron would quit, with exit code 0, as soon as the first
// theme's windows close.
app.on("window-all-closed", () => {});
void app.whenReady().then(async () => {
  try {
    const sheetsUrl = app.commandLine.getSwitchValue("sheets-url");
    if (sheetsUrl === "") {
      throw new Error("Pass the sheets' address as --sheets-url; scripts/compare-bureau.ts does.");
    }
    const results: ThemeResult[] = [];
    for (const theme of THEMES) results.push(await compareTheme(sheetsUrl, theme));
    const passed = results.every(({ differences }) => differences.length === 0);
    writeAndExit(process.stdout, buildReport(results), passed ? 0 : 1);
  } catch (error) {
    writeAndExit(
      process.stderr,
      `FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
      1,
    );
  }
});
