/**
 * Captures the Intake specimen for a check by eye:
 * `pnpm --filter @hercule/desktop capture:intake`. It compares nothing;
 * `pnpm compare:bureau` is the pixel comparison.
 *
 * It serves the sheets and runs Electron with scripts/intake-capture.ts as
 * its main file (see scripts/sheet-server.ts), which captures the main pane
 * of every scene of specimens/intake-fixture.ts in both themes. Then it
 * exits with Electron's exit code.
 *
 * It needs no build: the sheets are served from source.
 */
import { runAndSetExitCode, runSheetCapture } from "./sheet-server.ts";

await runAndSetExitCode(() => runSheetCapture(new URL("intake-capture.ts", import.meta.url)));
