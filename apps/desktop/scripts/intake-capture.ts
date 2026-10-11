/**
 * Electron's main process for scripts/capture-intake.ts, which starts it
 * through scripts/sheet-server.ts.
 *
 * For each theme, Whitehaven and Orient Express, it opens one hidden
 * 1440 × 900 window at a time and captures the main pane's region (x
 * 272-1440, the full height) of each scene of the Intake specimen
 * (specimens/intake.tsx), written to out/intake/<theme>-<scene>.png.
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

startCaptureApp(async (sheetsUrl) => {
  mkdirSync(outputDir, { recursive: true });
  const files: string[] = [];
  const scenes = await readSceneNames(sheetsUrl);
  for (const theme of THEMES) {
    for (const scene of scenes) {
      const window = await openSheet(`${sheetsUrl}intake.html?theme=${theme}&scene=${scene}`);
      try {
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
