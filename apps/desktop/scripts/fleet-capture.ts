/**
 * Electron's main process for scripts/capture-fleet.ts, which starts it
 * through scripts/sheet-server.ts.
 *
 * For each of the six themes it opens one hidden 1440 × 900 window at a time
 * on the Fleet specimen (specimens/fleet.tsx), brings the state about, and
 * captures the main pane's region (x 272-1440, the full height), written to
 * out/fleet/<theme>-<state>.png. The states:
 *
 * - `machine-recent`: atlas's page scrolled to its Recent section;
 * - `activity`: atlas's Activity page, filter All;
 * - `activity-problems`: the same page under the Problems filter;
 * - `activity-unfolded`: the same page with the first folded entry unfolded;
 * - `software-detail`: the Fleet page scrolled to its Software section, with
 *   the first tool's detail open;
 * - `software-narrow`: the same section in a window of the smallest width, 800,
 *   with the grid scrolled sideways to its last machine.
 *
 * Then it prints the files it wrote and exits with 0, or with 1 when
 * anything fails on the way.
 *
 * Electron loads this file as TypeScript by stripping its types, so it uses
 * only syntax that stripping can erase: no enums, namespaces or parameter
 * properties.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserWindow } from "electron";
import {
  ALL_THEMES,
  captureSheet,
  HEIGHT,
  MAIN_PANE_REGION,
  openSheet,
  startCaptureApp,
  type Rect,
} from "./sheet-window.ts";

const repositoryDir = fileURLToPath(new URL("../../../", import.meta.url));
const outputDir = fileURLToPath(new URL("../out/fleet/", import.meta.url));

/** A state of the specimen: the page's address after `fleet.html`, and what to do on the open page. */
interface State {
  readonly name: string;
  readonly query: string;
  /** A script that runs in the page once it is ready, and returns when the state is drawn. */
  readonly script?: string;
  /** The window's content width in CSS pixels, when the state is drawn narrower than the default. */
  readonly windowWidth?: number;
}

/** The window's smallest width, 800, leaves the sidebar 280 px, so the main pane is the rest. */
const NARROW_WINDOW_WIDTH = 800;
const NARROW_SIDEBAR_WIDTH = 280;

/**
 * Resolves once the page has drawn two frames and a quarter of a second has
 * passed. A hidden window hands `capturePage` the last frame it presented,
 * and after a filter changes the list the frames alone left it a frame behind.
 */
const WAIT_FOR_FRAMES = `new Promise((resolve) =>
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 250))))`;

/** Presses the button with `label` inside the Activity page's filters, then waits for the list to redraw. */
const pressFilter = (label: string): string => `(async () => {
  const button = [...document.querySelectorAll(".machine-activity-filters button")]
    .find((each) => each.textContent === ${JSON.stringify(label)});
  if (button === undefined) throw new Error("The Activity page has no filter called ${label}.");
  button.click();
  await ${WAIT_FOR_FRAMES};
})()`;

/** Scrolls the Fleet page to its Software section, so that the section starts under the header. */
const SCROLL_TO_SOFTWARE = `document.getElementById("software").scrollIntoView({ block: "start" })`;

const STATES: ReadonlyArray<State> = [
  {
    name: "machine-recent",
    query: "machine=atlas",
    script: `(async () => {
      const section = document.getElementById("machine-recent");
      if (section === null) throw new Error("The machine's page has no Recent section.");
      section.scrollIntoView({ block: "start" });
      await ${WAIT_FOR_FRAMES};
    })()`,
  },
  { name: "activity", query: "machine=atlas&activity" },
  { name: "activity-problems", query: "machine=atlas&activity", script: pressFilter("Problems") },
  {
    name: "activity-unfolded",
    query: "machine=atlas&activity",
    script: `(async () => {
      const button = document.querySelector(".machine-activity-more");
      if (button === null) throw new Error("The Activity page has no folded entry.");
      button.click();
      await ${WAIT_FOR_FRAMES};
    })()`,
  },
  {
    name: "software-detail",
    query: "",
    script: `(async () => {
      const name = document.querySelector("#software .fleet-sw-name");
      if (name === null) throw new Error("The Software section has no tool to open.");
      name.click();
      ${SCROLL_TO_SOFTWARE};
      await ${WAIT_FOR_FRAMES};
    })()`,
  },
  {
    name: "software-narrow",
    query: "",
    windowWidth: NARROW_WINDOW_WIDTH,
    script: `(async () => {
      const scroll = document.querySelector("#software .fleet-sw-scroll");
      if (scroll === null) throw new Error("The Software section has no grid.");
      ${SCROLL_TO_SOFTWARE};
      scroll.scrollLeft = scroll.scrollWidth;
      await ${WAIT_FOR_FRAMES};
    })()`,
  },
];

/** Returns the main pane's region of a window `state` is drawn in. */
const decideRegion = (state: State): Rect =>
  state.windowWidth === undefined
    ? MAIN_PANE_REGION
    : {
        x: NARROW_SIDEBAR_WIDTH,
        y: 0,
        width: state.windowWidth - NARROW_SIDEBAR_WIDTH,
        height: HEIGHT,
      };

/** Opens `state` in `theme`, brings it about, and returns the window. The caller destroys it. */
async function openState(sheetsUrl: string, theme: string, state: State): Promise<BrowserWindow> {
  const window = await openSheet(`${sheetsUrl}fleet.html?theme=${theme}&${state.query}`);
  try {
    if (state.windowWidth !== undefined) {
      window.setContentSize(state.windowWidth, HEIGHT);
      // The page lays out again for the new width before the script reads it.
      await window.webContents.executeJavaScript(WAIT_FOR_FRAMES);
    }
    if (state.script !== undefined) await window.webContents.executeJavaScript(state.script);
    return window;
  } catch (error) {
    window.destroy();
    throw error;
  }
}

startCaptureApp(async (sheetsUrl) => {
  mkdirSync(outputDir, { recursive: true });
  const files: string[] = [];
  for (const theme of ALL_THEMES) {
    for (const state of STATES) {
      const window = await openState(sheetsUrl, theme, state);
      try {
        const { image } = await captureSheet(window, decideRegion(state));
        const file = join(outputDir, `${theme}-${state.name}.png`);
        writeFileSync(file, image.toPNG());
        files.push(relative(repositoryDir, file));
      } finally {
        window.destroy();
      }
    }
  }
  return {
    report: `Fleet: ${String(files.length)} captures\n${files.join("\n")}\n`,
    passed: true,
  };
});
