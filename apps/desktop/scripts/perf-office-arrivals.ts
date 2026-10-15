/**
 * Measures what the Office's arrivals and departures cost, for spec 17 §What
 * every session in the Office costs:
 * `pnpm --filter @hercule/desktop perf:office-arrivals`. It takes about a
 * minute and does not run the scenarios of `perf:office`. See
 * scripts/office-arrivals-capture.ts for what it reads.
 */
import { runAndSetExitCode, runSheetCapture } from "./sheet-server.ts";

await runAndSetExitCode(() =>
  runSheetCapture(new URL("office-arrivals-capture.ts", import.meta.url)),
);
