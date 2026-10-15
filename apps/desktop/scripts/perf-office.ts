/**
 * Measures what the Office costs on fixture worlds of live runs and threads,
 * for spec 17 §What every session in the Office costs:
 * `pnpm --filter @hercule/desktop perf:office`. It needs no build and no
 * controller: the page draws the Office from a fixture world in the
 * repository's Electron. See scripts/office-perf-capture.ts for what it
 * reads, and specimens/office-perf.tsx for the worlds.
 *
 * It prints one row per world and fails no budget.
 */
import { runAndSetExitCode, runSheetCapture } from "./sheet-server.ts";

await runAndSetExitCode(() => runSheetCapture(new URL("office-perf-capture.ts", import.meta.url)));
