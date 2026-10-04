/**
 * Electron's main process for scripts/capture-first-run.ts, which starts it
 * through scripts/sheet-server.ts.
 *
 * For each theme, Whitehaven and Orient Express, and each state of
 * specimens/first-run-states.ts, it captures the whole 1440 × 900 window of:
 * - the first-run specimen (specimens/first-run.tsx) in that state, written
 *   to out/first-run/<step>-<state>-<theme>-app.png;
 * - the Bureau book's desktop/first-run.html in variant B, in the state the
 *   entry names, held still (specimens/first-run-book.ts), written to
 *   out/first-run/<step>-<state>-<theme>-book.png;
 * - the pixels that differ between the two, in magenta over the book in
 *   grey, written to out/first-run/<step>-<state>-<theme>-diff.png.
 *
 * A state the book does not draw gets only its app capture. Then it prints
 * how many pixels differ in each pair and exits with 0. It fails no
 * comparison: the first run is checked by eye, and `pnpm compare:bureau` is
 * the comparison that gates.
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
import { FIRST_RUN_STATES } from "../src/renderer/specimens/first-run-states.ts";

const repositoryDir = fileURLToPath(new URL("../../../", import.meta.url));
const outputDir = fileURLToPath(new URL("../out/first-run/", import.meta.url));

// The book shows the user's timezone as Europe/Amsterdam, and the account
// step offers the system's. scripts/sheet-server.ts starts Electron in UTC,
// and each window's renderer process reads the zone from the environment it
// inherits from this process when the window opens.
process.env["TZ"] = "Europe/Amsterdam";

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
    for (const entry of FIRST_RUN_STATES) {
      const name = join(outputDir, `${entry.step}-${entry.state}-${theme}`);
      const app = await capturePage(
        `${sheetsUrl}first-run.html?theme=${theme}&step=${entry.step}&state=${entry.state}`,
      );
      writeFileSync(`${name}-app.png`, app.image.toPNG());
      const { book: bookState } = entry;
      if (bookState === null) {
        lines.push(`${relative(repositoryDir, name)}: not in the book`);
        continue;
      }
      const query = "query" in bookState ? `&${bookState.query}` : "";
      const book = await capturePage(
        new URL(
          `/design/crew-bureau-2/desktop/first-run.html?variant=b&theme=${theme}&step=${bookState.step}&state=${bookState.state}${query}`,
          sheetsUrl,
        ).href,
        new URL("first-run-book.ts", sheetsUrl).href,
      );
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
  return {
    report: `First run: ${String(lines.length)} states\n${lines.join("\n")}\n`,
    passed: true,
  };
});
