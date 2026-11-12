/**
 * The comparison of the counts check (scripts/perf-counts.ts) with its
 * committed baseline, and the report it prints. Every count is better lower.
 *
 * A count is compared exactly, except the elements restyled in a step: how many
 * style recalculations a step's frames hold varies a little from run to run,
 * so a restyle count is worse only when it grew by more than 10 % of the
 * baseline, and at least 25 elements. A real regression, such as a `:has()`
 * rule that restyles every row on each key, grows it many times over.
 */

/** A count that moved, with its baseline value and its value in this run. */
export interface CountChange {
  readonly key: string;
  readonly baseline: number;
  readonly current: number;
}

/** The outcome of comparing a run with the baseline. Every list is sorted by key. */
export interface CountsComparison {
  readonly worse: readonly CountChange[];
  readonly better: readonly CountChange[];
  /** Keys in the baseline that the run did not produce. */
  readonly missingFromRun: readonly string[];
  /** Keys the run produced that the baseline does not have. */
  readonly missingFromBaseline: readonly string[];
  /** False when a count is worse or a key is missing on either side. */
  readonly passed: boolean;
}

/** Returns how much the count under `key` may grow over `baseline` before it is worse. */
const findTolerance = (key: string, baseline: number): number =>
  key.endsWith("/restyled") ? Math.max(25, baseline * 0.1) : 0;

/** Sorts strings by code unit order, so the output does not depend on the machine's locale. */
const sortKeys = (keys: Iterable<string>): string[] =>
  [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** Compares the counts of a run with the baseline. */
export function compareCounts(
  current: Readonly<Record<string, number>>,
  baseline: Readonly<Record<string, number>>,
): CountsComparison {
  const worse: CountChange[] = [];
  const better: CountChange[] = [];
  const missingFromRun: string[] = [];
  const missingFromBaseline: string[] = [];
  for (const key of sortKeys(new Set([...Object.keys(current), ...Object.keys(baseline)]))) {
    const now = current[key];
    const before = baseline[key];
    if (now === undefined) missingFromRun.push(key);
    else if (before === undefined) missingFromBaseline.push(key);
    else if (now > before + findTolerance(key, before))
      worse.push({ key, baseline: before, current: now });
    else if (now < before - findTolerance(key, before))
      better.push({ key, baseline: before, current: now });
  }
  return {
    worse,
    better,
    missingFromRun,
    missingFromBaseline,
    passed: worse.length === 0 && missingFromRun.length === 0 && missingFromBaseline.length === 0,
  };
}

/** Formats a count with thousands separators, the same on every machine. */
const formatCount = (value: number): string => value.toLocaleString("en-US");

/** Formats `current`, followed by its change from `baseline` when it changed. */
const formatWithChange = (current: number, baseline: number | undefined): string =>
  baseline === undefined || baseline === current
    ? formatCount(current)
    : `${formatCount(current)} (${current > baseline ? "+" : ""}${formatCount(current - baseline)})`;

/** Formats one changed count as a list item. */
const formatChange = ({ key, baseline, current }: CountChange): string =>
  `- \`${key}\`: ${formatCount(baseline)} -> ${formatCount(current)}`;

/**
 * Formats the counts under `prefix` as a markdown table: one row per name
 * between the prefix and the last `/`, one column per metric after it, each
 * cell the count with its change from the baseline.
 */
function formatTable(
  heading: string,
  prefix: string,
  current: Readonly<Record<string, number>>,
  baseline: Readonly<Record<string, number>>,
): string {
  const rows = new Map<string, Map<string, string>>();
  const metrics: string[] = [];
  for (const [key, value] of Object.entries(current)) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const cut = rest.lastIndexOf("/");
    const [name, metric] = [rest.slice(0, cut), rest.slice(cut + 1)];
    if (!metrics.includes(metric)) metrics.push(metric);
    const row = rows.get(name) ?? new Map<string, string>();
    row.set(metric, formatWithChange(value, baseline[key]));
    rows.set(name, row);
  }
  const lines = [
    `| ${heading} | ${metrics.join(" | ")} |`,
    `| --- | ${metrics.map(() => "---:").join(" | ")} |`,
    ...[...rows].map(
      ([name, row]) =>
        `| ${name} | ${metrics.map((metric) => row.get(metric) ?? "-").join(" | ")} |`,
    ),
  ];
  return lines.join("\n");
}

/**
 * Formats the report of a run: the verdict, what got worse or better, the keys
 * missing on either side, then one table per part of the check, each count
 * with its change from the baseline. `notes` follow the tables, for what the
 * run found that is not a count, such as the requests of each step.
 */
export function formatCountsReport(
  current: Readonly<Record<string, number>>,
  baseline: Readonly<Record<string, number>>,
  comparison: CountsComparison,
  notes: string,
): string {
  const verdict = comparison.passed
    ? "**Passed.** No count is worse than the baseline."
    : `**Failed.** ${String(comparison.worse.length)} counts are worse, ${String(comparison.missingFromRun.length + comparison.missingFromBaseline.length)} keys are missing on one side. ` +
      "If the change is meant, run with `--write-baseline`, commit `apps/desktop/perf-counts.baseline.json`, and give the reason in the pull request.";
  const sections = [
    "# Desktop counts check",
    verdict,
    comparison.worse.length > 0
      ? `## Worse\n\n${comparison.worse.map(formatChange).join("\n")}`
      : "",
    comparison.better.length > 0
      ? `## Better\n\nRe-write the baseline with \`--write-baseline\` to keep the gain.\n\n${comparison.better.map(formatChange).join("\n")}`
      : "",
    comparison.missingFromBaseline.length > 0
      ? `## New, not in the baseline\n\n${comparison.missingFromBaseline.map((key) => `- \`${key}\``).join("\n")}`
      : "",
    comparison.missingFromRun.length > 0
      ? `## In the baseline, not measured\n\n${comparison.missingFromRun.map((key) => `- \`${key}\``).join("\n")}`
      : "",
    "## Screens",
    formatTable("Inbox", "screens/inbox/", current, baseline),
    formatTable("Work", "screens/work/", current, baseline),
    "Pending once the screen has been quiet for a second:",
    formatTable("Idle", "idle/", current, baseline),
    "## Controller reads",
    formatTable("Read", "controller/", current, baseline),
    "## Bundle",
    formatTable("Layer", "bundle/", current, baseline),
    notes,
  ];
  return `${sections.filter((section) => section !== "").join("\n\n")}\n`;
}
