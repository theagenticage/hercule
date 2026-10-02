/**
 * Captures each state of the app's first run beside the Bureau book's, for a
 * check by eye: `pnpm --filter @hercule/desktop capture:first-run`. It fails
 * no comparison; `pnpm compare:bureau` is the comparison that gates.
 *
 * It serves the sheets and runs Electron with scripts/first-run-capture.ts
 * as its main file (see scripts/sheet-server.ts), which writes each state's
 * pair, and the pixels that differ between them, to out/first-run/. Then it
 * exits with Electron's exit code.
 *
 * It needs no build: the sheets are served from source.
 */
import { runAndSetExitCode, runSheetCapture } from "./sheet-server.ts";

await runAndSetExitCode(() => runSheetCapture(new URL("first-run-capture.ts", import.meta.url)));
