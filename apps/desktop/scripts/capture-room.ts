/**
 * Captures the Office as the first run furnishes it, beside the Bureau book's
 * first run, for a check by eye: `pnpm --filter @hercule/desktop capture:room`.
 * It fails no comparison; `pnpm compare:bureau` is the comparison that gates.
 *
 * It serves the sheets and runs Electron with scripts/room-capture.ts as its
 * main file (see scripts/sheet-server.ts), which writes each step's pair, and
 * the pixels that differ between them, to out/room/. Then it exits with
 * Electron's exit code.
 *
 * It needs no build: the sheets are served from source.
 */
import { runAndSetExitCode, runSheetCapture } from "./sheet-server.ts";

await runAndSetExitCode(() => runSheetCapture(new URL("room-capture.ts", import.meta.url)));
