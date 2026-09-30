/**
 * Compares the app's faces, icons and marks with the Bureau book's, pixel for
 * pixel, in both themes: `pnpm compare:bureau`. The book is the copy in
 * docs/design/crew-bureau, which is kept byte for byte as the design
 * prototype made it (spec 17).
 *
 * It also compares two regions of the book's session-active.html with the
 * app's: the sidebar, and the main pane with the thread screen.
 *
 * It runs in two processes. This script, on Node:
 * - checks that the book's tokens.css and font files are byte-identical to
 *   the app's copies, because a drift there would show as a flood of pixel
 *   differences with no clear cause;
 * - serves the sheets and runs Electron with scripts/bureau-capture.ts as its
 *   main file (see scripts/sheet-server.ts), which draws, captures and
 *   compares each pair of sheets and prints the report;
 * - exits with Electron's exit code.
 *
 * It needs no build: the sheets are served from source.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { designDir, runSheetCapture } from "./sheet-server.ts";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

/** The folder of the Bureau book the app is compared with. */
const bookDir = join(designDir, "crew-bureau");

/**
 * Checks that the app's tokens.css and font files are byte-identical to the
 * book's. Fails and names the first file that differs or is missing.
 */
function assertSharedFilesMatch(): void {
  const fonts = readdirSync(join(bookDir, "fonts")).filter((file) => file.endsWith(".woff2"));
  const shared = ["tokens.css", ...fonts.map((font) => `fonts/${font}`)];
  for (const file of shared) {
    const appFile = join(packageDir, "src/renderer/styles", file);
    const bookFile = join(bookDir, file);
    let appBytes: Buffer;
    try {
      appBytes = readFileSync(appFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new Error(
        `The app has no ${appFile}, which the Bureau book has as ${bookFile}. Copy the book's file unchanged.`,
        { cause: error },
      );
    }
    if (!appBytes.equals(readFileSync(bookFile))) {
      throw new Error(
        `${appFile} differs from the Bureau book's ${bookFile}. The app keeps the book's copy unchanged, ` +
          "so every pixel difference would have this one cause. Copy the book's file again.",
      );
    }
  }
}

let exitCode = 1;
try {
  assertSharedFilesMatch();
  exitCode = await runSheetCapture(new URL("bureau-capture.ts", import.meta.url));
} catch (error) {
  process.stderr.write(`FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
}
process.exitCode = exitCode;
