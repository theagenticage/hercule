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
 * - `activity-unfolded`: the same page with the first folded entry unfolded.
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
  MAIN_PANE_REGION,
  openSheet,
  startCaptureApp,
} from "./sheet-window.ts";

const repositoryDir = fileURLToPath(new URL("../../../", import.meta.url));
const outputDir = fileURLToPath(new URL("../out/fleet/", import.meta.url));

/** A state of the specimen: the page's address after `fleet.html`, and what to do on the open page. */
interface State {
  readonly name: string;
  readonly query: string;
  /** A script that runs in the page once it is ready, and returns when the state is drawn. */
  readonly script?: string;
}

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
];

/** Opens `state` in `theme`, brings it about, and returns the window. The caller destroys it. */
async function openState(sheetsUrl: string, theme: string, state: State): Promise<BrowserWindow> {
  const window = await openSheet(`${sheetsUrl}fleet.html?theme=${theme}&${state.query}`);
  try {
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
        const { image } = await captureSheet(window, MAIN_PANE_REGION);
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
