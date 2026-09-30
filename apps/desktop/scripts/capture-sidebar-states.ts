/**
 * Captures the sidebar states specimen for a check by eye:
 * `pnpm --filter @hercule/desktop capture:sidebar-states`. It compares
 * nothing; `pnpm compare:bureau` is the pixel comparison.
 *
 * It serves the sheets and runs Electron with
 * scripts/sidebar-states-capture.ts as its main file (see
 * scripts/sheet-server.ts), which captures the sidebar of every scene of
 * specimens/sidebar-states-fixture.ts, and the book's swarm state, in both
 * themes. Then it exits with Electron's exit code.
 *
 * It needs no build: the sheets are served from source.
 */
import { runAndSetExitCode, runSheetCapture } from "./sheet-server.ts";

await runAndSetExitCode(() =>
  runSheetCapture(new URL("sidebar-states-capture.ts", import.meta.url)),
);
