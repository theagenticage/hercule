/**
 * Electron's main process for `pnpm compare:bureau`. scripts/compare-bureau.ts
 * starts it through scripts/sheet-server.ts, which passes the address of the
 * specimen sheets as `--sheets-url` and the switches that fix the capture's
 * scale, its colour profile and how its pixels are drawn.
 *
 * For each theme, Whitehaven and Orient Express, it compares eight pairs of
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
 * The other pairs each compare one region of a book page with the same
 * region of an app specimen drawn from a fixture:
 * - the sidebar (x 0-272) of session-active.html: the book's page edited by
 *   specimens/sidebar-reference.ts, and the sidebar specimen (sidebar.html);
 * - the thread (x 272-1440, the main pane) of session-active.html: the
 *   book's page edited by specimens/thread-reference.ts, and the thread
 *   specimen (thread.html);
 * - the scrolled thread: the same main pane with the transcript scrolled
 *   away from its bottom and the composer shrunk. Both pages are opened with
 *   `?state=scrolled`;
 * - the draft (the main pane) of session-empty.html: the book's page edited
 *   by specimens/draft-reference.ts, and the draft specimen (draft.html);
 * - the draft of a fresh install, with starter threads in place of the start
 *   cards: the same pages, opened with `?state=first`, and again with
 *   `?state=first-no-repo` for a project with no repository;
 * - the Conversation (the main pane below its floating header) of
 *   assistant.html: the book's page edited by
 *   specimens/conversation-reference.ts, and the Conversation specimen
 *   (conversation.html).
 *
 * Each reference module edits the book's page to show its fixture's data.
 * For each region pair, the capture:
 * - captures the region of both windows, the full height, and writes
 *   <region>-reference.png, <region>-app.png and <region>-diff.png;
 * - checks that both pages draw the same visible items in the same boxes,
 *   and only then compares the regions pixel for pixel.
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
  MAIN_PANE_REGION,
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

/** Where a page lays out one of its items, and the item's text, to name it in a report. */
interface PageItem {
  /** The selector that found the item, and its place among the items that selector found. */
  readonly name: string;
  readonly text: string;
  readonly box: Rect;
}

/** A region of a book page that is compared with the same region of an app specimen. */
interface RegionPair {
  /** The region's name in the report and in its images' file names. */
  readonly name: string;
  /** The book's page, under /design/crew-bureau-2/desktop/. */
  readonly bookPage: string;
  /** The module that edits the book's page to show the fixture's data, under /specimens/. */
  readonly referenceModule: string;
  /** The app's specimen page, under /specimens/. */
  readonly specimenPage: string;
  /** The book's `?state=`, which the specimen page is opened with too, or none. */
  readonly state?: string;
  readonly region: Rect;
  /** The element both pages' items are looked for in. */
  readonly scope: string;
  /**
   * Every part whose box is compared, as a selector inside `scope`. The two
   * pages differ in their markup where the book's differs from what React
   * draws, such as a "more" row that is a button in the app and a link in
   * the book, so the parts are named by class, not by tag.
   */
  readonly parts: ReadonlyArray<string>;
}

/** The outcome of one region pair's comparison in one theme. */
interface RegionResult {
  readonly name: string;
  /** How many items were compared. */
  readonly items: number;
  /** The differences in the region, each named after the smallest item that holds it. */
  readonly differences: ReadonlyArray<CellDifference>;
}

/** The outcome of one theme's comparison. */
interface ThemeResult {
  readonly theme: string;
  readonly cells: number;
  readonly faces: number;
  readonly differences: ReadonlyArray<CellDifference>;
  /** The specimen window's renderer process's working set, in kilobytes. */
  readonly rendererMemoryKb: number;
  /** One result per region pair, in `REGION_PAIRS`' order. */
  readonly regions: ReadonlyArray<RegionResult>;
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
// `aside.side`.
const SIDEBAR_PARTS = [
  ".side-top > .icon-btn",
  ".side-top > .icon-btn > svg",
  ".side-actions > .nav-row",
  ".side-actions > .nav-row > svg",
  ".side-actions > .nav-row > span",
  ".side-actions > .nav-row > kbd",
  ".side-actions > .icon-btn",
  ".side-actions > .icon-btn > svg",
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

// Every part of the thread screen whose box is compared, as a selector
// inside `main.main`. The book wraps some of the composer's rows in one more
// element inside each fold than the app does, so the composer's parts are
// found at any depth. Three parts are left out, and the pixel comparison
// checks them:
// - the transcript's column: the app's holds the virtualizer's items, and its
//   height depends on what the book leaves out below the composer;
// - the phrases of a divider's summary, such as "ran 1 command". The book
//   lays them out as flex items, each as tall as the line, and the app writes
//   them as one line of text, so that the line can end in an ellipsis, and
//   each phrase is as tall as its font. Both draw the same pixels;
// - the composer's field. The book's fills the card, and the app's sits 8px
//   inside it with 8px less padding, so that its scroll bar stays inside the
//   card's rounded corner. The text lands on the same pixels.
const THREAD_PARTS = [
  ".top",
  ".top > .pill",
  ".pill-crumb",
  ".pill-crumb > .proj",
  ".ptab",
  ".ptab > .mark",
  ".ptab > small",
  ".top .icon-btn",
  ".top .icon-btn > svg",
  ".transcript",
  ".msg--me",
  ".bubble",
  ".bubble-meta",
  ".worked",
  ".worked > b",
  ".worked .tools",
  ".tx .msg",
  ".tx .msg > svg",
  ".msg-meta",
  ".msg-body",
  ".msg-body > p",
  ".msg-body p > code",
  ".codeblock",
  ".waiting-note",
  ".waiting-note > .mark",
  ".composer-wrap",
  ".composer",
  ".queued",
  ".queued > svg",
  ".queued-text",
  ".queued > .faint",
  ".queued > .btn",
  ".dock",
  ".dock-q",
  ".dock-q > svg",
  ".dock-q code",
  ".dock .ledger",
  ".dock .ans",
  ".dock .ans > .btn",
  ".dock .ans-desc",
  ".dock .ans > kbd",
  ".dock-mini",
  ".dock-mini > svg",
  ".dock-mini-q",
  ".dock-mini > .btn",
  ".composer-card",
  ".composer-row",
  ".composer-row > *",
  ".composer-row svg",
  ".lip",
  ".lip > span",
  ".lip svg",
  ".lip > span > span:not(.faint)",
  ".lip .faint",
];

// Every part of the draft screen whose box is compared, as a selector inside
// `main.main`. The composer's field is left out, for the thread's reason:
// the book's fills the card, and the app's sits 8px inside it with 8px less
// padding. The pixel comparison checks it.
const DRAFT_PARTS = [
  ".top",
  ".top > .pill",
  ".pill-crumb",
  ".pill-crumb > .proj",
  ".ptab",
  ".ptab > svg",
  ".top .icon-btn",
  ".top .icon-btn > svg",
  ".hello",
  ".hello .column",
  ".newbie",
  ".newbie-face",
  ".newbie-face > svg",
  ".newbie h1",
  ".newbie p",
  ".composer",
  ".composer-card",
  ".composer-row",
  ".composer-row > *",
  ".composer-row svg",
  ".lip",
  ".lip > *",
  ".lip svg",
  ".starts-h",
  ".starts-h > svg",
  ".starts",
  ".start",
  ".start-top",
  ".start-top > *",
  ".start-top .bars > i",
  ".start > b",
  ".intake-note",
  ".intake-note > svg",
];

// Every part of the Conversation whose box is compared, as a selector inside
// `main.main`. Three parts are left out, and the pixel comparison checks
// them:
// - the transcript and its column: the app's column holds the virtualizer's
//   items, and its height depends on the composer's;
// - the composer's field, for the thread's reason: the book's fills the
//   card, and the app's sits 8px inside it with 8px less padding;
// - the caret, which the app draws as the open paragraph's `::after`, where
//   the book draws a span.
const CONVERSATION_PARTS = [
  ".stamp",
  ".notice",
  ".notice > .cr",
  ".notice > span",
  ".notice .time",
  ".msg",
  ".msg > .cr",
  ".msg-body",
  ".msg-name",
  ".msg-name > small",
  ".msg-body > p",
  ".msg--me",
  ".bubble",
  ".bubble-meta",
  ".composer-wrap",
  ".composer",
  ".composer-card",
  ".composer-row",
  ".composer-row > *",
  ".composer-row svg",
];

/**
 * How far the first block of a main pane sits below the window's top, in CSS
 * pixels: the room left for the floating header. It is the app's
 * `--header-clearance` (screens/session/floating-header.css).
 */
const HEADER_CLEARANCE = 108;

/**
 * The gap between two blocks of the Conversation, in CSS pixels: the 20px
 * the Conversation's column takes off `--header-clearance` at its top
 * (screens/assistant/assistant.css), because each block carries the gap
 * above it.
 */
const CONVERSATION_BLOCK_GAP = 20;

/**
 * The Conversation's region of the window: the main pane below its floating
 * header. The header is left out, because the book draws a bar there; the
 * region starts one block gap above the first block.
 */
const CONVERSATION_TOP = HEADER_CLEARANCE - CONVERSATION_BLOCK_GAP;
const CONVERSATION_REGION: Rect = {
  ...MAIN_PANE_REGION,
  y: CONVERSATION_TOP,
  height: MAIN_PANE_REGION.height - CONVERSATION_TOP,
};

/** The regions of book pages compared with an app specimen, in the order they are compared. */
const REGION_PAIRS: ReadonlyArray<RegionPair> = [
  {
    name: "sidebar",
    bookPage: "session-active.html",
    referenceModule: "sidebar-reference.ts",
    specimenPage: "sidebar.html",
    region: SIDEBAR_REGION,
    scope: "aside.side",
    parts: SIDEBAR_PARTS,
  },
  {
    name: "thread",
    bookPage: "session-active.html",
    referenceModule: "thread-reference.ts",
    specimenPage: "thread.html",
    region: MAIN_PANE_REGION,
    scope: "main.main",
    parts: THREAD_PARTS,
  },
  {
    name: "scrolled-thread",
    bookPage: "session-active.html",
    referenceModule: "thread-reference.ts",
    specimenPage: "thread.html",
    state: "scrolled",
    region: MAIN_PANE_REGION,
    scope: "main.main",
    parts: THREAD_PARTS,
  },
  {
    name: "draft",
    bookPage: "session-empty.html",
    referenceModule: "draft-reference.ts",
    specimenPage: "draft.html",
    region: MAIN_PANE_REGION,
    scope: "main.main",
    parts: DRAFT_PARTS,
  },
  {
    name: "draft-first",
    bookPage: "session-empty.html",
    referenceModule: "draft-reference.ts",
    specimenPage: "draft.html",
    state: "first",
    region: MAIN_PANE_REGION,
    scope: "main.main",
    parts: DRAFT_PARTS,
  },
  {
    name: "draft-first-no-repo",
    bookPage: "session-empty.html",
    referenceModule: "draft-reference.ts",
    specimenPage: "draft.html",
    state: "first-no-repo",
    region: MAIN_PANE_REGION,
    scope: "main.main",
    parts: DRAFT_PARTS,
  },
  {
    name: "conversation",
    bookPage: "assistant.html",
    referenceModule: "conversation-reference.ts",
    specimenPage: "conversation.html",
    region: CONVERSATION_REGION,
    scope: "main.main",
    parts: CONVERSATION_PARTS,
  },
];

/**
 * Returns the script that reads a page's items: every visible element each
 * of `parts` finds inside `scope`, in document order, then `scope` itself.
 * An element that is not visible is left out:
 * - one that is not drawn, such as one in the book's hidden Hercule tab,
 *   which has no box;
 * - one inside an element with an opacity of 0, such as a fold of the
 *   book's shrunk composer, which keeps its box where the app's fold has
 *   none.
 */
function buildReadItemsScript(scope: string, parts: ReadonlyArray<string>): string {
  return `(() => {
  const scope = document.querySelector(${JSON.stringify(scope)});
  const measure = (element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  };
  const describe = (element) => element.textContent.replace(/\\s+/g, " ").trim().slice(0, 40);
  const items = ${JSON.stringify(parts)}.flatMap((selector) =>
    [...scope.querySelectorAll(selector)]
      .filter((element) => element.checkVisibility({ opacityProperty: true }))
      .map((element, index) => ({ name: selector + " #" + index, text: describe(element), box: measure(element) })),
  );
  return [...items, { name: ${JSON.stringify(scope)}, text: "", box: measure(scope) }];
})()`;
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
 * Checks that the book and the app draw the same items of the region `name`
 * in the same boxes: for each part, the same number of items, each in the
 * same box. Fails with "The <name>'s items differ" and the first differences
 * otherwise.
 */
function assertSameItems(
  name: string,
  reference: ReadonlyArray<PageItem>,
  specimen: ReadonlyArray<PageItem>,
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
      `The ${name}'s items differ (${String(differences.length)}):\n  ${differences.slice(0, 40).join("\n  ")}\n` +
        "Match the app's item to the book's box, then run pnpm compare:bureau again.",
    );
  }
}

/**
 * Compares the app's specimen with the book's page over the region of `pair`
 * in `theme`, and writes both captures of the region and the
 * picture of their differences to `themeDir`. Returns how many items were
 * compared, and the differences, each named after the smallest item that
 * holds it. Fails when a page does not load, a capture has the wrong size,
 * or an item's box differs.
 */
async function compareRegion(
  sheetsUrl: string,
  theme: string,
  themeDir: string,
  pair: RegionPair,
): Promise<RegionResult> {
  const { name, bookPage, referenceModule, specimenPage, state, region, scope, parts } = pair;
  const query = `?theme=${theme}${state === undefined ? "" : `&state=${state}`}`;
  const [reference, specimen] = await Promise.all([
    openSheet(
      new URL(`/design/crew-bureau-2/desktop/${bookPage}${query}`, sheetsUrl).href,
      new URL(referenceModule, sheetsUrl).href,
    ),
    openSheet(`${sheetsUrl}${specimenPage}${query}`),
  ]);
  try {
    const readItems = buildReadItemsScript(scope, parts);
    const [referenceItems, specimenItems] = (await Promise.all([
      reference.webContents.executeJavaScript(readItems),
      specimen.webContents.executeJavaScript(readItems),
    ])) as [ReadonlyArray<PageItem>, ReadonlyArray<PageItem>];
    const referenceCapture = await captureSheet(reference, region);
    const specimenCapture = await captureSheet(specimen, region);
    writeCaptures(themeDir, `${name}-`, referenceCapture, specimenCapture);
    assertSameItems(name, referenceItems, specimenItems);

    // A pixel is counted for the first item that holds it, so the smallest
    // items come first: a difference in a row's name is reported as the
    // name's, not the row's.
    const cells = [...referenceItems]
      .sort((a, b) => a.box.width * a.box.height - b.box.width * b.box.height)
      .map((item) => ({
        name: item.text === "" ? item.name : `${item.name} "${item.text}"`,
        left: (item.box.x - region.x) * DPR,
        top: (item.box.y - region.y) * DPR,
        width: item.box.width * DPR,
        height: item.box.height * DPR,
      }));
    return {
      name,
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
 * Compares the two sheets of pieces in `theme`, then each region pair, and
 * writes each pair's captures and the picture of their differences to
 * out/bureau-compare/<theme>/. Returns the theme's result. Fails when a page
 * does not load, the layouts or a region's items differ, or a capture has
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

    const regions: RegionResult[] = [];
    for (const pair of REGION_PAIRS) {
      regions.push(await compareRegion(sheetsUrl, theme, themeDir, pair));
    }
    return {
      theme,
      cells: cells.length,
      faces: cells.filter(({ name }) => name.startsWith("face/")).length,
      differences,
      rendererMemoryKb,
      regions,
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

/** Checks whether the theme's pieces and every region match the book's, pixel for pixel. */
function matchesBook({ differences, regions }: ThemeResult): boolean {
  return differences.length === 0 && regions.every((region) => region.differences.length === 0);
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
  REGION_PAIRS.forEach(({ name, bookPage, state, region }, index) => {
    const words = name.replaceAll("-", " ");
    lines.push(
      `${words.slice(0, 1).toUpperCase()}${words.slice(1)} comparison: ${String(first.regions[index]!.items)} items, ` +
        `x ${String(region.x)}-${String(region.x + region.width)} of ${bookPage}` +
        (state === undefined ? "" : `?state=${state}`),
    );
    for (const { theme, regions } of results) {
      const { differences } = regions[index]!;
      const pixels = differences.reduce((sum, each) => sum + each.pixels, 0);
      lines.push(`${theme.padEnd(17)}${String(pixels)} pixels differ`);
      if (pixels > 0) lines.push(...buildDifferenceTable("item", differences));
    }
  });
  lines.push(
    `Specimen renderer (${String(first.faces)} faces): ${String(Math.round(first.rendererMemoryKb / 1024))} MB (indicative)`,
  );
  const imagesDir = relative(repositoryDir, outputDir);
  const failing = results.filter((result) => !matchesBook(result));
  const themes = (failing.length > 0 ? failing : results).map(({ theme }) => theme);
  const regionImages = REGION_PAIRS.map(({ name }) => `${name}-{reference,app,diff}.png`);
  for (const theme of themes) {
    lines.push(
      `Images: ${join(imagesDir, theme)}/{reference,app,diff}.png, ${regionImages.join(", ")}`,
    );
  }
  // A cell that differs in both themes is counted once, and so is an item.
  const differingCells = new Set(
    failing.flatMap(({ differences }) => differences.map(({ cell }) => cell)),
  ).size;
  const differingItems = new Set(
    failing.flatMap(({ regions }) =>
      regions.flatMap(({ name, differences }) => differences.map(({ cell }) => `${name} ${cell}`)),
    ),
  ).size;
  const nameRegions = (pairs: ReadonlyArray<RegionPair>): string =>
    new Intl.ListFormat("en").format(pairs.map(({ name }) => `the ${name.replaceAll("-", " ")}`));
  // The failure names only the regions that differ, so a reader knows where to look.
  const differingPairs = REGION_PAIRS.filter((_, index) =>
    failing.some(({ regions }) => regions[index]!.differences.length > 0),
  );
  lines.push(
    failing.length === 0
      ? `PASSED: every cell, ${nameRegions(REGION_PAIRS)} match the Bureau book.`
      : `FAILED: ${String(differingCells)} ${differingCells === 1 ? "cell differs" : "cells differ"} ` +
          `and ${String(differingItems)} ${differingItems === 1 ? "item differs" : "items differ"}` +
          (differingPairs.length === 0 ? "" : ` in ${nameRegions(differingPairs)}`) +
          " from the Bureau book.",
  );
  return `${lines.join("\n")}\n`;
}

startCaptureApp(async (sheetsUrl) => {
  const results: ThemeResult[] = [];
  for (const theme of THEMES) results.push(await compareTheme(sheetsUrl, theme));
  return { report: buildReport(results), passed: results.every(matchesBook) };
});
