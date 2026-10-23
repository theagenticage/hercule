/**
 * Electron's main process for scripts/capture-sidebar-states.ts, which starts
 * it through scripts/sheet-server.ts.
 *
 * For each theme, Whitehaven and Orient Express, it opens one hidden
 * 1440 × 900 window at a time and captures the sidebar's region (x 0-272,
 * the full height) of:
 * - each scene of the sidebar states specimen (specimens/sidebar-states.tsx),
 *   written to out/sidebar-states/<theme>-<scene>.png. A scene whose list is
 *   taller than the window fails, because the capture would cut off its end.
 *   A scene that shows a group's card also captures the card, beside the
 *   sidebar;
 * - each scene that has a thread row again, with the pointer on its last
 *   thread row that is not selected, so the row's Done or Reopen button
 *   shows, written to out/sidebar-states/<theme>-<scene>-hover.png;
 * - the Bureau book's session-active.html in its swarm state, the book's only
 *   drawing of "more" rows, written to out/sidebar-states/<theme>-book-swarm.png.
 *
 * Then it prints the files it wrote and exits with 0, or with 1 when
 * anything fails on the way.
 *
 * Electron loads this file as TypeScript by stripping its types, so it uses
 * only syntax that stripping can erase: no enums, namespaces or parameter
 * properties.
 */
import type { BrowserWindow } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureSheet,
  openSheet,
  SIDEBAR_REGION,
  startCaptureApp,
  THEMES,
} from "./sheet-window.ts";

/** The sidebar and the card beside it: the card sits 8px from the sidebar and is 312px wide. */
const SIDEBAR_AND_CARD_REGION = { ...SIDEBAR_REGION, width: SIDEBAR_REGION.width + 8 + 312 };

const repositoryDir = fileURLToPath(new URL("../../../", import.meta.url));
const outputDir = fileURLToPath(new URL("../out/sidebar-states/", import.meta.url));

/** A page to capture: the file name to write, the page's address, and the module it imports once loaded, if any. */
interface SidebarPage {
  readonly name: string;
  readonly url: string;
  readonly moduleUrl?: string;
  /** Whether the capture fails when the sidebar's list is taller than the window. */
  readonly mustFit: boolean;
  /** Whether the pointer rests on the last thread row that is not selected before the capture. */
  readonly hover: boolean;
}

/**
 * How long the capture waits after the pointer moves, in milliseconds: longer
 * than the rows' `--dur-1` crossfade, so the capture draws where it ends.
 */
const HOVER_SETTLE_MS = 400;

/**
 * Moves the pointer onto the centre of the last thread row in `window` that
 * is not selected, then waits for its crossfade to end. Returns `false`,
 * without moving the pointer, when the sidebar has no such row.
 */
async function hoverLastRow(window: BrowserWindow): Promise<boolean> {
  const centre = (await window.webContents.executeJavaScript(
    `(() => {
      const rows = [...document.querySelectorAll(".side-thread")].filter((row) => !row.querySelector(".is-on"));
      const row = rows.at(-1);
      if (row === undefined) return null;
      const { x, y, width, height } = row.getBoundingClientRect();
      return { x: Math.round(x + width / 2), y: Math.round(y + height / 2) };
    })()`,
  )) as { x: number; y: number } | null;
  if (centre === null) return false;
  window.webContents.sendInputEvent({ type: "mouseMove", ...centre });
  await new Promise((resolve) => setTimeout(resolve, HOVER_SETTLE_MS));
  return true;
}

/**
 * Checks that the sidebar's list in `window` shows all of its items. Fails
 * with how many pixels of the list are cut off otherwise.
 */
async function assertListFits(window: BrowserWindow, url: string): Promise<void> {
  const hidden = (await window.webContents.executeJavaScript(
    `(() => { const list = document.querySelector(".side-scroll"); return list.scrollHeight - list.clientHeight; })()`,
  )) as number;
  if (hidden > 0) {
    throw new Error(
      `The sidebar's list in ${url} is ${String(hidden)} px taller than the window, so the capture ` +
        "would cut off its end. Remove threads from the scene in specimens/sidebar-states-fixture.ts.",
    );
  }
}

/**
 * Returns how many scenes specimens/sidebar-states-fixture.ts holds, read
 * from the first scene's page, so a scene added to the fixture is captured
 * without a change here.
 */
async function readSceneCount(sheetsUrl: string): Promise<number> {
  const window = await openSheet(`${sheetsUrl}sidebar-states.html?scene=1`);
  try {
    return Number(
      await window.webContents.executeJavaScript("document.documentElement.dataset.sceneCount"),
    );
  } finally {
    window.destroy();
  }
}

/** Returns the pages to capture in `theme`: every scene, then the book's swarm state. */
function listPages(
  sheetsUrl: string,
  theme: string,
  sceneCount: number,
): ReadonlyArray<SidebarPage> {
  return [
    ...Array.from({ length: sceneCount }, (_, index) => index + 1).flatMap((scene) =>
      [false, true].map((hover) => ({
        name: `${theme}-${String(scene)}${hover ? "-hover" : ""}`,
        url: `${sheetsUrl}sidebar-states.html?theme=${theme}&scene=${String(scene)}`,
        mustFit: true,
        hover,
      })),
    ),
    {
      name: `${theme}-book-swarm`,
      url: new URL(
        `/design/crew-bureau-2/desktop/session-active.html?theme=${theme}&state=swarm`,
        sheetsUrl,
      ).href,
      moduleUrl: new URL("book-swarm.ts", sheetsUrl).href,
      mustFit: false,
      hover: false,
    },
  ];
}

startCaptureApp(async (sheetsUrl) => {
  mkdirSync(outputDir, { recursive: true });
  const files: string[] = [];
  const sceneCount = await readSceneCount(sheetsUrl);
  for (const theme of THEMES) {
    for (const page of listPages(sheetsUrl, theme, sceneCount)) {
      const window = await openSheet(page.url, page.moduleUrl);
      try {
        if (page.mustFit) await assertListFits(window, page.url);
        if (page.hover && !(await hoverLastRow(window))) continue;
        // The page marks a scene whose card shows (see `showGroupCard`).
        const cardShows = (await window.webContents.executeJavaScript(
          `document.documentElement.dataset.cardShown !== undefined`,
        )) as boolean;
        const { image } = await captureSheet(
          window,
          cardShows ? SIDEBAR_AND_CARD_REGION : SIDEBAR_REGION,
        );
        const file = join(outputDir, `${page.name}.png`);
        writeFileSync(file, image.toPNG());
        files.push(relative(repositoryDir, file));
      } finally {
        window.destroy();
      }
    }
  }
  return {
    report: `Sidebar states: ${String(files.length)} captures\n${files.join("\n")}\n`,
    passed: true,
  };
});
