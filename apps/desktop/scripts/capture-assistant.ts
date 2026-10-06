/**
 * Captures the assistant states specimen for a check by eye:
 * `pnpm --filter @hercule/desktop capture:assistant`. It compares nothing.
 *
 * It serves the sheets and runs Electron with scripts/assistant-capture.ts
 * as its main file (see scripts/sheet-server.ts), which captures every scene
 * of specimens/assistant-states-fixture.ts in all five themes. Then it exits
 * with Electron's exit code.
 *
 * It needs no build: the sheets are served from source.
 */
import { runAndSetExitCode, runSheetCapture } from "./sheet-server.ts";

await runAndSetExitCode(() => runSheetCapture(new URL("assistant-capture.ts", import.meta.url)));
