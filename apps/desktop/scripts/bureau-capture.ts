/**
 * Electron's main process for `pnpm compare:bureau`. scripts/compare-bureau.ts
 * starts it through scripts/sheet-server.ts, which passes the address of the
 * specimen sheets as `--sheets-url` and the switches that fix the capture's
 * scale, its colour profile and how its pixels are drawn.
 *
 * For each theme, Whitehaven and Orient Express, it compares the sheet of
 * pieces: the faces, the marks and the icons. It:
 * - opens the reference sheet (the Bureau book's crew.js) and the app's
 *   specimen sheet, each in its own hidden 1440 × 900 window, and waits
 *   until each page sets `data-ready`;
 * - checks that both sheets lay out the same cells in the same places, so
 *   that every pixel reported later is a drawing difference, not a placement
 *   one;
 * - captures both windows, compares them pixel for pixel, and writes
 *   reference.png, app.png and diff.png to out/bureau-compare/<theme>/.
 *
 * Both sheets draw on the book's palette (the book's tokens.css), so a theme
 * the app retunes does not fail the comparison: it checks how the pieces are
 * drawn, not the app's colours. The app's screens are not compared here. They
 * are compared with the app's own goldens by `ui:metrics` (ADR 0047).
 *
 * Then it prints the report and exits with 0 when every pixel matches, and 1
 * when one does not or anything fails on the way.
 *
 * Electron loads this file as TypeScript by stripping its types, so it uses
 * only syntax that stripping can erase: no enums, namespaces or parameter
 * properties.
 */
import { app, nativeImage, type BrowserWindow, type NativeImage } from "electron";
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
import {
  captureSheet,
  DPR,
  HEIGHT,
  openSheet,
  startCaptureApp,
  THEMES,
  WIDTH,
  type Rect,
} from "./sheet-window.ts";

const repositoryDir = fileURLToPath(new URL("../../../", import.meta.url));
const outputDir = fileURLToPath(new URL("../out/bureau-compare/", import.meta.url));

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

/** Writes the reference, the app's capture and the picture of their differences to `dir`, each file name starting with `prefix`. */
function writeCaptures(
  dir: string,
  prefix: string,
  reference: { image: NativeImage; bitmap: Bitmap },
  specimen: { image: NativeImage; bitmap: Bitmap },
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${prefix}reference.png`), reference.image.toPNG());
  writeFileSync(join(dir, `${prefix}app.png`), specimen.image.toPNG());
  const diff = buildDiffBitmap(reference.bitmap, specimen.bitmap);
  const diffImage = nativeImage.createFromBitmap(Buffer.from(diff.pixels.buffer), {
    width: diff.width,
    height: diff.height,
  });
  writeFileSync(join(dir, `${prefix}diff.png`), diffImage.toPNG());
}

/** Returns the rectangle as the reports print it: its size, then its top-left corner, in CSS pixels. */
function describeRect({ x, y, width, height }: Rect): string {
  return `${String(width)}x${String(height)} at ${String(x)},${String(y)}`;
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
 * Compares the two sheets of pieces in `theme`, and writes both captures and
 * the picture of their differences to out/bureau-compare/<theme>/. Returns
 * the theme's result. Fails when a page does not load, the layouts differ, or
 * a capture has the wrong size.
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
    writeCaptures(join(outputDir, theme), "", referenceCapture, specimenCapture);
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

/** Returns the table of `differences`, one line per cell or item, as the report prints it under a theme. */
function buildDifferenceTable(
  heading: string,
  differences: ReadonlyArray<CellDifference>,
): ReadonlyArray<string> {
  const nameWidth = Math.max(22, ...differences.map(({ cell }) => cell.length)) + 2;
  return [
    `  ${heading.padEnd(nameWidth)}pixels  max diff  box (device px)`,
    ...differences.map(
      ({ cell, pixels, maxDiff, box }) =>
        `  ${cell.padEnd(nameWidth)}${String(pixels).padStart(6)}  ${String(maxDiff).padStart(8)}  ` +
        `x ${String(box.left)}-${String(box.right)}, y ${String(box.top)}-${String(box.bottom)}`,
    ),
  ];
}

/** Checks whether the theme's pieces match the book's, pixel for pixel. */
function matchesBook({ differences }: ThemeResult): boolean {
  return differences.length === 0;
}

/** Builds the report of every theme's comparison, as `pnpm compare:bureau` prints it. */
function buildReport(results: ReadonlyArray<ThemeResult>): string {
  // THEMES is a fixed, non-empty list, so there is always a first result.
  const first = results[0]!;
  const lines = [
    `Bureau comparison: ${String(first.cells)} cells, ${String(WIDTH)}x${String(HEIGHT)} at DPR ${String(DPR)}, sRGB`,
  ];
  for (const { theme, cells, differences } of results) {
    const differingCells = differences.filter(({ cell }) => cell !== OUTSIDE_CELLS).length;
    lines.push(`${theme.padEnd(17)}${String(differingCells)} of ${String(cells)} cells differ`);
    if (differences.length > 0) lines.push(...buildDifferenceTable("cell", differences));
  }
  lines.push(
    `Specimen renderer (${String(first.faces)} faces): ${String(Math.round(first.rendererMemoryKb / 1024))} MB (indicative)`,
  );
  const imagesDir = relative(repositoryDir, outputDir);
  const failing = results.filter((result) => !matchesBook(result));
  const themes = (failing.length > 0 ? failing : results).map(({ theme }) => theme);
  for (const theme of themes) {
    lines.push(`Images: ${join(imagesDir, theme)}/{reference,app,diff}.png`);
  }
  // A cell that differs in both themes is counted once.
  const differingCells = new Set(
    failing.flatMap(({ differences }) => differences.map(({ cell }) => cell)),
  ).size;
  lines.push(
    failing.length === 0
      ? "PASSED: every cell matches the Bureau book."
      : `FAILED: ${String(differingCells)} ${differingCells === 1 ? "cell differs" : "cells differ"} from the Bureau book.`,
  );
  return `${lines.join("\n")}\n`;
}

startCaptureApp(async (sheetsUrl) => {
  const results: ThemeResult[] = [];
  for (const theme of THEMES) results.push(await compareTheme(sheetsUrl, theme));
  return { report: buildReport(results), passed: results.every(matchesBook) };
});
