/**
 * The report of the counts check (scripts/perf-counts.ts): the counts of a
 * run, compared with a baseline when there is one. On a pull request the
 * baseline is main's latest counts, and CI posts the report as a comment. The
 * report informs; nothing in it fails the check.
 *
 * Every count is better lower. A count that moved is listed as higher or
 * lower, except within the run-to-run noise of two kinds, which vary a little
 * from run to run, most on a busy machine:
 *
 * - the elements restyled in a step, because how many style recalculations a
 *   step's frames hold varies: a change within 10 % of the baseline, or 25
 *   elements, is noise;
 * - the components rendered in a step, because React commits the answers that
 *   arrive in one task together, and how the answers fall into tasks varies:
 *   a change within 5 %, or 5 renders, is noise.
 *
 * A real regression grows them many times over: a `:has()` rule that restyles
 * every row on each key, or a row that renders on every change of the list.
 */

/** A count that moved, with its baseline value and its value in this run. */
export interface CountChange {
  readonly key: string;
  readonly baseline: number;
  readonly current: number;
}

/** What moved between a baseline and a run. Every list is sorted by key. */
export interface CountsComparison {
  readonly higher: readonly CountChange[];
  readonly lower: readonly CountChange[];
  /** Keys the run produced that the baseline does not have, such as a new step. */
  readonly added: readonly string[];
  /** Keys in the baseline that the run did not produce. */
  readonly gone: readonly string[];
}

/** Returns how far the count under `key` may move from `baseline` and still be noise. */
const findNoise = (key: string, baseline: number): number => {
  if (key.endsWith("/restyled")) return Math.max(25, baseline * 0.1);
  if (key.endsWith("/renders") || key.endsWith("/rowRenders")) {
    return Math.max(5, baseline * 0.05);
  }
  return 0;
};

/** Sorts strings by code unit order, so the output does not depend on the machine's locale. */
const sortKeys = (keys: Iterable<string>): string[] =>
  [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** Compares the counts of a run with the baseline. */
export function compareCounts(
  current: Readonly<Record<string, number>>,
  baseline: Readonly<Record<string, number>>,
): CountsComparison {
  const higher: CountChange[] = [];
  const lower: CountChange[] = [];
  const added: string[] = [];
  const gone: string[] = [];
  for (const key of sortKeys(new Set([...Object.keys(current), ...Object.keys(baseline)]))) {
    const now = current[key];
    const before = baseline[key];
    if (now === undefined) gone.push(key);
    else if (before === undefined) added.push(key);
    else if (now > before + findNoise(key, before))
      higher.push({ key, baseline: before, current: now });
    else if (now < before - findNoise(key, before))
      lower.push({ key, baseline: before, current: now });
  }
  return { higher, lower, added, gone };
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
  return [
    `| ${heading} | ${metrics.join(" | ")} |`,
    `| --- | ${metrics.map(() => "---:").join(" | ")} |`,
    ...[...rows].map(
      ([name, row]) =>
        `| ${name} | ${metrics.map((metric) => row.get(metric) ?? "-").join(" | ")} |`,
    ),
  ].join("\n");
}

/** Wraps `body` in a block the reader opens by clicking `summary`. */
const formatFolded = (summary: string, body: string): string =>
  `<details><summary>${summary}</summary>\n\n${body}\n\n</details>`;

/**
 * Formats the report of a run. With a baseline, it starts with what moved:
 * the counts that went up, then those that went down, then keys on one side
 * only. Without one, it says so. The tables of every count, and `notes` (what
 * each step sent and rendered), follow in folded blocks.
 */
export function formatCountsReport(
  current: Readonly<Record<string, number>>,
  baseline: Readonly<Record<string, number>> | null,
  notes: string,
): string {
  const sections = ["## Desktop counts"];
  if (baseline === null) {
    sections.push(
      "No baseline to compare with. Run `perf:counts --write-baseline` on `main` first to write one.",
    );
  } else {
    const { higher, lower, added, gone } = compareCounts(current, baseline);
    const moved = higher.length + lower.length + added.length + gone.length;
    sections.push(
      moved === 0
        ? "No count moved."
        : `${String(higher.length)} went up, ${String(lower.length)} went down, ${String(added.length)} are new and ${String(gone.length)} are gone. ` +
            "This informs and fails nothing. Explain in the pull request any count that went up.",
    );
    if (higher.length > 0) sections.push(`### Went up\n\n${higher.map(formatChange).join("\n")}`);
    if (lower.length > 0) sections.push(`### Went down\n\n${lower.map(formatChange).join("\n")}`);
    if (added.length > 0)
      sections.push(`### New\n\n${added.map((key) => `- \`${key}\``).join("\n")}`);
    if (gone.length > 0)
      sections.push(`### Gone\n\n${gone.map((key) => `- \`${key}\``).join("\n")}`);
  }
  const against = baseline ?? {};
  sections.push(
    formatFolded(
      "Every count",
      [
        formatTable("Inbox", "screens/inbox/", current, against),
        formatTable("Work", "screens/work/", current, against),
        "Pending once the screen has been quiet for a second:",
        formatTable("Idle", "idle/", current, against),
        formatTable("Controller read", "controller/", current, against),
        formatTable("Bundle", "bundle/", current, against),
      ].join("\n\n"),
    ),
    formatFolded("What each step sent and rendered most", notes),
  );
  return `${sections.join("\n\n")}\n`;
}
