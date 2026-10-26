/**
 * Compares the app's faces, marks and icons with the Bureau book's, pixel for
 * pixel, in both themes: `pnpm compare:bureau`. The book is its second
 * edition, in docs/design/crew-bureau-2. The first edition stays beside it in
 * docs/design/crew-bureau, byte for byte as the design prototype made it
 * (spec 17), but the app follows the second.
 *
 * It compares only the sheet of pieces. The book is frozen as the record of
 * the second edition (ADR 0047), so the app's tokens and fonts may move away
 * from the book's, and the app's screens are compared with the app's own
 * goldens by `ui:metrics`. Both sheets draw on the book's tokens.css, so a
 * retuned theme does not fail this comparison.
 *
 * It runs in two processes. This script, on Node, serves the sheets and runs
 * Electron with scripts/bureau-capture.ts as its main file (see
 * scripts/sheet-server.ts), which draws, captures and compares the two
 * sheets and prints the report. The script exits with Electron's exit code.
 *
 * It needs no build: the sheets are served from source.
 */
import { runAndSetExitCode, runSheetCapture } from "./sheet-server.ts";

await runAndSetExitCode(() => runSheetCapture(new URL("bureau-capture.ts", import.meta.url)));
