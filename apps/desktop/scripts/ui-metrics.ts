/**
 * Measures the desktop UI and compares the numbers with the committed
 * baseline, and the screenshots with the committed goldens:
 * `pnpm --filter @hercule/desktop ui:metrics`. The metrics are those
 * of docs/research/ui-hill-climb.md, section 4.1, and are read from the
 * specimen pages that `capture:ui` captures: 21 screens in 6 themes, at 1x and
 * glass 40 % (scripts/ui-screens.ts). Each page loads once in one Playwright
 * Chromium, and its glass 0 %, its focus rings and its perturbations are
 * measured in place (scripts/ui-measure.ts). The registry of metrics and the
 * comparison are in scripts/ui-ratchet.ts.
 *
 * It deletes `apps/desktop/out/ui-metrics/` (git-ignored) and writes:
 * - `<theme>/<screen>.png`, the screenshot of each page;
 * - `golden-diff/<theme>/<screen>.png`, for each screenshot whose pixels differ
 *   from its golden: the differing pixels in magenta over the dimmed golden;
 * - `metrics.json`, every number of the run, keyed `<theme>/<screen>/<metric>`;
 * - `elements.json`, keyed the same way: the elements behind each number, worst
 *   first, each with its contribution. The report lists the first five under
 *   each worse number, so the cause is named and not only counted;
 * - `report.md`, the verdict, the targets, the goldens, and a table per theme.
 *
 * It prints the report and how long the run took. The exit code is 0 when no
 * number is worse than `apps/desktop/ui-metrics.baseline.json`, no key is
 * missing on either side, and every screenshot equals its golden in
 * `apps/desktop/ui-goldens/` pixel for pixel (scripts/ui-goldens.ts). It is 1
 * otherwise.
 *
 * When a number is worse, the way to accept it is to run with
 * `--write-baseline`, commit the file and give the reason in the pull request.
 * `--write-baseline` writes the baseline from this run. It still checks the
 * goldens, so the exit code is 1 when a golden differs. When a golden differs,
 * the way to accept it is `--write-goldens`: it records the screenshots as the
 * goldens, writing only those whose pixels changed, and prints which. Look at
 * every changed golden before committing it. `--write-goldens` does not skip
 * the check of the numbers, so when the numbers are worse too, pass both flags
 * in one run: `--write-goldens --write-baseline` records both and exits with 0.
 *
 * `--themes <theme,theme,...>` measures only those themes, so that CI can run
 * the themes in parallel shards (.github/workflows/ci.yml). A shard compares
 * only the baseline keys of its themes, plus the `run/...` keys when it holds
 * the first theme of ALL_THEMES (RUN_WIDE_THEME in scripts/ui-screens.ts),
 * which measures them. Likewise a shard compares only the goldens of its
 * themes, and checks `provenance.json`. Together the shards check every key
 * and every golden.
 *
 * `--screens <name,name,...>` measures only those screens (the names in
 * UI_SCREENS, scripts/ui-screens.ts), for use while coding. It combines with
 * `--themes`. The theme tokens and the `run/...` keys are measured on the first
 * screen only, so they are compared only when that screen is selected
 * (selectBaselineForRun in scripts/ui-ratchet.ts). The goldens compared are
 * those of the selected themes and screens.
 *
 * `--no-goldens` skips the pixel comparison. It is a diagnostic for running on
 * the host, where the pixels may differ from the linux/amd64 goldens, for
 * example `--screens inbox --no-goldens`. The report says the goldens were not
 * checked. A run with `--screens`, `--no-goldens` or both is never the check
 * before a pull request: that is the full run. On the host, the pixel-based
 * numbers (contrast, clipping) can differ from the linux/amd64 baseline, so a
 * difference there is a hint, and the full run in the container decides.
 *
 * A partial run (`--themes` or `--screens`) cannot write the baseline or the
 * goldens, because the files would drop the entries of what was not measured.
 * `--no-goldens` cannot be combined with either write flag. They need a full
 * run with the goldens checked.
 *
 * One exception to the type scale is measured, not hidden: the four "Aa" of
 * Settings > Appearance's Text size control are drawn at 12, 13, 14 and 15 px
 * on purpose, so their font sizes are left out of `type.sizes` and
 * `type.offScale`. Their contrast, targets and clipping count like any other
 * text. Each screen's `coverage.fixedSizeSamples` shows how many samples the
 * run exempted (4 on that screen, 0 on every other), and the run fails when
 * a page has another number (scripts/ui-measure.ts).
 *
 * A second exception covers the letters inside drawn pieces (faces, the user's
 * avatar, marks), which the Bureau book governs through `compare:bureau`:
 * their font sizes and weights are left out of `type.sizes`, `type.weights`
 * and `type.offScale`, and `coverage.pieceTextFragments` counts them per
 * screen. The probe fails when the selector of the piece roots matches an
 * element that is not an SVG piece (src/renderer/specimens/ui-probe.ts).
 *
 * Setup and the library path on a Linux machine without sudo are the same as
 * for `capture:ui` (scripts/capture-ui.ts).
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright";
import { exitCodeForSignal } from "./processes.ts";
import { runAndSetExitCode, startSpecimenServer, type SpecimenServer } from "./sheet-server.ts";
import { captureVariants, launchCaptureBrowser } from "./ui-capture.ts";
import {
  buildGoldenName,
  buildProvenance,
  checkGoldens,
  formatGoldensCheck,
  formatGoldensRecording,
  recordGoldens,
  type GoldensLocation,
} from "./ui-goldens.ts";
import { measurePage, METRICS_SCALE, type PageMeasurement } from "./ui-measure.ts";
import {
  checkTargets,
  compareWithBaseline,
  formatBaseline,
  formatReport,
  type MetricElements,
  parseBaseline,
  selectBaselineForRun,
} from "./ui-ratchet.ts";
import {
  GLASS_PERCENTS,
  listUiVariants,
  parseScreenList,
  parseThemeList,
  UI_SCREENS,
  type UiVariant,
} from "./ui-screens.ts";
import { ALL_THEMES } from "../src/renderer/specimens/sheet-themes.ts";

const outputDir = fileURLToPath(new URL("../out/ui-metrics/", import.meta.url));
const baselineFile = fileURLToPath(new URL("../ui-metrics.baseline.json", import.meta.url));
const goldensDir = fileURLToPath(new URL("../ui-goldens/", import.meta.url));

/** The flag that writes the baseline instead of comparing with it. */
const WRITE_BASELINE_FLAG = "--write-baseline";

/** The flag that records the screenshots as the goldens instead of comparing with them. */
const WRITE_GOLDENS_FLAG = "--write-goldens";

/** The option that measures only some themes, one shard of a CI run. */
const THEMES_OPTION = "--themes";

/** The option that measures only some screens, for use while coding. */
const SCREENS_OPTION = "--screens";

/** The flag that skips the pixel comparison with the goldens. */
const NO_GOLDENS_FLAG = "--no-goldens";

/** What to do when a number is worse, or a baseline is missing, in the words the run prints. */
const HOW_TO_ACCEPT =
  "To accept the numbers as they are, run `pnpm --filter @hercule/desktop ui:metrics --write-baseline`, " +
  "commit apps/desktop/ui-metrics.baseline.json, and give the reason in the pull request body. " +
  "If the goldens changed too, pass `--write-goldens --write-baseline` in the same run.";

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

/** Returns the elements of every measured page in one record, keyed like the metric values and sorted by key, because the pages finish in any order. */
function mergeElements(measurements: ReadonlyArray<PageMeasurement>): MetricElements {
  const entries = measurements.flatMap(({ elements }) => Object.entries(elements));
  return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Returns the line that says where the time went, summed over all pages (the pages run in parallel, so the sums are larger than the run's time). */
function describeTimings(measurements: ReadonlyArray<PageMeasurement>): string {
  const sum = (kind: keyof PageMeasurement["timings"]): string =>
    measurements.reduce((total, { timings }) => total + timings[kind], 0).toFixed(0);
  return `Page time, summed over ${String(measurements.length)} pages: contrast ${sum("contrast")} s, focus ${sum("focus")} s, resilience ${sum("resilience")} s, other ${sum("other")} s.`;
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

/** Returns the version of the Playwright package this program runs with. */
function readPlaywrightVersion(): string {
  const { version } = createRequire(import.meta.url)("playwright/package.json") as {
    version: string;
  };
  return version;
}

/**
 * Parses the command line. Returns whether to write the baseline, whether to
 * write the goldens, whether to skip the goldens, and the themes and screens
 * to measure (all of them without `--themes` and `--screens`). Fails on an
 * unknown argument, a bad theme or screen list, `--no-goldens` together with a
 * write flag, and a write flag together with `--themes` or `--screens`,
 * because files written from part of the run would drop the entries of the
 * rest.
 */
function parseArguments(args: ReadonlyArray<string>): {
  readonly shouldWriteBaseline: boolean;
  readonly shouldWriteGoldens: boolean;
  readonly shouldSkipGoldens: boolean;
  readonly themes: ReadonlyArray<string>;
  readonly screens: ReadonlyArray<string>;
} {
  const options = `The options are ${WRITE_BASELINE_FLAG}, ${WRITE_GOLDENS_FLAG}, ${NO_GOLDENS_FLAG}, ${THEMES_OPTION} <theme,theme,...> and ${SCREENS_OPTION} <name,name,...>.`;
  let shouldWriteBaseline = false;
  let shouldWriteGoldens = false;
  let shouldSkipGoldens = false;
  let themes: ReadonlyArray<string> = ALL_THEMES;
  let screens: ReadonlyArray<string> = UI_SCREENS.map((screen) => screen.name);
  let isPartial = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === WRITE_BASELINE_FLAG) {
      shouldWriteBaseline = true;
    } else if (arg === WRITE_GOLDENS_FLAG) {
      shouldWriteGoldens = true;
    } else if (arg === NO_GOLDENS_FLAG) {
      shouldSkipGoldens = true;
    } else if (arg === THEMES_OPTION) {
      const value = args[++index];
      if (value === undefined)
        throw new Error(`${THEMES_OPTION} needs a list of themes. ${options}`);
      themes = parseThemeList(value);
      isPartial = true;
    } else if (arg === SCREENS_OPTION) {
      const value = args[++index];
      if (value === undefined)
        throw new Error(`${SCREENS_OPTION} needs a list of screens. ${options}`);
      screens = parseScreenList(value);
      isPartial = true;
    } else {
      throw new Error(`Unknown argument ${String(arg)}. ${options}`);
    }
  }
  if (shouldSkipGoldens && (shouldWriteBaseline || shouldWriteGoldens)) {
    throw new Error(
      `${NO_GOLDENS_FLAG} cannot be combined with ${WRITE_BASELINE_FLAG} or ${WRITE_GOLDENS_FLAG}: it is a diagnostic mode on the host, and the files must be written from a full run that checks the goldens.`,
    );
  }
  if (shouldWriteBaseline && isPartial) {
    throw new Error(
      `${WRITE_BASELINE_FLAG} cannot be combined with ${THEMES_OPTION} or ${SCREENS_OPTION}: write the baseline from a full run, because a partial run would drop the keys of what it did not measure.`,
    );
  }
  if (shouldWriteGoldens && isPartial) {
    throw new Error(
      `${WRITE_GOLDENS_FLAG} cannot be combined with ${THEMES_OPTION} or ${SCREENS_OPTION}: write the goldens from a full run, because a partial run would delete the goldens of what it did not measure.`,
    );
  }
  return { shouldWriteBaseline, shouldWriteGoldens, shouldSkipGoldens, themes, screens };
}

/**
 * Runs the measurement. Returns 0 when the run passes, or writes the
 * baseline, and 1 when a number is worse, a key is missing, or a screenshot
 * differs from its golden. Fails with a message that names the variant when a
 * page cannot be measured.
 */
async function runUiMetrics(): Promise<number> {
  const { shouldWriteBaseline, shouldWriteGoldens, shouldSkipGoldens, themes, screens } =
    parseArguments(process.argv.slice(2));
  const selectedScreens = UI_SCREENS.filter((screen) => screens.includes(screen.name));

  const startedAt = performance.now();
  await rm(outputDir, { recursive: true, force: true });
  await Promise.all(themes.map((theme) => mkdir(join(outputDir, theme), { recursive: true })));

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
  let variants: UiVariant[];
  let chromiumVersion: string;
  try {
    server = await startSpecimenServer();
    browser = await launchCaptureBrowser();
    chromiumVersion = browser.version();
    // Only the default glass level is loaded: glass 0 % is measured on the same page.
    variants = listUiVariants(selectedScreens).filter(
      (variant) =>
        themes.includes(variant.theme) &&
        variant.scale === METRICS_SCALE &&
        variant.glassPercent === GLASS_PERCENTS[0],
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
  const elements = mergeElements(measurements);
  await writeFile(join(outputDir, "elements.json"), `${JSON.stringify(elements, null, 2)}\n`);

  const goldensLocation: GoldensLocation = {
    goldensDir,
    screenshotsDir: outputDir,
    diffDir: join(outputDir, "golden-diff"),
    unmeasuredThemes: ALL_THEMES.filter((theme) => !themes.includes(theme)),
    unmeasuredScreens: UI_SCREENS.map((screen) => screen.name).filter(
      (name) => !screens.includes(name),
    ),
    names: variants.map((variant) => buildGoldenName(variant.theme, variant.screen.name)),
  };
  const provenance = buildProvenance(chromiumVersion, readPlaywrightVersion());
  let goldensPassed = true;
  let goldensSection: string;
  if (shouldSkipGoldens) {
    goldensSection = `## Goldens: not checked\n\n${NO_GOLDENS_FLAG} skipped the pixel comparison. This run does not show whether the screenshots equal their goldens.\n`;
  } else if (shouldWriteGoldens) {
    goldensSection = formatGoldensRecording(await recordGoldens(goldensLocation, provenance));
  } else {
    const check = await checkGoldens(goldensLocation, provenance);
    goldensPassed = check.problems.length === 0;
    goldensSection = formatGoldensCheck(check);
  }

  const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
  const scope = screens.length === UI_SCREENS.length ? "" : ` on ${screens.join(", ")}`;
  const summary = `Measured ${themes.join(", ")}${scope}: ${String(measurements.length)} pages, ${String(Object.keys(current).length)} numbers, in ${seconds} s.\n${describeTimings(measurements)}\n`;

  if (shouldWriteBaseline) {
    await writeFile(baselineFile, metricsText);
    const report = `${formatReport(
      current,
      compareWithBaseline(current, parseBaseline(metricsText)),
      checkTargets(current),
      elements,
    )}\n${goldensSection}`;
    await writeFile(join(outputDir, "report.md"), report);
    process.stdout.write(`${report}\nWrote ${baselineFile}.\n${summary}`);
    return goldensPassed ? 0 : 1;
  }

  const baseline = await readBaselineFile();
  if (baseline === null) {
    process.stderr.write(
      `There is no baseline at ${baselineFile}. ${HOW_TO_ACCEPT}\nThe numbers of this run are in ${join(outputDir, "metrics.json")}.\n${goldensSection}${summary}`,
    );
    return 1;
  }
  // A full run compares the whole baseline, so a key that no run measures any
  // more is reported as missing rather than filtered away.
  const comparedBaseline = isFullRun(themes, screens)
    ? baseline
    : selectBaselineForRun(baseline, themes, screens);
  const ratchet = compareWithBaseline(current, comparedBaseline);
  const report = `${formatReport(current, ratchet, checkTargets(current), elements)}\n${goldensSection}`;
  await writeFile(join(outputDir, "report.md"), report);
  process.stdout.write(`${report}\n${summary}`);
  if (!ratchet.passed) {
    process.stderr.write(
      shouldWriteGoldens
        ? "The UI metrics got worse, or the keys changed, so the goldens were recorded but the baseline was not. " +
            "To record both in one run, pass `--write-goldens --write-baseline`; give the reason for the numbers in the pull request body.\n"
        : `The UI metrics got worse, or the keys changed. ${HOW_TO_ACCEPT}\n`,
    );
  }
  if (!goldensPassed) {
    process.stderr.write(
      "The screenshots differ from the goldens in apps/desktop/ui-goldens/. The Goldens section above names the screens; " +
        "the diff images are in apps/desktop/out/ui-metrics/golden-diff/.\n",
    );
  }
  if (!ratchet.passed || !goldensPassed) return 1;
  const notChecked = [
    ...(screens.length === UI_SCREENS.length ? [] : ["only some screens were measured"]),
    ...(shouldSkipGoldens ? ["the goldens were not checked"] : []),
  ];
  if (notChecked.length > 0) {
    process.stdout.write(
      `The numbers pass, but this was not the full check: ${notChecked.join(" and ")}. ` +
        "Run `pnpm --filter @hercule/desktop ui:metrics` without --screens and --no-goldens before a pull request.\n",
    );
  }
  if (ratchet.better.length > 0) {
    const howToKeep =
      notChecked.length > 0
        ? "A partial run cannot write the baseline. Write it from a full run (`pnpm --filter @hercule/desktop ui:metrics --write-baseline`, in the container with `ui:metrics:container` on a host that is not linux/amd64), and commit the file, so the gain cannot be lost. " +
          "Pixel-based numbers (contrast, clipping) can differ on this host, so treat these as a hint until the full run confirms them."
        : "Run `pnpm --filter @hercule/desktop ui:metrics --write-baseline` and commit the file, so the gain cannot be lost.";
    process.stdout.write(
      `${String(ratchet.better.length)} numbers are better than the baseline. ${howToKeep}\n`,
    );
  }
  return 0;
}

await runAndSetExitCode(runUiMetrics);

/** Returns whether `themes` is every theme and `screens` is every screen, which is a full run rather than a partial one. */
function isFullRun(themes: ReadonlyArray<string>, screens: ReadonlyArray<string>): boolean {
  return (
    ALL_THEMES.every((theme) => themes.includes(theme)) &&
    UI_SCREENS.every((screen) => screens.includes(screen.name))
  );
}
