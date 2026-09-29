/**
 * Electron's main process for scripts/capture-sidebar-states.ts, which starts
 * it through scripts/sheet-server.ts.
 *
 * For each theme, Whitehaven and Orient Express, it opens one hidden
 * 1440 × 900 window at a time and captures the sidebar's region (x 0-272,
 * the full height) of:
 * - each scene of the sidebar states specimen (specimens/sidebar-states.tsx),
 *   written to out/sidebar-states/<theme>-<scene>.png. A scene whose list is
 *   taller than the window fails, because the capture would cut off its end;
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

const repositoryDir = fileURLToPath(new URL("../../../", import.meta.url));
const outputDir = fileURLToPath(new URL("../out/sidebar-states/", import.meta.url));

/** A page to capture: the file name to write, the page's address, and the module it imports once loaded, if any. */
interface SidebarPage {
  readonly name: string;
  readonly url: string;
  readonly moduleUrl?: string;
  /** Whether the capture fails when the sidebar's list is taller than the window. */
  readonly mustFit: boolean;
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
    ...Array.from({ length: sceneCount }, (_, index) => index + 1).map((scene) => ({
      name: `${theme}-${String(scene)}`,
      url: `${sheetsUrl}sidebar-states.html?theme=${theme}&scene=${String(scene)}`,
      mustFit: true,
    })),
    {
      name: `${theme}-book-swarm`,
      url: new URL(
        `/design/crew-bureau/desktop/session-active.html?theme=${theme}&state=swarm`,
        sheetsUrl,
      ).href,
      moduleUrl: new URL("book-swarm.ts", sheetsUrl).href,
      mustFit: false,
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
        const { image } = await captureSheet(window, SIDEBAR_REGION);
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
