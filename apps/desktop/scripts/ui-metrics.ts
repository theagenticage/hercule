/**
 * Measures the desktop UI and compares the numbers with the committed
 * baseline: `pnpm --filter @hercule/desktop ui:metrics`. The metrics are those
 * of docs/research/ui-hill-climb.md, section 4.1, and are read from the
 * specimen pages that `capture:ui` captures: 12 screens in 5 themes, at 1x and
 * glass 40 % (scripts/ui-screens.ts). Each page loads once in one Playwright
 * Chromium, and its glass 0 %, its focus rings and its perturbations are
 * measured in place (scripts/ui-measure.ts). The registry of metrics and the
 * comparison are in scripts/ui-ratchet.ts.
 *
 * It deletes `apps/desktop/out/ui-metrics/` (git-ignored) and writes:
 * - `<theme>/<screen>.png`, the golden screenshot of each page;
 * - `metrics.json`, every number of the run, keyed `<theme>/<screen>/<metric>`;
 * - `report.md`, the verdict, the targets, and a table per theme.
 *
 * It prints the report and how long the run took. The exit code is 0 when no
 * number is worse than `apps/desktop/ui-metrics.baseline.json` and no key is
 * missing on either side, and 1 otherwise. When a number is worse, the way to
 * accept it is to run it with `--write-baseline`, commit the file and give the
 * reason in the pull request. `--write-baseline` writes the baseline from this
 * run and exits with 0. There is no other way to skip the check.
 *
 * Setup and the library path on a Linux machine without sudo are the same as
 * for `capture:ui` (scripts/capture-ui.ts).
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright";
import { exitCodeForSignal } from "./processes.ts";
import { runAndSetExitCode, startSpecimenServer, type SpecimenServer } from "./sheet-server.ts";
import { captureVariants, launchCaptureBrowser } from "./ui-capture.ts";
import { measurePage, METRICS_SCALE, type PageMeasurement } from "./ui-measure.ts";
import {
  checkTargets,
  compareWithBaseline,
  formatBaseline,
  formatReport,
  parseBaseline,
} from "./ui-ratchet.ts";
import { GLASS_PERCENTS, listUiVariants } from "./ui-screens.ts";
import { ALL_THEMES } from "../src/renderer/specimens/sheet-themes.ts";

const outputDir = fileURLToPath(new URL("../out/ui-metrics/", import.meta.url));
const baselineFile = fileURLToPath(new URL("../ui-metrics.baseline.json", import.meta.url));

/** The flag that writes the baseline instead of comparing with it. */
const WRITE_BASELINE_FLAG = "--write-baseline";

/** What to do when a number is worse, or a baseline is missing, in the words the run prints. */
const HOW_TO_ACCEPT =
  "To accept the numbers as they are, run `pnpm --filter @hercule/desktop ui:metrics --write-baseline`, " +
  "commit apps/desktop/ui-metrics.baseline.json, and give the reason in the pull request body.";

/**
 * Returns the metric values of every measured page in one record. Fails when
 * two pages measured the same key, which would mean one overwrote the other.
 */
function mergeMeasurements(measurements: ReadonlyArray<PageMeasurement>): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const { values } of measurements) {
    for (const [key, value] of Object.entries(values)) {
      if (key in merged) throw new Error(`Two pages measured the metric key "${key}".`);
      merged[key] = value;
    }
  }
  return merged;
}

/** Returns the line that says where the time went, summed over all pages (the pages run in parallel, so the sums are larger than the run's time). */
function describeTimings(measurements: ReadonlyArray<PageMeasurement>): string {
  const sum = (kind: "contrast" | "focus" | "other"): string =>
    measurements.reduce((total, { timings }) => total + timings[kind], 0).toFixed(0);
  return `Page time, summed over ${String(measurements.length)} pages: contrast ${sum("contrast")} s, focus ${sum("focus")} s, other ${sum("other")} s.`;
}

/** Reads the baseline file. Returns null when it does not exist. Fails when it exists and is not a valid baseline. */
async function readBaselineFile(): Promise<Record<string, number> | null> {
  try {
    return parseBaseline(await readFile(baselineFile, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Runs the measurement. Returns 0 when the run passes, or writes the
 * baseline, and 1 when a number is worse or a key is missing. Fails with a
 * message that names the variant when a page cannot be measured.
 */
async function runUiMetrics(): Promise<number> {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== WRITE_BASELINE_FLAG);
  if (unknown.length > 0) {
    throw new Error(
      `Unknown argument ${unknown.join(", ")}. The only option is ${WRITE_BASELINE_FLAG}.`,
    );
  }
  const shouldWriteBaseline = args.includes(WRITE_BASELINE_FLAG);

  const startedAt = performance.now();
  await rm(outputDir, { recursive: true, force: true });
  await Promise.all(ALL_THEMES.map((theme) => mkdir(join(outputDir, theme), { recursive: true })));

  let server: SpecimenServer | undefined;
  let browser: Browser | undefined;
  const closeAll = async (): Promise<void> => {
    await browser?.close();
    await server?.close();
  };
  const exitOnSignal = (signal: NodeJS.Signals): void => {
    // Exits even when closing fails: the user asked to stop.
    void closeAll()
      .catch(() => undefined)
      .finally(() => process.exit(exitCodeForSignal(signal)));
  };
  process.once("SIGINT", exitOnSignal);
  process.once("SIGTERM", exitOnSignal);
  let measurements: PageMeasurement[];
  try {
    server = await startSpecimenServer();
    browser = await launchCaptureBrowser();
    // Only the default glass level is loaded: glass 0 % is measured on the same page.
    const variants = listUiVariants().filter(
      (variant) => variant.scale === METRICS_SCALE && variant.glassPercent === GLASS_PERCENTS[0],
    );
    measurements = await captureVariants(browser, server.specimensUrl, variants, (page, variant) =>
      measurePage(page, variant, outputDir),
    );
  } finally {
    process.off("SIGINT", exitOnSignal);
    process.off("SIGTERM", exitOnSignal);
    await closeAll();
  }

  const current = mergeMeasurements(measurements);
  const metricsText = formatBaseline(current);
  await writeFile(join(outputDir, "metrics.json"), metricsText);
  const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
  const summary = `Measured ${String(measurements.length)} pages, ${String(Object.keys(current).length)} numbers, in ${seconds} s.\n${describeTimings(measurements)}\n`;

  if (shouldWriteBaseline) {
    await writeFile(baselineFile, metricsText);
    const report = formatReport(
      current,
      compareWithBaseline(current, parseBaseline(metricsText)),
      checkTargets(current),
    );
    await writeFile(join(outputDir, "report.md"), report);
    process.stdout.write(`${report}\nWrote ${baselineFile}.\n${summary}`);
    return 0;
  }

  const baseline = await readBaselineFile();
  if (baseline === null) {
    process.stderr.write(
      `There is no baseline at ${baselineFile}. ${HOW_TO_ACCEPT}\nThe numbers of this run are in ${join(outputDir, "metrics.json")}.\n${summary}`,
    );
    return 1;
  }
  const ratchet = compareWithBaseline(current, baseline);
  const report = formatReport(current, ratchet, checkTargets(current));
  await writeFile(join(outputDir, "report.md"), report);
  process.stdout.write(`${report}\n${summary}`);
  if (!ratchet.passed) {
    process.stderr.write(`The UI metrics got worse, or the keys changed. ${HOW_TO_ACCEPT}\n`);
    return 1;
  }
  if (ratchet.better.length > 0) {
    process.stdout.write(
      `${String(ratchet.better.length)} numbers are better than the baseline. Run \`pnpm --filter @hercule/desktop ui:metrics --write-baseline\` and commit the file, so the gain cannot be lost.\n`,
    );
  }
  return 0;
}

await runAndSetExitCode(runUiMetrics);
