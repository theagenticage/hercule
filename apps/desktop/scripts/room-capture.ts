/**
 * Electron's main process for scripts/capture-room.ts, which starts it
 * through scripts/sheet-server.ts.
 *
 * For each theme, Whitehaven and Orient Express, and each step of
 * specimens/room-steps.ts, it captures the whole 1440 × 900 window of:
 * - the room specimen (specimens/room.tsx), written to
 *   out/room/<theme>-<step>-app.png;
 * - the Bureau book's desktop/first-run.html in variant B at the same step,
 *   with only its room showing (specimens/room-book.ts), written to
 *   out/room/<theme>-<step>-book.png;
 * - the pixels that differ between the two, in magenta over the book's room
 *   in grey, written to out/room/<theme>-<step>-diff.png.
 *
 * Then it prints how many pixels differ in each pair and exits with 0. It
 * fails no comparison: the room is checked by eye, and `pnpm compare:bureau`
 * is the comparison that gates.
 *
 * Electron loads this file as TypeScript by stripping its types, so it uses
 * only syntax that stripping can erase: no enums, namespaces or parameter
 * properties.
 */
import { nativeImage } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDiffBitmap, compareBitmaps } from "./compare-bitmaps.ts";
import { captureSheet, openSheet, startCaptureApp, THEMES } from "./sheet-window.ts";
import { ROOM_STEP_NAMES } from "../src/renderer/specimens/room-steps.ts";

const repositoryDir = fileURLToPath(new URL("../../../", import.meta.url));
const outputDir = fileURLToPath(new URL("../out/room/", import.meta.url));

/** Opens `url`, captures the whole window and closes it. Returns the image and its raw pixels. */
async function capturePage(url: string, moduleUrl?: string) {
  const window = await openSheet(url, moduleUrl);
  try {
    return await captureSheet(window);
  } finally {
    window.destroy();
  }
}

startCaptureApp(async (sheetsUrl) => {
  mkdirSync(outputDir, { recursive: true });
  const lines: string[] = [];
  for (const theme of THEMES) {
    for (const step of ROOM_STEP_NAMES) {
      const app = await capturePage(`${sheetsUrl}room.html?theme=${theme}&step=${step.name}`);
      const book = await capturePage(
        new URL(
          `/design/crew-bureau-2/desktop/first-run.html?variant=b&theme=${theme}&step=${step.bookName}`,
          sheetsUrl,
        ).href,
        new URL("room-book.ts", sheetsUrl).href,
      );
      const name = join(outputDir, `${theme}-${step.name}`);
      writeFileSync(`${name}-app.png`, app.image.toPNG());
      writeFileSync(`${name}-book.png`, book.image.toPNG());
      const diff = buildDiffBitmap(book.bitmap, app.bitmap);
      const diffImage = nativeImage.createFromBitmap(Buffer.from(diff.pixels.buffer), {
        width: diff.width,
        height: diff.height,
      });
      writeFileSync(`${name}-diff.png`, diffImage.toPNG());
      const pixels = compareBitmaps(book.bitmap, app.bitmap, []).reduce(
        (sum, difference) => sum + difference.pixels,
        0,
      );
      lines.push(`${relative(repositoryDir, name)}: ${String(pixels)} device pixels differ`);
    }
  }
  return { report: `Room: ${String(lines.length)} pairs\n${lines.join("\n")}\n`, passed: true };
});
