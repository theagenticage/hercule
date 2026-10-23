/**
 * Electron's main process for `pnpm compare:bureau`. scripts/compare-bureau.ts
 * starts it through scripts/sheet-server.ts, which passes the address of the
 * specimen sheets as `--sheets-url` and the switches that fix the capture's
 * scale, its colour profile and how its pixels are drawn.
 *
 * For each theme, Whitehaven and Orient Express, it compares thirty-nine pairs of
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
 * - the sidebar rows: the sidebar (x 0-272) of the Workbench, refined
 *   drawing's `?state=rows`, which draws one row each for 1, 2, 3 and 10
 *   Threads, edited by specimens/sidebar-rows-reference.ts, and the sidebar
 *   rows specimen (sidebar-rows.html);
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
 *   (conversation.html);
 * - Settings > Assistants (the main pane) of settings-assistants.html: the
 *   book's page edited by specimens/settings-assistants-reference.ts, and
 *   the Settings > Assistants specimen (settings-assistants.html);
 * - the same section scrolled to its end, because it is taller than the
 *   window. Both pages are opened with `?state=scrolled`;
 * - Settings > Appearance (the main pane) of settings-appearance.html: the
 *   book's page edited by specimens/settings-appearance-reference.ts, and
 *   the Settings > Appearance specimen (settings-appearance.html);
 * - Settings > Permission profiles (the main pane) of settings-profiles.html,
 *   in the four states the book draws with `?state=`: the list, Reviewer's
 *   page (`reviewer`), `unrestricted`'s page (`shipped`) and `unrestricted`'s
 *   page with the confirmation open (`confirm`). The book's page is edited by
 *   specimens/settings-profiles-reference.ts, and the specimen is
 *   settings-profiles.html. The two profile pages are taller than the
 *   window, so each is compared again scrolled to the end of its body, with
 *   `?scrolled=1` added to both pages' addresses;
 * - Settings > Connections (the main pane) of settings-connections.html: the
 *   book's page edited by specimens/settings-connections-reference.ts, and
 *   the Settings > Connections specimen (settings-connections.html);
 * - Intake (the main pane) of the Intake design's page,
 *   intake-directions/asks/desktop/intake.html, with Marta's review request
 *   open: the design's page edited by specimens/intake-reference.ts, and the
 *   Intake specimen (intake.html);
 * - the Tracking pane (the pane's column, x 704-1440 below the header) of the
 *   Tracking drawing, tracking/index.html, in its Finished and Failed states
 *   (`?state=finished`, `?state=failed`): the drawing edited by
 *   specimens/tracking-pane-reference.ts, and the Intake specimen's
 *   `tracking-pane-finished` and `tracking-pane-failed` scenes. The list beside
 *   the pane is not compared. The reference module lists what the app
 *   knowingly draws differently: the standing line without the harness, model
 *   and runner, no foot and no Try again, and a run's line under the
 *   message;
 * - the workflow list (the main pane) of workflows.html, in its table view:
 *   the book's page stilled by specimens/workflows-reference.ts, and the
 *   Workflows specimen (workflows.html). The app draws only the rows near
 *   the window, so the items of this pair are only those inside the window;
 * - Ship release open on the same pages, with its runs as a list: beside
 *   the list drawn as a column (`?view=split`), and across the whole pane
 *   (`?view=full`). Again only the items inside the window count. The
 *   reference module draws the GitHub mark on the book's open_pr step, as
 *   the app draws a plugin's action step with its plugin's mark;
 * - Ship release open across the whole pane with today's runs on the
 *   timeline (`?view=full&runs=timeline`). The reference module moves the
 *   book's hour axis into the tab band, where spec 17 puts it;
 * - a run's page (the main pane) of run.html: the book's page stilled by
 *   specimens/run-reference.ts, and the run specimen (run.html), whose
 *   fixture holds two of the book's runs of Ship release. The waiting run
 *   is compared on its graph, then with the card of its security step open
 *   (`&card=security`) and with the card of its review step, which the run
 *   came to twice (`&card=review`). The failed run is compared on its step
 *   timeline (`?state=failed&steps=timeline`): an ended run's axis ends
 *   where the run ended, so its ticks are the book's. Then each dialog:
 *   Cancel run on the waiting run (`&dialog=cancel`) and Re-run on the
 *   failed one (`?state=failed&dialog=rerun`). The reference module draws
 *   the GitHub mark on open_pr, and opens the dialog in the top layer, as
 *   the app does. On the waiting run it also adds the Workspace row the app
 *   draws, which the book leaves out, and moves an open card down by the
 *   row's height, with the node it belongs to;
 * - the Discussions page (the main pane) of discussions.html: the book's page
 *   stilled by specimens/discussions-reference.ts, and the Discussions
 *   specimen (discussions.html), in its table view, with the list as a column
 *   beside the open Discussion (`?view=split`), and with the open Discussion
 *   across the whole pane (`?view=full`). Only the items inside the window
 *   count. The reference module strips the code block's syntax colours, which
 *   the app does not draw;
 * - the Wiki page of wiki.html, in the same three views, and with an older
 *   revision open beside the list (`?view=split&rev=4`). Its reference module
 *   strips the code block's colours too, and writes "Tue" where the book's History says
 *   "Yesterday", as the app does for any day of the last week.
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
  /** The design page, as a path under /design/ (docs/design), such as `crew-bureau-2/desktop/session-active.html`. */
  readonly bookPage: string;
  /** The module that edits the book's page to show the fixture's data, under /specimens/. */
  readonly referenceModule: string;
  /** The app's specimen page, under /specimens/. */
  readonly specimenPage: string;
  /** The book's `?state=`, which the specimen page is opened with too, or none. */
  readonly state?: string;
  /**
   * The book's own parameters besides `?state=`, such as workflows.html's
   * `{ view: "split" }`, which the specimen page is opened with too.
   */
  readonly search?: Readonly<Record<string, string>>;
  /**
   * Whether both pages are opened with `?scrolled=1`, which makes each scroll
   * its section's body to the end. A page that needs `?state=` for something
   * else cannot use `?state=scrolled`.
   */
  readonly scrolled?: true;
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
  /**
   * Whether only the items whose box reaches into the window are compared.
   * Set it for a page whose list mounts only the rows near the window, as
   * the app's long lists do, where the book draws every row.
   */
  readonly itemsInWindowOnly?: true;
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
  ".seg--side",
  ".seg--side > button",
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
  ".side-h > .side-need",
  ".side-h > .icon-btn",
  ".side-h > .icon-btn > svg",
  ".side-row",
  ".side-row > svg",
  ".side-row .side-name",
  ".side-row .side-ask",
  ".side-row .side-detail",
  ".side-row .side-detail > *",
  ".side-row .side-detail svg",
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

// Every part of the sidebar rows whose box is compared, as a selector inside
// `aside.side`. The Workbench, refined drawing names the parts of a group's
// row with its own classes, so a part that the two pages name differently is
// one selector that lists both names: the app's, then the drawing's.
const SIDEBAR_ROWS_PARTS = [
  ".side-top > .icon-btn",
  ".seg--side",
  ".seg--side > button",
  ".side-actions > .nav-row",
  ".side-actions > .icon-btn",
  ".side-scroll",
  ".side-h",
  ".side-h > .count",
  ".side-h > .proj",
  ".side-h > .proj > span",
  ".side-h > .side-need, .side-h > .st-need",
  ".side-h > .icon-btn",
  ".side-row",
  ".side-row > svg",
  ".side-row .side-name",
  ".side-row .side-ask",
  ".side-row .side-asker, .side-row .b2-asker",
  ".side-row .side-end",
  ".side-thread, .st-thread",
  ".side-line, .st-line",
  ".side-detail, .st-detail",
  ".side-glyph, .st-glyph",
  ".side-detail-clip, .st-clip",
  ".side-dots, .b2-dots",
  ".side-dot, .b2-dot",
  ".side-dots-more, .b2-more",
  ".side-foot",
  ".side-sum",
  ".side-sum > b",
  ".side-me",
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
  ".lip > span > span:not(.faint), .lip > span > button > span:not(.faint)",
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

// Every part of Settings > Assistants whose box is compared, as a selector
// inside `main.main`: the header, the Settings list, the section and the
// Memory column beside it. The fields are compared as boxes: the app's hold
// a native input or select where the book's hold text, and the pixel
// comparison checks the text.
// Where the app names a part differently from the book, so that the book's
// short class names do not reach the rest of the app, the selector names
// both, and each page finds its own.
const ASSISTANTS_SETTINGS_PARTS = [
  ".bar",
  ".bar > .crumb",
  ".bar > .title",
  ".bar .btn",
  ".bar .btn > svg",
  ".set-nav",
  ".set-nav .side-h",
  ".set-nav .nav-row",
  ".set-nav .nav-row > svg",
  ".set-body",
  ".people, .assistant-tabs",
  ".person, .assistant-tab",
  ".person > svg, .assistant-tab > svg",
  ".rec-main, .assistant-record",
  ".head",
  ".head > svg",
  ".head > h2",
  ".set-sec",
  ".set-sec > h2",
  ".set-sec > h2 > svg",
  ".set-sec > h2 > .toggle",
  ".set-sec > p",
  ".set-row",
  ".set-label",
  ".set-label > b",
  ".set-label > span",
  ".set-row > .field",
  ".set-row > .field > svg",
  ".set-row > .btn",
  ".tools, .disallowed-tools",
  ".chip",
  ".chip svg",
  ".tools > .btn, .disallowed-tools > .btn",
  ".tools > .btn > svg, .disallowed-tools > .btn > svg",
  ".seg",
  ".seg > button",
  ".inline, .schedule-sentence",
  ".inline > .field, .schedule-sentence > .field",
  ".inline > .field > svg, .schedule-sentence > .field > svg",
  ".day, .heartbeat-day",
  ".day-now, .heartbeat-day-now",
  ".day-axis, .heartbeat-day-axis",
  ".day-axis > span, .heartbeat-day-axis > span",
  ".rec-side, .assistant-memory",
  ".side-sec, .memory-side-sec",
  ".side-sec > h3, .memory-side-sec > h3",
  ".side-sec > h3 > svg, .memory-side-sec > h3 > svg",
  ".side-sec > h3 > a, .memory-side-sec > h3 > a",
  ".core-top, .memory-core-top",
  ".side-sec > .meter, .memory-side-sec > .meter",
  ".side-sec > .meter > i, .memory-side-sec > .meter > i",
  ".core-note, .memory-core-note",
  ".topic, .memory-topic",
  ".topic > b, .memory-topic > b",
  ".topic > small, .memory-topic > small",
  ".topic > span, .memory-topic > span",
  ".topics-foot, .memory-topics-foot",
  ".side-sec > .btn, .memory-side-sec > .btn",
];

// Every part of Settings > Appearance whose box is compared, as a selector
// inside `main.main`: the header, the Settings list, and the section with
// its theme cards, its rows and the glass demo.
const APPEARANCE_SETTINGS_PARTS = [
  ".bar",
  ".bar > .crumb",
  ".bar > .title",
  // The app puts the header's actions in a slot of their own.
  ".bar .time",
  ".set-nav",
  ".set-nav .side-h",
  ".set-nav .nav-row",
  ".set-nav .nav-row > svg",
  ".set-body",
  ".set-sec",
  ".set-sec > h2",
  ".set-sec > p",
  ".themes",
  ".tp",
  ".tp-art",
  ".tp-side > i",
  ".tp-row",
  ".tp-row > svg",
  ".tp-line",
  ".tp-comp",
  ".tp-name",
  ".tp-name > b",
  ".tp-name > span",
  ".set-row",
  ".set-label",
  ".set-label > b",
  ".set-label > span",
  ".pair",
  ".pair > .field",
  ".pair > .field > svg",
  ".toggle",
  ".range",
  ".range-out",
  ".glass-demo",
  ".gd-page",
  ".gd-page > p",
  ".gd-page code",
  ".codeblock",
  ".gd-pill",
  ".gd-pill .ptab",
  ".gd-pill .ptab > svg",
  ".gd-comp",
];

// Every part of Settings > Permission profiles whose box is compared, as a
// selector inside `main.main`: the header, the Settings list, and the list
// of profiles or one profile's page. The app prefixes the classes it owns
// with `profile-`, so a part names the book's class, then the app's.
const PROFILES_SETTINGS_PARTS = [
  ".bar",
  ".bar > .crumb",
  ".bar > .crumb a",
  ".bar > .title",
  ".bar .btn",
  ".bar .btn > svg",
  ".set-nav",
  ".set-nav .side-h",
  ".set-nav .nav-row",
  ".set-nav .nav-row > svg",
  ".set-body",
  ".lead, .profile-lead",
  ".tbl-h, .profile-list-head",
  ".tbl-h > span, .profile-list-head > span",
  ".prof, .profile-row",
  ".prof > .mk, .profile-row > .profile-mark",
  ".prof > .mk > svg, .profile-row > .profile-mark > svg",
  ".prof .nm, .profile-row .profile-name",
  ".prof .nm > b, .profile-row .profile-name > b",
  ".prof .nm > span, .profile-row .profile-name > span",
  ".prof .held, .profile-row .profile-held",
  ".prof .meter, .profile-row .meter",
  ".prof .meter > i, .profile-row .meter > i",
  ".prof .used, .profile-row .profile-used",
  ".prof .used .stack, .profile-row .profile-used .profile-faces",
  ".prof .used .stack > svg, .profile-row .profile-used .profile-faces > svg",
  ".prof > .ic, .profile-row > svg",
  ".set-sec",
  ".set-sec > h2",
  ".set-sec > h2 > small",
  ".set-sec > p",
  ".note, .profile-note",
  ".set-row",
  ".set-label",
  ".set-label > b",
  ".set-label > span",
  ".set-row > .field",
  ".verbs, .profile-verbs",
  ".verbs > button, .profile-verbs > button",
  ".verbs > button > svg, .profile-verbs > button > svg",
  ".user, .profile-agent",
  ".user > svg, .profile-agent > svg",
  ".none, .profile-none",
  ".fixed, .profile-fixed",
  ".set-row > .btn",
];

// Every part of Settings > Connections whose box is compared, as a selector
// inside `main.main`: the header with its Add a Connection button, the
// Settings list, the strip of counts, and the table with its column heads
// and a row per Connection.
const CONNECTIONS_SETTINGS_PARTS = [
  ".bar",
  ".bar > .crumb",
  ".bar > .title",
  ".bar .btn",
  ".bar .btn > svg",
  ".set-nav",
  ".set-nav .side-h",
  ".set-nav .nav-row",
  ".set-nav .nav-row > svg",
  ".set-body",
  ".conn-stats",
  ".conn-stat",
  ".conn-stat > b",
  ".conn-stat > span",
  ".conn-stats-note",
  ".sec-top",
  ".sec-top > h2",
  ".sec-top > span",
  ".tbl-h",
  ".tbl-h > span",
  ".conn",
  ".conn > .mk",
  ".conn > .mk > svg",
  ".conn .nm",
  ".conn .nm > b",
  ".conn .nm > span",
  ".conn > .spark",
  ".conn > .spark > i",
  ".conn > .n",
  ".conn .health",
  ".conn .health > .dot",
  ".conn > .icon-btn",
  ".conn > .icon-btn > svg",
];

// Every part of Intake whose box is compared, as a selector inside
// `main.main`: the header and its tabs, the list with its section headings
// and rows, and the pane with its head, its blocks and its answers.
const INTAKE_PARTS = [
  ".bar .title",
  ".tabs .tab",
  ".asks-list",
  ".asks-sec",
  ".ask-row",
  ".ask-mark",
  ".ask-title",
  ".ask-sub",
  ".ask-age",
  ".asks-detail",
  ".ad-kind",
  ".ad-title",
  ".ad-asked",
  ".b-change",
  ".b-msg",
  ".ans",
  ".ans .btn",
  ".ans-desc",
  ".ad-keys",
];

// Every part of the Tracking pane whose box is compared, as a selector inside
// the pane's section, `.asks-detail`: the head, the trip with its messages,
// the output's rows, the runs and the answers. The drawing writes the trip's
// classes `rt-` where the app writes `tr-`, so each selector names both.
const TRACKING_PANE_PARTS = [
  ".rt-pane, .tr-pane",
  ".ad-kind",
  ".ad-kind .src",
  ".ad-kind .src > svg",
  ".ad-kind .btn",
  ".ad-title",
  ".ad-asked",
  ".rt-trip, .tr-trip",
  ".rt-msg, .tr-msg",
  ".rt-av, .tr-av",
  ".rt-msg-body, .tr-msg-body",
  ".rt-name, .tr-name",
  ".rt-name small, .tr-name small",
  ".rt-orig, .tr-orig",
  ".rt-orig-h, .tr-orig-h",
  ".rt-orig-src, .tr-orig-src",
  ".rt-orig-h > *, .tr-orig-h > *",
  ".rt-step-text > *, .tr-step-text > *",
  ".rt-step-text > * > *, .tr-step-text > * > *",
  ".rt-orig-q, .tr-orig-q",
  ".rt-text, .tr-text",
  ".rt-out-from, .tr-out-from",
  ".rt-out, .tr-out",
  ".rt-out > div, .tr-out > div",
  ".rt-out dt, .tr-out dt",
  ".rt-out dd, .tr-out dd",
  ".rt-more, .tr-more",
  ".rt-steps, .tr-steps",
  ".rt-steps li, .tr-steps li",
  ".rt-steps time, .tr-steps time",
  ".rt-step-text, .tr-step-text",
  ".rt-step-thread, .tr-step-thread",
  ".ad-answers",
  ".ledger",
  ".ans",
  ".ans .btn",
  ".ans-desc",
  ".ans > kbd",
  ".ad-keys",
  ".ad-keys > span",
];

// Every part of the workflow list's table whose box is compared, as a
// selector inside `main.main`: the header with its filters and search, the
// column heads, the group headings, and each row's cells.
const WORKFLOWS_PARTS = [
  ".top > .pill",
  ".pill-title",
  ".ptab",
  ".ptab > small",
  ".pill.find",
  ".find > svg",
  ".find > input",
  ".find > kbd",
  ".workflow-list",
  ".table-heads",
  ".table-heads > span",
  ".group-h",
  ".group-h > span",
  ".group-h > .count",
  ".table-row",
  ".table-mark",
  ".table-mark > svg",
  ".table-name",
  ".table-quiet",
  ".table-quiet > svg",
  ".strip",
  ".strip > *",
  ".col-success",
  ".status-text",
  ".table-num",
];

// Every part of the header and the list's column beside an open workflow,
// as a selector inside `main.main`. The app names the column's row parts
// after the column, where the book borrows the sidebar's row, so each of
// those selectors names both.
const WORKFLOW_COLUMN_PARTS = [
  ".top > .pill",
  ".list-btn",
  ".list-btn > svg",
  ".pill-back",
  ".pill-back > small",
  ".find--box",
  ".find > svg",
  ".find > input",
  ".find > kbd",
  ".workflow-list",
  ".group-h",
  ".group-h > span",
  ".group-h > .count",
  ".side-row, .column-row",
  ".side-lead, .column-mark",
  ".side-lead > svg, .column-mark > svg",
  ".side-name, .column-name",
  ".side-meta, .column-status",
  ".side-end, .column-time",
];

// Every part of the open workflow above its tab's panel, as a selector
// inside `main.main`: the lead with its switch and chips, the graph with its
// cards and edge labels, and the tab band. The scaled drawing's box carries
// the graph's zoom, and the pane's cut classes say on which side the graph
// fades out, which the capture does not draw (see `stillGraphPane`).
const OPEN_WORKFLOW_PARTS = [
  ".open-pane",
  ".open-name",
  ".open-name > h1",
  ".open-switch",
  ".open-switch > .toggle",
  ".open-gist",
  ".open-hint",
  ".chip-row",
  ".chip",
  ".chip > svg",
  ".graph",
  ".graph-pane",
  ".graph-pane.is-cut-left",
  ".graph-pane.is-cut-right",
  ".graph-room",
  ".graph-draw",
  ".node",
  ".node-lead",
  ".node-lead > svg",
  ".node-title",
  ".node-detail",
  ".edge-label",
  ".pill.zoom",
  ".zoom > *",
  ".tab-band",
  ".tab-bar",
  ".tab",
  ".tab > small",
  ".tab-tools",
  ".seg",
  ".seg > button",
];

// Every part of the Runs tab's list, as a selector inside `main.main`: its
// column heads and each run's cells.
const RUN_LIST_PARTS = [
  ".tbl-runs.table-heads",
  ".tbl-runs.table-heads > span",
  ".tbl-runs.table-row",
  ".tbl-runs > .table-mark",
  ".tbl-runs > .table-mark > svg",
  ".tbl-runs > .status-text",
  ".tbl-runs > .col-by",
  ".col-by > svg",
  ".col-by > .no-icon",
  ".tbl-runs > .table-num",
];

// Every part of the Runs tab's timeline of one day, as a selector inside
// `main.main`: the day stepper, the hour axis, and the lanes with their
// hour lines, the now line and a bar per run.
const RUN_TIMELINE_PARTS = [
  ".stepper",
  ".stepper > *",
  ".axis",
  ".axis-tick",
  ".axis-now",
  ".lanes",
  ".hour-line",
  ".now-line",
  ".run-bar",
  ".run-bar-cut",
  ".run-bar-line",
  ".run-bar > svg",
];

// Every part of a run's page above its steps, as a selector inside
// `main.main`: the crumbs with the run's mark and time, the button that
// cancels or re-runs it, the run's state and how long it took, the gist
// with its button, who started it, its inputs, and the tab band with the
// Graph and Timeline switch.
const RUN_LEAD_PARTS = [
  ".top > .pill",
  ".pill-crumb",
  ".ptab",
  ".ptab > svg",
  ".ptab > small",
  ".pill-btn",
  ".open-pane",
  ".open-name",
  ".run-state",
  ".run-state > svg",
  ".run-took",
  ".run-gist",
  ".run-gist > p",
  ".run-gist > .btn",
  ".chip-row",
  ".chip",
  ".chip > svg",
  ".run-inputs",
  ".run-inputs > div",
  ".run-inputs dt",
  ".run-inputs dd",
  ".run-note",
  ".tab-band",
  ".tab-bar",
  ".run-steps",
  ".run-steps > small",
  ".tab-tools",
  ".seg",
  ".seg > button",
];

// Every part of a run's graph, as a selector inside `main.main`: the graph
// of the open workflow, and on each node where the run is: its ring, its
// mark, and how many times the run came to it.
const RUN_GRAPH_PARTS = [
  ".graph",
  ".graph-pane",
  ".graph-pane.is-cut-left",
  ".graph-pane.is-cut-right",
  ".graph-room",
  ".graph-draw",
  ".node",
  ".node-ring",
  ".node-lead",
  ".node-lead > svg",
  ".node-title",
  ".node-times",
  ".node-detail",
  ".node-mark",
  ".node-mark > svg",
  ".edge-label",
  ".pill.zoom",
  ".zoom > *",
];

// Every part of a node's card on a run's graph, as a selector inside
// `main.main`: where the run is at the node, the facts of its latest visit,
// its prompt, each time the run came to it, and Open thread.
const RUN_CARD_PARTS = [
  ".node-pop",
  ".node-pop .pop-h",
  ".node-pop .pop-sec",
  ".node-status",
  ".node-status > svg",
  ".node-status small",
  ".node-facts > div",
  ".node-facts dt",
  ".node-facts dd",
  ".node-pop .q-h",
  ".node-prompt",
  ".node-pop .line",
  ".node-pop .line-note",
];

// Every part of a run's step timeline, as a selector inside `main.main`:
// the column heads with the time axis, and each step record's row with its
// mark, its name, its bar on the axis and how long it took.
const STEP_TIMELINE_PARTS = [
  ".tbl-steps.table-heads",
  ".tbl-steps.table-heads > span",
  ".axis-tick",
  ".axis-now",
  ".tbl-steps.table-row",
  ".tbl-steps > .table-mark",
  ".tbl-steps > .table-mark > svg",
  ".record-name",
  ".record-name > small",
  ".record-err",
  ".tbl-steps > .track",
  ".hour-line",
  ".now-line",
  ".run-bar",
  ".run-bar-line",
  ".run-bar > svg",
  ".track-note",
  ".tbl-steps > .table-num",
];

// The parts the Discussions and Wiki lists share, as selectors inside
// `main.main`: the group headings, a project's and a repository's.
const PROJECT_GROUP_PARTS = [
  ".group-h--proj",
  ".group-h--proj > span",
  ".group-h--repo",
  ".group-h--repo > span",
];

// Every part of the Discussions table, as a selector inside `main.main`: the
// header, the column heads, the group headings, and each row's cells.
const DISCUSSIONS_PARTS = [
  ".top > .pill",
  ".pill-title",
  ".workflow-list",
  ".table-heads",
  ".table-heads > span",
  ...PROJECT_GROUP_PARTS,
  ".table-row",
  ".table-row > .overlap-mark",
  ".overlap-mark > svg",
  ".table-name",
  ".table-num",
];

// Every part of a list's column beside an open Discussion or page, as a
// selector inside `main.main`: the header with its list button and back tab,
// the group headings, and each row. The app names the column's row parts
// after the column, where the book borrows the sidebar's row, so each of
// those selectors names both.
const LIST_COLUMN_PARTS = [
  ".top > .pill",
  ".list-btn",
  ".list-btn > svg",
  ".pill-back",
  ".workflow-list",
  ...PROJECT_GROUP_PARTS,
  ".side-row, .column-row",
  ".side-row > .side-lead, .column-row > .column-mark",
  ".side-text, .column-text",
  ".side-name, .column-name",
  ".side-meta, .column-meta",
  ".side-end, .column-time",
];

// Every part of the Discussions column, as a selector inside `main.main`: the
// list's parts, and the overlap mark on each overlap's row.
const DISCUSSIONS_COLUMN_PARTS = [...LIST_COLUMN_PARTS, ".overlap-mark", ".overlap-mark > svg"];

// Every part of the Wiki column, as a selector inside `main.main`: the list's
// parts, and the mark of who changed each page. A face or the user's avatar is
// an svg in the mark; the runs icon is the book's `.side-lead` inside the
// row's, and the app's `.actor-lead` inside the mark.
const WIKI_COLUMN_PARTS = [
  ...LIST_COLUMN_PARTS,
  ".side-row > .side-lead > svg, .column-row > .column-mark > svg",
  ".side-lead > .side-lead, .column-mark > .actor-lead",
  ".side-lead > .side-lead > svg, .column-mark > .actor-lead > svg",
];

// Every part of the open Discussion, as a selector inside `main.main`: the
// lead with its chips, the shared files with who edited each, and the Posts,
// the controller's with their code spans.
const OPEN_DISCUSSION_PARTS = [
  ".open-pane",
  ".open-pane > .pill-room",
  ".open-lead",
  ".open-name",
  ".open-name > h1",
  ".open-name > .overlap-mark",
  ".chip-row",
  ".chip",
  ".chip > svg",
  ".sec-h",
  ".sec-h > span",
  ".sec-h > .count",
  ".shared-files",
  ".tbl-files",
  ".table-path",
  ".tbl-files > .who",
  ".who > .faces",
  ".faces > svg",
  ".who > span:last-child",
  ".tbl-files > .table-num",
  ".posts",
  ".post-system",
  ".post-system > svg",
  ".post-system > span",
  ".post-system code",
  ".post-system time",
  ".msg",
  ".msg > svg",
  ".msg-body",
  ".msg-name",
  ".msg-name > a",
  ".msg-name > small",
  ".msg-body > p",
  ".msg-body p code",
  ".codeblock",
];

// Every part of the Wiki table, as a selector inside `main.main`: the header,
// the column heads, the group headings, and each row's cells, with the page's
// title and summary and who changed it.
const WIKI_PARTS = [
  ".top > .pill",
  ".pill-title",
  ".workflow-list",
  ".table-heads",
  ".table-heads > span",
  ...PROJECT_GROUP_PARTS,
  ".table-row",
  ".table-two",
  ".table-two > span",
  ".table-two > small",
  ".table-row > .who",
  ".who > svg",
  ".who > span",
  ".table-num",
];

// Every part of the open wiki page, as a selector inside `main.main`: the
// band of an older revision, the lead, the body, and the History with a row
// for each revision.
const OPEN_WIKI_PARTS = [
  ".open-pane",
  ".open-pane > .pill-room",
  ".old-rev",
  ".old-rev > svg",
  ".old-rev > span",
  ".old-rev > .btn",
  ".open-name",
  ".open-name > h1",
  ".open-gist",
  ".chip-row",
  ".chip",
  ".chip > svg",
  ".page-body",
  ".page-body > .msg-body",
  ".msg-body > h2",
  ".msg-body > p",
  ".msg-body > ol",
  ".msg-body li",
  ".msg-body > ul",
  ".msg-body :is(p, li) code",
  ".codeblock",
  ".history",
  ".history .sec-h",
  ".history .sec-h > span",
  ".rev",
  ".rev-n",
  ".rev > svg",
  ".rev > .side-lead, .rev > .actor-lead",
  ".rev-text",
  ".rev-who",
  ".rev-when",
  ".history-more",
];

/** Returns the pair that compares one view of the Discussions page or the Wiki page, `view` being the book's `?view=` and its other parameters. */
const buildListPair = (
  name: string,
  page: "discussions" | "wiki",
  parts: ReadonlyArray<string>,
  search?: Readonly<Record<string, string>>,
): RegionPair => ({
  name,
  bookPage: `crew-bureau-2/desktop/${page}.html`,
  referenceModule: `${page}-reference.ts`,
  specimenPage: `${page}.html`,
  ...(search === undefined ? {} : { search }),
  region: MAIN_PANE_REGION,
  scope: "main.main",
  parts,
  // The app draws only the rows near the window, where the book draws every row.
  itemsInWindowOnly: true,
});

/** Returns the pair that compares one view of a run's page, `view` being the book's `?state=` and its other parameters. */
const buildRunPair = (
  name: string,
  parts: ReadonlyArray<string>,
  view: { readonly state?: string; readonly search?: Readonly<Record<string, string>> } = {},
): RegionPair => ({
  name,
  bookPage: "crew-bureau-2/desktop/run.html",
  referenceModule: "run-reference.ts",
  specimenPage: "run.html",
  ...view,
  region: MAIN_PANE_REGION,
  scope: "main.main",
  parts,
});

/** Returns the pair that compares one state of Settings > Permission profiles, `view` being the book's `?state=` and whether the page is scrolled. */
const buildProfilesPair = (
  name: string,
  view: { readonly state?: string; readonly scrolled?: true } = {},
): RegionPair => ({
  name,
  bookPage: "crew-bureau-2/desktop/settings-profiles.html",
  referenceModule: "settings-profiles-reference.ts",
  specimenPage: "settings-profiles.html",
  ...view,
  region: MAIN_PANE_REGION,
  scope: "main.main",
  parts: PROFILES_SETTINGS_PARTS,
});

/** The regions of book pages compared with an app specimen, in the order they are compared. */
/**
 * The Tracking pane's region: the pane beside the list, under the header. The
 * list beside it differs from the drawing's in ways other tickets own, such as
 * the Request answered in its row, so only the pane is compared.
 */
const TRACKING_PANE_REGION: Rect = { x: 704, y: 52, width: WIDTH - 704, height: HEIGHT - 52 };

/** Returns the pair that compares the Tracking pane of the drawing's `?state=` with the app's scene of the same name. */
function buildTrackingPanePair(state: string): RegionPair {
  return {
    name: `tracking-pane-${state}`,
    bookPage: "tracking/index.html",
    referenceModule: "tracking-pane-reference.ts",
    specimenPage: "intake.html",
    state,
    // The drawing reads `?bar=off`, and the specimen `?scene=`; each ignores the other's.
    search: { bar: "off", scene: `tracking-pane-${state}` },
    region: TRACKING_PANE_REGION,
    scope: ".asks-detail",
    parts: TRACKING_PANE_PARTS,
  };
}

const REGION_PAIRS: ReadonlyArray<RegionPair> = [
  {
    name: "sidebar",
    bookPage: "crew-bureau-2/desktop/session-active.html",
    referenceModule: "sidebar-reference.ts",
    specimenPage: "sidebar.html",
    region: SIDEBAR_REGION,
    scope: "aside.side",
    parts: SIDEBAR_PARTS,
  },
  {
    name: "sidebar-rows",
    bookPage: "sidebar-directions/workbench-refined/desktop.html",
    referenceModule: "sidebar-rows-reference.ts",
    specimenPage: "sidebar-rows.html",
    state: "rows",
    region: SIDEBAR_REGION,
    scope: "aside.side",
    parts: SIDEBAR_ROWS_PARTS,
  },
  {
    name: "thread",
    bookPage: "crew-bureau-2/desktop/session-active.html",
    referenceModule: "thread-reference.ts",
    specimenPage: "thread.html",
    region: MAIN_PANE_REGION,
    scope: "main.main",
    parts: THREAD_PARTS,
  },
  {
    name: "scrolled-thread",
    bookPage: "crew-bureau-2/desktop/session-active.html",
    referenceModule: "thread-reference.ts",
    specimenPage: "thread.html",
    state: "scrolled",
    region: MAIN_PANE_REGION,
    scope: "main.main",
    parts: THREAD_PARTS,
  },
  {
    name: "draft",
    bookPage: "crew-bureau-2/desktop/session-empty.html",
    referenceModule: "draft-reference.ts",
    specimenPage: "draft.html",
    region: MAIN_PANE_REGION,
    scope: "main.main",
    parts: DRAFT_PARTS,
  },
  {
    name: "draft-first",
    bookPage: "crew-bureau-2/desktop/session-empty.html",
    referenceModule: "draft-reference.ts",
    specimenPage: "draft.html",
    state: "first",
    region: MAIN_PANE_REGION,
    scope: "main.main",
    parts: DRAFT_PARTS,
  },
  {
    name: "draft-first-no-repo",
    bookPage: "crew-bureau-2/desktop/session-empty.html",
    referenceModule: "draft-reference.ts",
    specimenPage: "draft.html",
    state: "first-no-repo",
    region: MAIN_PANE_REGION,
    scope: "main.main",
    parts: DRAFT_PARTS,
  },
  {
    name: "conversation",
    bookPage: "crew-bureau-2/desktop/assistant.html",
    referenceModule: "conversation-reference.ts",
    specimenPage: "conversation.html",
    region: CONVERSATION_REGION,
    scope: "main.main",
    parts: CONVERSATION_PARTS,
  },
  {
    name: "settings-assistants",
    bookPage: "crew-bureau-2/desktop/settings-assistants.html",
    referenceModule: "settings-assistants-reference.ts",
    specimenPage: "settings-assistants.html",
    region: MAIN_PANE_REGION,
    scope: "main.main",
    parts: ASSISTANTS_SETTINGS_PARTS,
  },
  {
    name: "scrolled-settings-assistants",
    bookPage: "crew-bureau-2/desktop/settings-assistants.html",
    referenceModule: "settings-assistants-reference.ts",
    specimenPage: "settings-assistants.html",
    state: "scrolled",
    region: MAIN_PANE_REGION,
    scope: "main.main",
    parts: ASSISTANTS_SETTINGS_PARTS,
  },
  {
    name: "settings-appearance",
    bookPage: "crew-bureau-2/desktop/settings-appearance.html",
    referenceModule: "settings-appearance-reference.ts",
    specimenPage: "settings-appearance.html",
    region: MAIN_PANE_REGION,
    scope: "main.main",
    parts: APPEARANCE_SETTINGS_PARTS,
  },
  buildProfilesPair("settings-profiles"),
  buildProfilesPair("settings-profiles-reviewer", { state: "reviewer" }),
  buildProfilesPair("scrolled-settings-profiles-reviewer", { state: "reviewer", scrolled: true }),
  buildProfilesPair("settings-profiles-shipped", { state: "shipped" }),
  buildProfilesPair("scrolled-settings-profiles-shipped", { state: "shipped", scrolled: true }),
  buildProfilesPair("settings-profiles-confirm", { state: "confirm" }),
  {
    name: "settings-connections",
    bookPage: "crew-bureau-2/desktop/settings-connections.html",
    referenceModule: "settings-connections-reference.ts",
    specimenPage: "settings-connections.html",
    region: MAIN_PANE_REGION,
    scope: "main.main",
    parts: CONNECTIONS_SETTINGS_PARTS,
  },
  {
    name: "intake",
    bookPage: "intake-directions/asks/desktop/intake.html",
    referenceModule: "intake-reference.ts",
    specimenPage: "intake.html",
    region: MAIN_PANE_REGION,
    scope: "main.main",
    parts: INTAKE_PARTS,
  },
  buildTrackingPanePair("finished"),
  buildTrackingPanePair("failed"),
  {
    name: "workflows",
    bookPage: "crew-bureau-2/desktop/workflows.html",
    referenceModule: "workflows-reference.ts",
    specimenPage: "workflows.html",
    region: MAIN_PANE_REGION,
    scope: "main.main",
    parts: WORKFLOWS_PARTS,
    itemsInWindowOnly: true,
  },
  {
    name: "workflows-split",
    bookPage: "crew-bureau-2/desktop/workflows.html",
    referenceModule: "workflows-reference.ts",
    specimenPage: "workflows.html",
    search: { view: "split" },
    region: MAIN_PANE_REGION,
    scope: "main.main",
    parts: [...WORKFLOW_COLUMN_PARTS, ...OPEN_WORKFLOW_PARTS, ...RUN_LIST_PARTS],
    itemsInWindowOnly: true,
  },
  {
    name: "workflows-full",
    bookPage: "crew-bureau-2/desktop/workflows.html",
    referenceModule: "workflows-reference.ts",
    specimenPage: "workflows.html",
    search: { view: "full" },
    region: MAIN_PANE_REGION,
    scope: "main.main",
    parts: [".top > .pill", ".list-btn", ".pill-back", ...OPEN_WORKFLOW_PARTS, ...RUN_LIST_PARTS],
    itemsInWindowOnly: true,
  },
  {
    name: "workflows-timeline",
    bookPage: "crew-bureau-2/desktop/workflows.html",
    referenceModule: "workflows-reference.ts",
    specimenPage: "workflows.html",
    search: { view: "full", runs: "timeline" },
    region: MAIN_PANE_REGION,
    scope: "main.main",
    parts: [
      ".top > .pill",
      ".list-btn",
      ".pill-back",
      ...OPEN_WORKFLOW_PARTS,
      ...RUN_TIMELINE_PARTS,
    ],
  },
  buildListPair("discussions", "discussions", DISCUSSIONS_PARTS),
  buildListPair(
    "discussions-split",
    "discussions",
    [...DISCUSSIONS_COLUMN_PARTS, ...OPEN_DISCUSSION_PARTS],
    { view: "split" },
  ),
  buildListPair(
    "discussions-full",
    "discussions",
    [".top > .pill", ".list-btn", ".pill-back", ...OPEN_DISCUSSION_PARTS],
    { view: "full" },
  ),
  buildListPair("wiki", "wiki", WIKI_PARTS),
  buildListPair("wiki-split", "wiki", [...WIKI_COLUMN_PARTS, ...OPEN_WIKI_PARTS], {
    view: "split",
  }),
  buildListPair(
    "wiki-full",
    "wiki",
    [".top > .pill", ".list-btn", ".pill-back", ...OPEN_WIKI_PARTS],
    {
      view: "full",
    },
  ),
  buildListPair("wiki-old-revision", "wiki", [...WIKI_COLUMN_PARTS, ...OPEN_WIKI_PARTS], {
    view: "split",
    rev: "4",
  }),
  buildRunPair("run", [...RUN_LEAD_PARTS, ...RUN_GRAPH_PARTS]),
  buildRunPair("run-card", [...RUN_LEAD_PARTS, ...RUN_GRAPH_PARTS, ...RUN_CARD_PARTS], {
    search: { card: "security" },
  }),
  buildRunPair("run-card-visits", [...RUN_LEAD_PARTS, ...RUN_GRAPH_PARTS, ...RUN_CARD_PARTS], {
    search: { card: "review" },
  }),
  buildRunPair("run-timeline", [...RUN_LEAD_PARTS, ...STEP_TIMELINE_PARTS], {
    state: "failed",
    search: { steps: "timeline" },
  }),
  buildRunPair("run-cancel", [...RUN_LEAD_PARTS, ...RUN_GRAPH_PARTS], {
    search: { dialog: "cancel" },
  }),
  buildRunPair("run-rerun", [...RUN_LEAD_PARTS, ...RUN_GRAPH_PARTS], {
    state: "failed",
    search: { dialog: "rerun" },
  }),
];

/**
 * Returns the script that reads a page's items: every visible element each
 * of `parts` finds inside `scope`, in document order, then `scope` itself.
 * An element that is not visible is left out:
 * - one that is not drawn, such as one in the book's hidden Hercule tab,
 *   which has no box;
 * - one inside an element with an opacity of 0, such as a fold of the
 *   book's shrunk composer, which keeps its box where the app's fold has
 *   none;
 * - when `inWindowOnly` is true, one whose box lies wholly outside the
 *   window.
 */
function buildReadItemsScript(
  scope: string,
  parts: ReadonlyArray<string>,
  inWindowOnly: boolean,
): string {
  return `(() => {
  const scope = document.querySelector(${JSON.stringify(scope)});
  const measure = (element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  };
  const isInWindow = (element) => {
    const { top, bottom, left, right } = element.getBoundingClientRect();
    return bottom > 0 && top < innerHeight && right > 0 && left < innerWidth;
  };
  const describe = (element) => element.textContent.replace(/\\s+/g, " ").trim().slice(0, 40);
  const items = ${JSON.stringify(parts)}.flatMap((selector) =>
    [...scope.querySelectorAll(selector)]
      .filter((element) => element.checkVisibility({ opacityProperty: true }))
      .filter((element) => !${String(inWindowOnly)} || isInWindow(element))
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
  const {
    name,
    bookPage,
    referenceModule,
    specimenPage,
    state,
    search,
    scrolled,
    region,
    scope,
    parts,
    itemsInWindowOnly = false,
  } = pair;
  const query = buildPageQuery({ theme, state, search, scrolled });
  const [reference, specimen] = await Promise.all([
    openSheet(
      new URL(`/design/${bookPage}${query}`, sheetsUrl).href,
      new URL(referenceModule, sheetsUrl).href,
    ),
    openSheet(`${sheetsUrl}${specimenPage}${query}`),
  ]);
  try {
    const readItems = buildReadItemsScript(scope, parts, itemsInWindowOnly);
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

/**
 * Returns the query string of a book page's address, such as
 * `?theme=orient-express&state=reviewer&scrolled=1`, or "" when no parameter
 * is given. The report leaves the theme out, because it names a page for
 * every theme.
 */
function buildPageQuery(page: {
  readonly theme?: string | undefined;
  readonly state?: string | undefined;
  readonly search?: Readonly<Record<string, string>> | undefined;
  readonly scrolled?: true | undefined;
}): string {
  const params = new URLSearchParams();
  if (page.theme !== undefined) params.set("theme", page.theme);
  if (page.state !== undefined) params.set("state", page.state);
  for (const [key, value] of Object.entries(page.search ?? {})) params.set(key, value);
  if (page.scrolled !== undefined) params.set("scrolled", "1");
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
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
  REGION_PAIRS.forEach(({ name, bookPage, state, search, scrolled, region }, index) => {
    const words = name.replaceAll("-", " ");
    lines.push(
      `${words.slice(0, 1).toUpperCase()}${words.slice(1)} comparison: ${String(first.regions[index]!.items)} items, ` +
        `x ${String(region.x)}-${String(region.x + region.width)} of ${bookPage}` +
        buildPageQuery({ state, search, scrolled }),
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
