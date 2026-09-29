/**
 * Electron's main process for `pnpm compare:bureau`. scripts/compare-bureau.ts
 * starts it through scripts/sheet-server.ts, which passes the address of the
 * specimen sheets as `--sheets-url` and the switches that fix the capture's
 * scale, its colour profile and how its pixels are drawn.
 *
 * For each theme, Whitehaven and Orient Express, it compares two pairs of
 * pages. The first pair is the sheets of pieces. It:
 * - opens the reference sheet (the Bureau book's crew.js) and the app's
 *   specimen sheet, each in its own hidden 1440 × 900 window, and waits
 *   until each page sets `data-ready`;
 * - checks that both sheets lay out the same cells in the same places, so
 *   that every pixel reported later is a drawing difference, not a placement
 *   one;
 * - captures both windows, compares them pixel for pixel, and writes
 *   reference.png, app.png and diff.png to out/bureau-compare/<theme>/.
 *
 * The second pair is the sidebar. It:
 * - opens the book's session-active.html, edited by
 *   specimens/sidebar-reference.ts to show the fixture's data, and the app's
 *   sidebar specimen, drawn from the same fixture;
 * - captures the sidebar's region of both windows (x 0-272, the full height)
 *   and writes sidebar-reference.png, sidebar-app.png and sidebar-diff.png;
 * - checks that both sidebars draw the same items in the same boxes, and
 *   only then compares the regions pixel for pixel.
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
  SIDEBAR_REGION,
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

/** Where a sidebar lays out one of its items, and the item's text, to name it in a report. */
interface SidebarItem {
  /** The selector that found the item, and its place among the items that selector found. */
  readonly name: string;
  readonly text: string;
  readonly box: Rect;
}

/** The outcome of one theme's comparison. */
interface ThemeResult {
  readonly theme: string;
  readonly cells: number;
  readonly faces: number;
  readonly differences: ReadonlyArray<CellDifference>;
  /** The specimen window's renderer process's working set, in kilobytes. */
  readonly rendererMemoryKb: number;
  /** How many sidebar items were compared. */
  readonly sidebarItems: number;
  /** The differences in the sidebar's region, each named after the smallest item that holds it. */
  readonly sidebarDifferences: ReadonlyArray<CellDifference>;
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

// Every part of the sidebar whose box is compared, as a selector inside
// `aside.side`. The two sidebars differ in their markup where the book's
// differs from what React draws, such as a "more" row that is a button in the
// app and a link in the book, so the parts are named by class, not by tag.
const SIDEBAR_PARTS = [
  ".side-top > .icon-btn",
  ".side-top > .icon-btn > svg",
  ".side-actions > .nav-row",
  ".side-actions > .nav-row > svg",
  ".side-actions > .nav-row > span",
  ".side-actions > .nav-row > kbd",
  ".side-scroll",
  ".side-h",
  ".side-h > span:first-child",
  ".side-h > .count",
  ".side-h > .icon-btn",
  ".side-h > .icon-btn > svg",
  ".side-row",
  ".side-row > svg",
  ".side-row .side-name",
  ".side-row .side-ask",
  ".side-row .side-meta",
  ".side-row .side-end",
  ".side-row .side-end > :not([hidden])",
  ".side-foot",
  ".side-sum",
  ".side-sum > b",
  ".side-me",
  ".side-me > svg",
  ".side-me > .side-name",
  ".side-me > .icon-btn",
  ".side-me > .icon-btn > svg",
];

// Runs in each sidebar page: every drawn element each part's selector finds,
// in document order, then the sidebar itself. An element that is not drawn,
// such as one in the book's hidden Hercule tab, has no box and is left out.
const READ_SIDEBAR_ITEMS = `(() => {
  const side = document.querySelector("aside.side");
  const measure = (element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  };
  const describe = (element) => element.textContent.replace(/\\s+/g, " ").trim().slice(0, 40);
  const items = ${JSON.stringify(SIDEBAR_PARTS)}.flatMap((selector) =>
    [...side.querySelectorAll(selector)]
      .filter((element) => element.getClientRects().length > 0)
      .map((element, index) => ({ name: selector + " #" + index, text: describe(element), box: measure(element) })),
  );
  return [...items, { name: "aside.side", text: "", box: measure(side) }];
})()`;

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

/**
 * Checks that the two sidebars draw the same items in the same boxes: for
 * each part, the same number of items, each in the same box. Fails with
 * "The sidebar's items differ" and the first differences otherwise.
 */
function assertSameSidebarItems(
  reference: ReadonlyArray<SidebarItem>,
  specimen: ReadonlyArray<SidebarItem>,
): void {
  const differences: string[] = [];
  const specimenItems = new Map(specimen.map((item) => [item.name, item]));
  const referenceNames = new Set(reference.map(({ name }) => name));
  for (const expected of reference) {
    const actual = specimenItems.get(expected.name);
    if (actual === undefined) {
      differences.push(`${expected.name} "${expected.text}" is in the book and not in the app`);
    } else if (describeRect(actual.box) !== describeRect(expected.box)) {
      differences.push(
        `${expected.name} "${expected.text}": the book's box is ${describeRect(expected.box)}, the app's ${describeRect(actual.box)}`,
      );
    }
  }
  for (const actual of specimen) {
    if (!referenceNames.has(actual.name)) {
      differences.push(`${actual.name} "${actual.text}" is in the app and not in the book`);
    }
  }
  if (differences.length > 0) {
    throw new Error(
      `The sidebar's items differ (${String(differences.length)}):\n  ${differences.slice(0, 40).join("\n  ")}\n` +
        "Match the app's item to the book's box, then run pnpm compare:bureau again.",
    );
  }
}

/**
 * Compares the app's sidebar with the book's in `theme`, and writes both
 * captures of the sidebar's region and the picture of their differences to
 * `themeDir`. Returns how many items were compared, and the differences,
 * each named after the smallest item that holds it. Fails when a page does
 * not load, a capture has the wrong size, or an item's box differs.
 */
async function compareSidebar(
  sheetsUrl: string,
  theme: string,
  themeDir: string,
): Promise<{ items: number; differences: ReadonlyArray<CellDifference> }> {
  const [reference, specimen] = await Promise.all([
    openSheet(
      new URL(`/design/crew-bureau/desktop/session-active.html?theme=${theme}`, sheetsUrl).href,
      new URL("sidebar-reference.ts", sheetsUrl).href,
    ),
    openSheet(`${sheetsUrl}sidebar.html?theme=${theme}`),
  ]);
  try {
    const [referenceItems, specimenItems] = (await Promise.all([
      reference.webContents.executeJavaScript(READ_SIDEBAR_ITEMS),
      specimen.webContents.executeJavaScript(READ_SIDEBAR_ITEMS),
    ])) as [ReadonlyArray<SidebarItem>, ReadonlyArray<SidebarItem>];
    const referenceCapture = await captureSheet(reference, SIDEBAR_REGION);
    const specimenCapture = await captureSheet(specimen, SIDEBAR_REGION);
    writeCaptures(themeDir, "sidebar-", referenceCapture, specimenCapture);
    assertSameSidebarItems(referenceItems, specimenItems);

    // A pixel is counted for the first item that holds it, so the smallest
    // items come first: a difference in a row's name is reported as the
    // name's, not the row's.
    const cells = [...referenceItems]
      .sort((a, b) => a.box.width * a.box.height - b.box.width * b.box.height)
      .map(({ name, text, box }) => ({
        name: text === "" ? name : `${name} "${text}"`,
        left: (box.x - SIDEBAR_REGION.x) * DPR,
        top: (box.y - SIDEBAR_REGION.y) * DPR,
        width: box.width * DPR,
        height: box.height * DPR,
      }));
    return {
      items: referenceItems.length,
      differences: compareBitmaps(referenceCapture.bitmap, specimenCapture.bitmap, cells),
    };
  } finally {
    reference.destroy();
    specimen.destroy();
  }
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
 * Compares the two sheets of pieces in `theme`, then the two sidebars, and
 * writes each pair's captures and the picture of their differences to
 * out/bureau-compare/<theme>/. Returns the theme's result. Fails when a page
 * does not load, the layouts or the sidebar's items differ, or a capture has
 * the wrong size.
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
    writeCaptures(themeDir, "", referenceCapture, specimenCapture);
    const rendererMemoryKb = readRendererMemoryKb(specimen);
    reference.destroy();
    specimen.destroy();

    const sidebar = await compareSidebar(sheetsUrl, theme, themeDir);
    return {
      theme,
      cells: cells.length,
      faces: cells.filter(({ name }) => name.startsWith("face/")).length,
      differences,
      rendererMemoryKb,
      sidebarItems: sidebar.items,
      sidebarDifferences: sidebar.differences,
    };
  } finally {
    // Destroying a window twice does nothing.
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

/** Checks whether the theme's pieces and sidebar both match the book's, pixel for pixel. */
function matchesBook({ differences, sidebarDifferences }: ThemeResult): boolean {
  return differences.length === 0 && sidebarDifferences.length === 0;
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
    `Sidebar comparison: ${String(first.sidebarItems)} items, x 0-${String(SIDEBAR_REGION.width)} of session-active.html`,
  );
  for (const { theme, sidebarDifferences } of results) {
    const pixels = sidebarDifferences.reduce((sum, { pixels }) => sum + pixels, 0);
    lines.push(`${theme.padEnd(17)}${String(pixels)} pixels differ`);
    if (pixels > 0) lines.push(...buildDifferenceTable("item", sidebarDifferences));
  }
  lines.push(
    `Specimen renderer (${String(first.faces)} faces): ${String(Math.round(first.rendererMemoryKb / 1024))} MB (indicative)`,
  );
  const imagesDir = relative(repositoryDir, outputDir);
  const failing = results.filter((result) => !matchesBook(result));
  const themes = (failing.length > 0 ? failing : results).map(({ theme }) => theme);
  for (const theme of themes) {
    lines.push(
      `Images: ${join(imagesDir, theme)}/{reference,app,diff}.png and sidebar-{reference,app,diff}.png`,
    );
  }
  // A cell that differs in both themes is counted once, and so is an item.
  const differingCells = new Set(
    failing.flatMap(({ differences }) => differences.map(({ cell }) => cell)),
  ).size;
  const differingItems = new Set(
    failing.flatMap(({ sidebarDifferences }) => sidebarDifferences.map(({ cell }) => cell)),
  ).size;
  lines.push(
    failing.length === 0
      ? "PASSED: every cell and the sidebar match the Bureau book."
      : `FAILED: ${String(differingCells)} ${differingCells === 1 ? "cell differs" : "cells differ"} ` +
          `and ${String(differingItems)} sidebar ${differingItems === 1 ? "item differs" : "items differ"} from the Bureau book.`,
  );
  return `${lines.join("\n")}\n`;
}

startCaptureApp(async (sheetsUrl) => {
  const results: ThemeResult[] = [];
  for (const theme of THEMES) results.push(await compareTheme(sheetsUrl, theme));
  return { report: buildReport(results), passed: results.every(matchesBook) };
});
