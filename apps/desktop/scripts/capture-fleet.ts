/**
 * Captures the Fleet specimen's states that the goldens leave out, for a
 * check by eye: `pnpm --filter @hercule/desktop capture:fleet`. It compares
 * nothing.
 *
 * It serves the sheets and runs Electron with scripts/fleet-capture.ts as its
 * main file (see scripts/sheet-server.ts), which captures each state in all
 * six themes. Then it exits with Electron's exit code.
 *
 * It needs no build: the sheets are served from source.
 */
import { runAndSetExitCode, runSheetCapture } from "./sheet-server.ts";

await runAndSetExitCode(() => runSheetCapture(new URL("fleet-capture.ts", import.meta.url)));
