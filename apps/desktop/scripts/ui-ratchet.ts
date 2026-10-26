import { UI_SCREENS, RUN_WIDE_THEME, isDarkTheme } from "./ui-screens.ts";
import { ALL_THEMES } from "../src/renderer/specimens/sheet-themes.ts";

/**
 * The UI metrics registry and the ratchet (docs/research/ui-hill-climb.md,
 * section 4.1). `pnpm ui:metrics` produces one flat record of numbers. This
 * file knows what each number means, which way is better, what the target is,
 * and how a run is compared with the committed baseline: a number that got
 * worse fails the run, so the metrics only move one way.
 *
 * A key in the record is one of:
 * - `<theme>/<screen>/<metric>` for a metric of one screen
 * - `<theme>/<screen>/<metric>@glass0` for a contrast metric measured with the
 *   window's glass at 0 %
 * - `<theme>/tokens/<metric>` for a metric of the theme's tokens
 * - `run/<metric>` for a metric of the whole run
 */

/** What one metric means and how it is judged. */
export interface MetricDefinition {
  /** A short description in plain English, for reports. */
  readonly label: string;
  /** Which way is better. */
  readonly direction: "higher" | "lower";
  /** How far a value may move in the wrong direction before it counts as worse. */
  readonly tolerance: number;
  /** Whether a worse value fails the ratchet. A metric that is not ratcheted is only reported. */
  readonly ratchet: boolean;
  /** Returns whether `value` meets the target. `dark` is whether the theme is a dark one. */
  readonly target: (value: number, context: { readonly dark: boolean }) => boolean;
  /**
   * For a metric where higher is better: returns the highest value the ratchet
   * tells apart. Both the baseline and the run are cut to it before they are
   * compared, so a value above it may fall to it without being worse. Without
   * this function, every value counts.
   */
  readonly ratchetCap?: (context: { readonly dark: boolean }) => number;
}

/** Two values closer than this are equal: it absorbs floating point noise at a tolerance boundary. */
const EPSILON = 1e-9;

/** Builds a ratcheted metric whose values must not fall and that has a minimum target. */
function higher(label: string, tolerance: number, minimum: number): MetricDefinition {
  return {
    label,
    direction: "higher",
    tolerance,
    ratchet: true,
    target: (value) => value >= minimum,
  };
}

/** Builds a ratcheted metric whose values must not rise and that has a maximum target. */
function lower(label: string, tolerance: number, maximum: number): MetricDefinition {
  return {
    label,
    direction: "lower",
    tolerance,
    ratchet: true,
    target: (value) => value <= maximum,
  };
}

/** Builds a ratcheted count of offenders: it must not rise and its target is none. */
function none(label: string): MetricDefinition {
  return lower(label, 0, 0);
}

/**
 * Builds a metric that is only reported. It never fails the ratchet and has
 * no target, because it describes what was measured (the measurement is bound
 * to the viewport, so a legitimate change can move it) and not how good it is.
 */
function reported(label: string, direction: "higher" | "lower"): MetricDefinition {
  return { label, direction, tolerance: 0, ratchet: false, target: () => true };
}

/** The Lc tolerance: finer than the 4 decimals the baseline stores. */
const LC_TOLERANCE = 0.05;

/** The least Lc ink needs. In a dark theme the best ink lies between this and `contrast.ink.aboveCeiling`'s Lc 95. */
const INK_MINIMUM_LC = 85;

/** Every metric, keyed by its name: the last segment of its key, without `@glass0`. */
export const METRICS: Readonly<Record<string, MetricDefinition>> = {
  "contrast.ink.minLc": {
    ...higher("Lowest ink contrast (Lc)", LC_TOLERANCE, INK_MINIMUM_LC),
    // In a dark theme, ink brighter than the band glares, and lowering it into
    // the band is the aim. `contrast.ink.aboveCeiling` guards the top, so the
    // ratchet here only guards the floor.
    ratchetCap: ({ dark }) => (dark ? INK_MINIMUM_LC : Infinity),
  },
  "contrast.ink.aboveCeiling": {
    label: "Ink text above Lc 95",
    direction: "lower",
    tolerance: 0,
    ratchet: true,
    // The ceiling only applies in a dark theme, where bright ink glares.
    target: (value, { dark }) => !dark || value === 0,
  },
  "contrast.muted.minLc": higher("Lowest muted contrast (Lc)", LC_TOLERANCE, 60),
  "contrast.faint.minLc": higher("Lowest faint contrast (Lc)", LC_TOLERANCE, 45),
  "contrast.placeholder.minLc": higher("Lowest placeholder contrast (Lc)", LC_TOLERANCE, 30),
  "contrast.disabled.minLc": higher("Lowest disabled contrast (Lc)", LC_TOLERANCE, 30),
  "contrast.ink.belowTarget": none("Ink text below its target"),
  "contrast.muted.belowTarget": none("Muted text below its target"),
  "contrast.faint.belowTarget": none("Faint text below its target"),
  "contrast.placeholder.belowTarget": none("Placeholder text below its target"),
  "contrast.disabled.belowTarget": none("Disabled text below its target"),
  "contrast.wcag.failing": none("Text failing WCAG contrast"),
  "contrast.unsupported": none("Text whose contrast could not be measured"),

  "text.dimmedByOpacity": none("Text dimmed by opacity"),
  "text.faintMisuse": none("Faint text larger than 12px"),

  "coverage.texts": reported("Distinct text strings", "higher"),
  "coverage.controls": reported("Controls", "higher"),
  "coverage.ink": reported("Ink text fragments", "higher"),
  "coverage.muted": reported("Muted text fragments", "higher"),
  "coverage.faint": reported("Faint text fragments", "higher"),
  "coverage.placeholder": reported("Placeholder text fragments", "higher"),
  "coverage.disabled": reported("Disabled text fragments", "higher"),
  "coverage.other": reported("Text fragments of no role", "higher"),

  "nonText.failing": none("Controls failing non-text contrast"),

  "type.sizes": lower("Distinct font sizes", 0, 7),
  "type.weights": lower("Distinct font weights", 0, 3),
  "type.offScale": none("Font sizes off the scale"),
  "radius.distinct": lower("Distinct corner radii", 0, 6),
  "radius.offToken": none("Corner radii not from a token"),
  "spacing.onGrid": higher("Spacing on the 4px grid (share)", 0.0005, 0.95),

  "target.under24": none("Click targets under 24px"),
  // Reported against the product's stricter 28px threshold; it never fails.
  "target.under28": reported("Click targets under 28px", "lower"),

  "focus.missing": none("Controls without a visible focus ring"),

  "resilience.textSpacing.clippedCharacters": none("Clipped characters with text spacing"),
  "resilience.textSpacing.overlaps": none("Overlaps with text spacing"),
  "resilience.textSize.clippedCharacters": none("Clipped characters at the largest text size"),
  "resilience.textSize.overlaps": none("Overlaps at the largest text size"),
  "resilience.reflow.clippedCharacters": none("Clipped characters at 150% zoom"),
  "resilience.reflow.overlaps": none("Overlaps at 150% zoom"),
  "resilience.rest.clippedCharacters": reported("Clipped characters at rest", "lower"),
  "resilience.rest.overlaps": reported("Overlaps at rest", "lower"),

  "reading.proseMeasureOff": lower("Prose line length outside 60 to 75 characters", 0.01, 0),

  "line.minLc": higher("Lowest line contrast (Lc)", LC_TOLERANCE, 15),
  "surface.minStep": higher("Smallest surface lightness step", 0.0005, 0.025),

  "glyphs.confusablePairs": none("Confusable glyph pairs"),
};

/** The run's own keys have no theme, only this prefix. */
const RUN_PREFIX = "run";

/** The screen name under which a theme's tokens are measured. */
const TOKENS_SCREEN = "tokens";

/** The suffix that marks a contrast metric measured with the window's glass at 0 %. */
const GLASS_ZERO_SUFFIX = "@glass0";

/** The parts of a key. `theme` and `screen` are null for a `run/` key, and `screen` is `tokens` for a theme's tokens. */
interface ParsedKey {
  readonly theme: string | null;
  readonly screen: string | null;
  readonly metric: string;
  readonly glassZero: boolean;
}

/** Splits a key into its parts. Fails when the key does not have the shape described at the top of this file. */
function parseKey(key: string): ParsedKey {
  const segments = key.split("/");
  const last = segments[segments.length - 1] ?? "";
  const glassZero = last.endsWith(GLASS_ZERO_SUFFIX);
  const metric = glassZero ? last.slice(0, -GLASS_ZERO_SUFFIX.length) : last;
  if (segments.length === 2 && segments[0] === RUN_PREFIX && metric !== "") {
    return { theme: null, screen: null, metric, glassZero };
  }
  if (segments.length === 3 && segments.every((segment) => segment !== "")) {
    return { theme: segments[0] ?? null, screen: segments[1] ?? null, metric, glassZero };
  }
  throw new Error(
    `The metric key "${key}" is not "<theme>/<screen>/<metric>", "<theme>/tokens/<metric>" or "run/<metric>".`,
  );
}

/** Returns the metric name of a key: the last segment, without the theme, the screen or `@glass0`. */
export function readMetricName(key: string): string {
  return parseKey(key).metric;
}

/** Returns the definition of the key's metric. Fails when the registry has no such metric, which is a bug in the metrics script or the registry. */
function readDefinition(key: string): MetricDefinition {
  const name = readMetricName(key);
  const definition = METRICS[name];
  if (definition === undefined) {
    throw new Error(
      `The metric "${name}" (key "${key}") is not in METRICS. Add it to the registry in ui-ratchet.ts, or fix the key.`,
    );
  }
  return definition;
}

/** Returns the context of a key's metric: whether the key's theme is a dark one. `run/` keys count as light. */
function readContext(key: string): { readonly dark: boolean } {
  const { theme } = parseKey(key);
  return { dark: theme !== null && isDarkTheme(theme) };
}

/**
 * Returns the part of the baseline that a run of `themes` is compared with:
 * the keys of those themes, and the `run/...` keys if and only if `themes`
 * includes `RUN_WIDE_THEME`. A key of another known theme is dropped, so a
 * run that measures only some themes does not report the others as missing.
 * Fails when a key is not a metric key, or names a theme that does not exist:
 * no shard would measure such a key, so dropping it would let it vanish from
 * every comparison unseen.
 */
export function selectBaselineForThemes(
  baseline: Readonly<Record<string, number>>,
  themes: ReadonlyArray<string>,
): Record<string, number> {
  const includesRunWide = themes.includes(RUN_WIDE_THEME);
  return Object.fromEntries(
    Object.entries(baseline).filter(([key]) => {
      const { theme } = parseKey(key);
      if (theme !== null && !ALL_THEMES.includes(theme)) {
        throw new Error(
          `The baseline holds ${key}, of a theme that does not exist. Write the baseline again from a full run.`,
        );
      }
      return theme === null ? includesRunWide : themes.includes(theme);
    }),
  );
}

/** One value that moved between the baseline and the current run. */
export interface RatchetChange {
  readonly key: string;
  readonly baseline: number;
  readonly current: number;
}

/** The outcome of comparing a run with the baseline. Every list is sorted by key. */
export interface RatchetResult {
  /** Ratcheted values that moved in the wrong direction by more than their tolerance. */
  readonly worse: ReadonlyArray<RatchetChange>;
  /** Ratcheted values that moved in the right direction by more than their tolerance. */
  readonly better: ReadonlyArray<RatchetChange>;
  /** Keys in the baseline that the run did not produce. */
  readonly missingFromCurrent: ReadonlyArray<string>;
  /** Keys the run produced that the baseline does not have. */
  readonly missingFromBaseline: ReadonlyArray<string>;
  /** False when anything is worse or missing on either side. */
  readonly passed: boolean;
}

/** Sorts strings by code unit order, so the output does not depend on the machine's locale. */
function sortKeys(keys: Iterable<string>): string[] {
  return [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Compares a run with the baseline and returns what got worse, what got
 * better, and which keys exist on one side only. Values are compared as they
 * are, unrounded. A ratcheted value is worse (or better) when it moved in the
 * wrong (or right) direction by more than the metric's tolerance. A metric
 * that is not ratcheted is never worse or better, but its key must still exist
 * on both sides. Fails when a key's metric is not in `METRICS`.
 */
export function compareWithBaseline(
  current: Readonly<Record<string, number>>,
  baseline: Readonly<Record<string, number>>,
): RatchetResult {
  const worse: RatchetChange[] = [];
  const better: RatchetChange[] = [];
  const missingFromCurrent: string[] = [];
  const missingFromBaseline: string[] = [];

  for (const key of sortKeys(new Set([...Object.keys(current), ...Object.keys(baseline)]))) {
    const definition = readDefinition(key);
    const currentValue = current[key];
    const baselineValue = baseline[key];
    if (currentValue === undefined) {
      missingFromCurrent.push(key);
      continue;
    }
    if (baselineValue === undefined) {
      missingFromBaseline.push(key);
      continue;
    }
    if (!definition.ratchet) {
      continue;
    }
    const cap = definition.ratchetCap?.(readContext(key)) ?? Infinity;
    const [comparedCurrent, comparedBaseline] = [
      Math.min(currentValue, cap),
      Math.min(baselineValue, cap),
    ];
    // Positive when the value moved the right way.
    const improvement =
      definition.direction === "higher"
        ? comparedCurrent - comparedBaseline
        : comparedBaseline - comparedCurrent;
    const change = { key, baseline: baselineValue, current: currentValue };
    if (improvement < -(definition.tolerance + EPSILON)) {
      worse.push(change);
    } else if (improvement > definition.tolerance + EPSILON) {
      better.push(change);
    }
  }

  return {
    worse,
    better,
    missingFromCurrent,
    missingFromBaseline,
    passed:
      worse.length === 0 && missingFromCurrent.length === 0 && missingFromBaseline.length === 0,
  };
}

/** Whether a key's value met its metric's target. */
export interface TargetResult {
  readonly key: string;
  readonly value: number;
  readonly met: boolean;
}

/**
 * Checks every value of the run against its metric's target and returns the
 * results sorted by key. A theme's darkness is read from the key; `run/` keys
 * count as light. Fails when a key's metric is not in `METRICS`.
 */
export function checkTargets(current: Readonly<Record<string, number>>): TargetResult[] {
  return sortKeys(Object.keys(current)).map((key) => {
    const definition = readDefinition(key);
    const value = current[key] as number;
    return { key, value, met: definition.target(value, readContext(key)) };
  });
}

/** The number of decimals the baseline file keeps: finer than every tolerance. */
const BASELINE_DECIMALS = 4;

/**
 * Returns the text of the baseline file for a run: JSON with sorted keys,
 * values rounded to 4 decimals, 2-space indent and a trailing newline. The
 * same run always gives the same bytes. Fails when a value is not a finite
 * number, naming its key.
 */
export function formatBaseline(current: Readonly<Record<string, number>>): string {
  const scale = 10 ** BASELINE_DECIMALS;
  const rounded: Record<string, number> = {};
  for (const key of sortKeys(Object.keys(current))) {
    const value = current[key] as number;
    if (!Number.isFinite(value)) {
      throw new Error(
        `The metric "${key}" is ${value}, but the baseline stores finite numbers only.`,
      );
    }
    rounded[key] = Math.round(value * scale) / scale;
  }
  return `${JSON.stringify(rounded, null, 2)}\n`;
}

/**
 * Parses the text of a baseline file into a record. Fails when the text is
 * not JSON, is not an object, or has a value that is not a finite number; the
 * message names the bad key.
 */
export function parseBaseline(text: string): Record<string, number> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("The baseline must be a JSON object of metric keys to numbers.");
  }
  const baseline: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(
        `The baseline value for "${key}" is ${JSON.stringify(value)}, but it must be a finite number.`,
      );
    }
    baseline[key] = value;
  }
  return baseline;
}

/** Returns a value rounded for display: Lc and prose measure with 1 decimal, lightness steps with 3, shares as a percentage, counts as integers. */
function formatValue(metric: string, value: number): string {
  if (metric.endsWith(".minLc") || metric === "reading.proseMeasureOff") {
    return value.toFixed(1);
  }
  if (metric === "surface.minStep") {
    return value.toFixed(3);
  }
  if (metric === "spacing.onGrid") {
    return `${(value * 100).toFixed(1)}%`;
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** Returns a Markdown table. Cells are padded so the table also reads in a terminal. */
function renderTable(
  header: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
): string {
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const renderRow = (row: ReadonlyArray<string>): string =>
    `| ${row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join(" | ")} |`;
  const divider = `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`;
  return [renderRow(header), divider, ...rows.map(renderRow)].join("\n");
}

/** The mark that follows a displayed value that misses its target. */
const MISSED_MARK = " ✗";

/** Returns the lines that list changed keys, with their values rounded for display. */
function renderChanges(changes: ReadonlyArray<RatchetChange>): string[] {
  return changes.map(({ key, baseline, current }) => {
    const metric = readMetricName(key);
    return `- \`${key}\`: ${formatValue(metric, baseline)} -> ${formatValue(metric, current)}`;
  });
}

/** Returns the section of the report about the comparison with the baseline. */
function renderRatchet(ratchet: RatchetResult): string[] {
  const lines = [`## Ratchet: ${ratchet.passed ? "passed" : "FAILED"}`];
  const sections: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
    ["Worse than the baseline", renderChanges(ratchet.worse)],
    [
      "In the baseline, missing from this run",
      ratchet.missingFromCurrent.map((key) => `- \`${key}\``),
    ],
    [
      "In this run, missing from the baseline (write the baseline)",
      ratchet.missingFromBaseline.map((key) => `- \`${key}\``),
    ],
    ["Better than the baseline (write the baseline to keep it)", renderChanges(ratchet.better)],
  ];
  for (const [title, items] of sections) {
    if (items.length > 0) {
      lines.push("", `**${title} (${items.length})**`, ...items);
    }
  }
  return lines;
}

/** Returns the cell text for a value, marked when it misses its target. */
function renderCell(metric: string, value: number, met: boolean | undefined): string {
  return `${formatValue(metric, value)}${met === false ? MISSED_MARK : ""}`;
}

/** Returns names in the given preferred order, then the others by name. */
function sortByPreference(names: Iterable<string>, preferred: ReadonlyArray<string>): string[] {
  const position = (name: string): number => {
    const index = preferred.indexOf(name);
    return index === -1 ? preferred.length : index;
  };
  return sortKeys(names).sort((a, b) => position(a) - position(b));
}

/** Displayed values by row label, then by column label. */
type Grid = Map<string, Map<string, string>>;

/** Stores a displayed value in a grid. */
function setCell(grid: Grid, row: string, column: string, text: string): void {
  const cells = grid.get(row) ?? new Map<string, string>();
  cells.set(column, text);
  grid.set(row, cells);
}

/** Returns a table with one row per grid row, sorted, and "-" where a cell has no value. */
function renderGrid(grid: Grid, columns: ReadonlyArray<string>): string {
  const rows = sortKeys(grid.keys()).map((row) => [
    row,
    ...columns.map((column) => grid.get(row)?.get(column) ?? "-"),
  ]);
  return renderTable(["metric", ...columns], rows);
}

/** Returns every column label used in a grid. */
function listColumns(grid: Grid): Set<string> {
  return new Set([...grid.values()].flatMap((cells) => [...cells.keys()]));
}

/**
 * Returns the Markdown report of a run: first the ratchet verdict (what got
 * worse, what is missing on either side, what got better), then a summary of
 * the targets, then per theme a table of its screens (one row per metric, one
 * column per screen), a table of every theme's tokens, and a table of the
 * run's own values. Values are rounded for display, and a value that misses
 * its target is marked with "✗". Fails when a key's metric is not in `METRICS`.
 */
export function formatReport(
  current: Readonly<Record<string, number>>,
  ratchet: RatchetResult,
  targets: ReadonlyArray<TargetResult>,
): string {
  const metByKey = new Map(targets.map((target) => [target.key, target.met]));
  const missed = targets.filter((target) => !target.met).length;

  const screenGrids = new Map<string, Grid>();
  const tokenGrid: Grid = new Map();
  const runGrid: Grid = new Map();
  for (const key of sortKeys(Object.keys(current))) {
    readDefinition(key);
    const { theme, screen, metric, glassZero } = parseKey(key);
    const text = renderCell(metric, current[key] as number, metByKey.get(key));
    const row = glassZero ? `${metric}${GLASS_ZERO_SUFFIX}` : metric;
    if (theme === null || screen === null) {
      setCell(runGrid, row, "value", text);
    } else if (screen === TOKENS_SCREEN) {
      setCell(tokenGrid, row, theme, text);
    } else {
      const grid = screenGrids.get(theme) ?? new Map();
      setCell(grid, row, screen, text);
      screenGrids.set(theme, grid);
    }
  }

  const lines = [
    ...renderRatchet(ratchet),
    "",
    `## Targets: ${targets.length - missed} of ${targets.length} met`,
  ];
  const screenOrder = UI_SCREENS.map((screen) => screen.name);
  for (const theme of sortByPreference(screenGrids.keys(), ALL_THEMES)) {
    const grid = screenGrids.get(theme) as Grid;
    lines.push(
      "",
      `## ${theme}`,
      "",
      renderGrid(grid, sortByPreference(listColumns(grid), screenOrder)),
    );
  }
  if (tokenGrid.size > 0) {
    lines.push(
      "",
      "## Tokens",
      "",
      renderGrid(tokenGrid, sortByPreference(listColumns(tokenGrid), ALL_THEMES)),
    );
  }
  if (runGrid.size > 0) {
    lines.push("", "## Run", "", renderGrid(runGrid, ["value"]));
  }
  return `${lines.join("\n")}\n`;
}
