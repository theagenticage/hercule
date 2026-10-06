/**
 * Electron's main process for scripts/capture-assistant.ts, which starts it
 * through scripts/sheet-server.ts.
 *
 * For each of the five themes, it opens one hidden
 * 1440 × 900 window at a time for each scene of the assistant states
 * specimen (specimens/assistant-states.tsx), and captures the part of the
 * window the scene names: the sidebar's region (x 0-272, the full height),
 * or the whole window. It writes each capture to
 * out/assistant/<theme>-<scene>.png. A sidebar scene whose thread list is
 * taller than the space the list has fails, because the capture would cut
 * off its end.
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
  ALL_THEMES,
  captureSheet,
  openSheet,
  SIDEBAR_REGION,
  startCaptureApp,
} from "./sheet-window.ts";

const repositoryDir = fileURLToPath(new URL("../../../", import.meta.url));
const outputDir = fileURLToPath(new URL("../out/assistant/", import.meta.url));

/** A scene as the specimen lists it: its name, and the part of the window its capture holds. */
interface SceneEntry {
  readonly name: string;
  readonly region: "sidebar" | "window";
}

/**
 * Checks that the sidebar's thread list in `window` shows all of its items.
 * Fails with how many pixels of the list are cut off otherwise.
 */
async function assertListFits(window: BrowserWindow, url: string): Promise<void> {
  const hidden = (await window.webContents.executeJavaScript(
    `(() => { const list = document.querySelector(".side-scroll"); return list.scrollHeight - list.clientHeight; })()`,
  )) as number;
  if (hidden > 0) {
    throw new Error(
      `The sidebar's list in ${url} is ${String(hidden)} px taller than the space it has, so the ` +
        "capture would cut off its end. Remove threads from specimens/assistant-states-fixture.ts.",
    );
  }
}

/**
 * Returns the scenes specimens/assistant-states-fixture.ts holds, read from
 * the first scene's page, so a scene added to the fixture is captured
 * without a change here.
 */
async function readScenes(sheetsUrl: string): Promise<ReadonlyArray<SceneEntry>> {
  const window = await openSheet(`${sheetsUrl}assistant-states.html?scene=1`);
  try {
    return JSON.parse(
      (await window.webContents.executeJavaScript(
        "document.documentElement.dataset.scenes",
      )) as string,
    ) as ReadonlyArray<SceneEntry>;
  } finally {
    window.destroy();
  }
}

startCaptureApp(async (sheetsUrl) => {
  mkdirSync(outputDir, { recursive: true });
  const files: string[] = [];
  const scenes = await readScenes(sheetsUrl);
  for (const theme of ALL_THEMES) {
    for (const [index, scene] of scenes.entries()) {
      const url = `${sheetsUrl}assistant-states.html?theme=${theme}&scene=${String(index + 1)}`;
      const window = await openSheet(url);
      try {
        if (scene.region === "sidebar") await assertListFits(window, url);
        const { image } = await captureSheet(
          window,
          scene.region === "sidebar" ? SIDEBAR_REGION : undefined,
        );
        const file = join(outputDir, `${theme}-${scene.name}.png`);
        writeFileSync(file, image.toPNG());
        files.push(relative(repositoryDir, file));
      } finally {
        window.destroy();
      }
    }
  }
  return {
    report: `Assistant states: ${String(files.length)} captures\n${files.join("\n")}\n`,
    passed: true,
  };
});
