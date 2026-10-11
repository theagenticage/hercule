/**
 * Electron's main process for scripts/capture-intake.ts, which starts it
 * through scripts/sheet-server.ts.
 *
 * For each theme, Whitehaven and Orient Express, it opens one hidden
 * 1440 × 900 window at a time and captures the main pane's region (x
 * 272-1440, the full height) of each scene of the Intake specimen
 * (specimens/intake.tsx), written to out/intake/<theme>-<scene>.png. A
 * scene that names an element in `data-hover` is captured with the pointer
 * on that element.
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
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { BrowserWindow } from "electron";
import {
  captureSheet,
  MAIN_PANE_REGION,
  openSheet,
  startCaptureApp,
  THEMES,
} from "./sheet-window.ts";

const repositoryDir = fileURLToPath(new URL("../../../", import.meta.url));
const outputDir = fileURLToPath(new URL("../out/intake/", import.meta.url));

/**
 * Returns the names of the scenes specimens/intake-fixture.ts holds, read
 * from the first scene's page, so a scene added to the fixture is captured
 * without a change here.
 */
async function readSceneNames(sheetsUrl: string): Promise<ReadonlyArray<string>> {
  const window = await openSheet(`${sheetsUrl}intake.html`);
  try {
    const names = (await window.webContents.executeJavaScript(
      "document.documentElement.dataset.scenes",
    )) as string;
    return names.split(" ");
  } finally {
    window.destroy();
  }
}

/**
 * Moves the pointer onto the middle of the element the page names in
 * `data-hover`, if it names one, and waits for the hover's transitions to
 * end. Fails when the page names an element it does not hold.
 */
async function hoverNamedElement(window: BrowserWindow): Promise<void> {
  const point = (await window.webContents.executeJavaScript(`(() => {
    const selector = document.documentElement.dataset.hover;
    if (selector === undefined) return null;
    const element = document.querySelector(selector);
    if (element === null) return "missing";
    const box = element.getBoundingClientRect();
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  })()`)) as { x: number; y: number } | "missing" | null;
  if (point === null) return;
  if (point === "missing")
    throw new Error("The scene names an element to hover that it does not draw.");
  window.webContents.sendInputEvent({ type: "mouseMove", ...point });
  // Longer than the rows' hover transition, `--dur-1`.
  await wait(400);
}

startCaptureApp(async (sheetsUrl) => {
  mkdirSync(outputDir, { recursive: true });
  const files: string[] = [];
  const scenes = await readSceneNames(sheetsUrl);
  for (const theme of THEMES) {
    for (const scene of scenes) {
      const window = await openSheet(`${sheetsUrl}intake.html?theme=${theme}&scene=${scene}`);
      try {
        await hoverNamedElement(window);
        const { image } = await captureSheet(window, MAIN_PANE_REGION);
        const file = join(outputDir, `${theme}-${scene}.png`);
        writeFileSync(file, image.toPNG());
        files.push(relative(repositoryDir, file));
      } finally {
        window.destroy();
      }
    }
  }
  return {
    report: `Intake: ${String(files.length)} captures\n${files.join("\n")}\n`,
    passed: true,
  };
});
