/**
 * The pure logic of the desktop Fleet screen's Software grid, the update count
 * on a machine's card, and the Tools list of a machine's page. No function
 * here reads a clock or a store; the caller passes the records, the time zone
 * and `today` (see `fleet.ts` for what `today` is).
 *
 * The grid and the update count share one classification of a version against
 * its latest release, so the count on a card can never disagree with the grid.
 *
 * This module is its own subpath (`@hercule/client-core/software`) and is not
 * re-exported from the package index, so the first screen does not carry it.
 */
import {
  PROBED_TOOLCHAINS,
  type Harness,
  type HarnessLatestRelease,
  type HarnessOnRunner,
  type Runner,
} from "@hercule/contract";
import { formatShortMoment } from "../time-context";
import { listFleetRunners } from "./fleet";
import { plural } from "./machine";
import { compareReleaseVersions } from "./versions";

/**
 * What one machine's cell of the grid shows:
 *
 * - `latest`: the machine has the latest release or a newer one. Draws a check.
 * - `older`: the machine has a version older than the latest release.
 * - `below-floor`: the version is below the oldest this Hercule build works
 *   with, whatever the latest release is.
 * - `not-installed`: the tool is not on the machine. Draws a dash.
 * - `version`: the version, with no mark. Every toolchain is this, and so is
 *   a harness or the runner when the version or the latest release is not
 *   known or has no order (such as "go1.25").
 * - `unknown-version`: the tool is installed but its version is not known.
 */
export type SoftwareCellKind =
  | "latest"
  | "older"
  | "below-floor"
  | "not-installed"
  | "version"
  | "unknown-version";

/** One machine's cell in one row of the grid. */
export interface SoftwareCell {
  readonly kind: SoftwareCellKind;
  /**
   * The version to draw, "Installed" for `unknown-version`, and "Not
   * installed" for `not-installed` (which is drawn as a dash, so this is its
   * accessible text).
   */
  readonly text: string;
  readonly tooltip: string | null;
  /** Whether the machine is offline or unreachable, so the version is its last known one and is drawn muted. */
  readonly isAway: boolean;
}

/** The Latest column of one row. */
export interface SoftwareLatest {
  readonly text: string;
  readonly tone: "ink" | "muted" | "faint";
  /** A muted note after `text`, such as "checked 09:00". */
  readonly note: string | null;
  readonly tooltip: string | null;
}

/** A group of machines that have one version of a tool, in the row's detail. */
export interface SoftwareVersionGroup {
  /** The version, "Installed" when the machines have it with no known version, or "Not installed". */
  readonly text: string;
  /** The names of the machines, in column order. */
  readonly machines: readonly string[];
}

/** What a row shows when it is opened in place under the row. */
export interface SoftwareDetail {
  /** One line on what the tool is, or `null` for a harness this list does not know. */
  readonly description: string | null;
  /** The latest release and when it was last checked, or why there is none. */
  readonly latestLine: string;
  /** The machines by version, newest first, then versions with no known order, then "Not installed". */
  readonly versions: readonly SoftwareVersionGroup[];
}

/** One tool in the grid. */
export interface SoftwareRow {
  /** `runner`, a harness's qualified id, or a toolchain's name. */
  readonly key: string;
  readonly name: string;
  readonly latest: SoftwareLatest;
  /** One cell per column, in the order of the columns. */
  readonly cells: readonly SoftwareCell[];
  readonly detail: SoftwareDetail;
}

/** One machine's column head. */
export interface SoftwareColumn {
  readonly runnerId: string;
  readonly name: string;
  /** Whether the machine is offline or unreachable. */
  readonly isAway: boolean;
}

/** A group of rows of the grid: "Harnesses" or "Toolchains". */
export interface SoftwareGroup {
  readonly name: string;
  readonly rows: readonly SoftwareRow[];
}

/** Everything the Software grid draws. See `describeFleetSoftware`. */
export interface FleetSoftware {
  readonly columns: readonly SoftwareColumn[];
  readonly groups: readonly SoftwareGroup[];
}

/** What a machine's Tools list shows. See `listMachineTools`. */
export interface MachineTools {
  readonly tools: readonly { readonly name: string; readonly version: string }[];
  /** "Not installed: terraform, dotnet", or `null` when every probed toolchain is there. */
  readonly notInstalledText: string | null;
}

const RUNNER_KEY = "runner";

/** One line on what each tool is, by row key. A harness from a third-party plugin has none. */
const DESCRIPTIONS: ReadonlyMap<string, string> = new Map([
  [RUNNER_KEY, "Hosts the sessions on a machine."],
  ["claude-code/claude-code", "Runs Claude models."],
  ["codex/codex", "Runs OpenAI models."],
  ["pi/pi", "Runs any model with an API key."],
  ["git", "Every workspace is a git checkout."],
  ["gh", "GitHub's CLI. Agents open pull requests with it."],
  ["node", "JavaScript runtime."],
  ["pnpm", "JavaScript package manager."],
  ["bun", "JavaScript runtime and package manager."],
  ["go", "Go toolchain."],
  ["rustc", "Rust compiler."],
  ["python3", "Python interpreter."],
  ["uv", "Python package manager."],
  ["docker", "Runs containers."],
  ["terraform", "Infrastructure as code."],
  ["dotnet", "The .NET SDK."],
]);

const NOT_TRACKED_TEXT = "Hercule does not follow this tool's releases yet.";
const BELOW_FLOOR_TOOLTIP = "Too old for this Hercule: update it";
const UNKNOWN_VERSION_TOOLTIP = "The version of this tool is not known yet.";
const NOT_CHECKED_TEXT = "Not checked yet";

/** How one installed (or missing) tool on one machine ranks against its latest release. */
interface Standing {
  readonly kind: SoftwareCellKind;
  /**
   * Whether a newer release exists than the machine's version. True for
   * `older`, and also for a `below-floor` version that is older than the
   * latest release: the update count includes it, the cell shows the floor.
   */
  readonly isOlder: boolean;
}

const NOT_INSTALLED: Standing = { kind: "not-installed", isOlder: false };
const UNKNOWN_VERSION: Standing = { kind: "unknown-version", isOlder: false };

/** Ranks a known version against the latest release. `version` when the order is not known. */
const rankAgainstLatest = (version: string, latest: string | null): Standing => {
  const order = latest === null ? undefined : compareReleaseVersions(version, latest);
  if (order === undefined) return { kind: "version", isOlder: false };
  return order === -1 ? { kind: "older", isOlder: true } : { kind: "latest", isOlder: false };
};

/**
 * Ranks the runner's own version against its controller's, which is the
 * latest release a runner can update to. A runner with no version is
 * `unknown-version`.
 */
const rankRunner = (runner: Runner, controllerVersion: string): Standing =>
  runner.version === null ? UNKNOWN_VERSION : rankAgainstLatest(runner.version, controllerVersion);

/**
 * Ranks a harness on one machine against the harness's latest release.
 * `onMachine` is the machine's entry in the harness, or `undefined` when the
 * harness lists none, which counts as not installed.
 *
 * A version below the floor is `below-floor` whatever the comparison says.
 */
const rankHarness = (onMachine: HarnessOnRunner | undefined, latest: string | null): Standing => {
  if (onMachine === undefined || !onMachine.installed) return NOT_INSTALLED;
  if (onMachine.version === null) return UNKNOWN_VERSION;
  const ranked = rankAgainstLatest(onMachine.version, latest);
  return onMachine.versionVerdict === "below-floor"
    ? { kind: "below-floor", isOlder: ranked.isOlder }
    : ranked;
};

/** Returns the latest release version of a harness from the last successful read, or `null` before one. */
const readHarnessLatestVersion = (harness: Harness): string | null =>
  harness.latestRelease?.version ?? null;

/**
 * Describes the failed read of a harness's latest release as a sentence.
 * Returns `null` when the last read did not fail.
 */
const describeReadFailure = (release: HarnessLatestRelease | null): string | null =>
  release?.error == null
    ? null
    : `The last check for a newer release failed: ${release.error.replace(/\.$/, "")}.`;

/**
 * Formats when a harness's latest release was read, in the same short form as
 * a machine's last-seen time ("09:00"). Returns `null` when it was never read
 * or the time cannot be formatted.
 */
const formatCheckedAt = (
  release: HarnessLatestRelease | null,
  timezone: string,
  today: Date,
): string | null =>
  release?.checkedAt == null
    ? null
    : (formatShortMoment(new Date(release.checkedAt), today, timezone) ?? null);

const HARNESSES_GROUP = "Harnesses";
const TOOLCHAINS_GROUP = "Toolchains";

const buildCell = (standing: Standing, version: string | null, isAway: boolean): SoftwareCell => ({
  kind: standing.kind,
  text:
    standing.kind === "not-installed"
      ? "Not installed"
      : standing.kind === "unknown-version"
        ? "Installed"
        : (version ?? "Installed"),
  tooltip:
    standing.kind === "below-floor"
      ? BELOW_FLOOR_TOOLTIP
      : standing.kind === "unknown-version"
        ? UNKNOWN_VERSION_TOOLTIP
        : null,
  isAway,
});

/**
 * Groups the machines of a row by the version their cell shows. The groups
 * run newest first by `compareReleaseVersions`, then the versions with no
 * known order in the order they first appear, then "Not installed".
 */
const groupMachinesByVersion = (
  columns: readonly SoftwareColumn[],
  cells: readonly SoftwareCell[],
): readonly SoftwareVersionGroup[] => {
  const byText = new Map<string, string[]>();
  const missing: string[] = [];
  cells.forEach((cell, index) => {
    const name = columns[index]!.name;
    if (cell.kind === "not-installed") {
      missing.push(name);
      return;
    }
    const group = byText.get(cell.text);
    if (group === undefined) byText.set(cell.text, [name]);
    else group.push(name);
  });
  const ordered: SoftwareVersionGroup[] = [];
  const unordered: SoftwareVersionGroup[] = [];
  for (const [text, machines] of byText) {
    const hasOrder = compareReleaseVersions(text, text) !== undefined;
    (hasOrder ? ordered : unordered).push({ text, machines });
  }
  ordered.sort((a, b) => -(compareReleaseVersions(a.text, b.text) ?? 0));
  return [
    ...ordered,
    ...unordered,
    ...(missing.length === 0 ? [] : [{ text: "Not installed", machines: missing }]),
  ];
};

const buildRow = (
  columns: readonly SoftwareColumn[],
  key: string,
  name: string,
  latest: SoftwareLatest,
  latestLine: string,
  cells: readonly SoftwareCell[],
): SoftwareRow => ({
  key,
  name,
  latest,
  cells,
  detail: {
    description: DESCRIPTIONS.get(key) ?? null,
    latestLine,
    versions: groupMachinesByVersion(columns, cells),
  },
});

/** Builds the row of a harness: its Latest column, its detail line and one cell per machine. */
const buildHarnessRow = (
  columns: readonly SoftwareColumn[],
  harness: Harness,
  timezone: string,
  today: Date,
): SoftwareRow => {
  const release = harness.latestRelease;
  const latestVersion = readHarnessLatestVersion(harness);
  const failure = describeReadFailure(release);
  const checkedAt = formatCheckedAt(release, timezone, today);
  const byRunner = new Map(harness.runners.map((entry) => [entry.runnerId, entry]));
  const cells = columns.map((column) => {
    const onMachine = byRunner.get(column.runnerId);
    return buildCell(
      rankHarness(onMachine, latestVersion),
      onMachine?.version ?? null,
      column.isAway,
    );
  });
  const checked = checkedAt === null ? "" : `, checked ${checkedAt}`;
  const latestLine =
    latestVersion === null ? "Not checked yet." : `Latest release ${latestVersion}${checked}.`;
  return buildRow(
    columns,
    harness.id,
    harness.displayName,
    latestVersion === null
      ? { text: NOT_CHECKED_TEXT, tone: "muted", note: null, tooltip: failure }
      : {
          text: latestVersion,
          tone: "ink",
          note: failure === null || checkedAt === null ? null : `checked ${checkedAt}`,
          tooltip: failure,
        },
    failure === null ? latestLine : `${latestLine} ${failure}`,
    cells,
  );
};

/**
 * Builds the Software grid: tools down, machines across. The columns are the
 * machines the Fleet page shows, in its order. The rows are in two groups.
 * "Harnesses" holds the Hercule runner first, then each of `harnesses`.
 * "Toolchains" holds the fixed list of probed toolchains, in order.
 *
 * - The latest release of a harness is the one the controller last read
 *   successfully. The latest release of the runner is `controllerVersion`.
 *   A toolchain has none.
 * - A harness or runner cell is `latest` at the latest release or newer,
 *   `older` below it, and `below-floor` when the machine reports a version
 *   below the floor of this Hercule build, which wins over the comparison.
 * - A toolchain cell is never `older` or `latest`, because nothing says which
 *   release is the latest.
 *
 * Times are worded in `timezone`, relative to `today`.
 */
export const describeFleetSoftware = (
  runners: readonly Runner[],
  harnesses: readonly Harness[],
  controllerVersion: string,
  timezone: string,
  today: Date,
): FleetSoftware => {
  const machines = listFleetRunners(runners);
  const columns = machines.map((runner) => ({
    runnerId: runner.id,
    name: runner.name,
    isAway: runner.connectivity !== "online",
  }));

  const runnerRow = buildRow(
    columns,
    RUNNER_KEY,
    "Hercule runner",
    { text: controllerVersion, tone: "ink", note: null, tooltip: null },
    "Hercule's own version: a runner updates to its controller's version.",
    machines.map((runner, index) =>
      buildCell(rankRunner(runner, controllerVersion), runner.version, columns[index]!.isAway),
    ),
  );

  const versionsByRunner = new Map(
    machines.map((runner) => [
      runner.id,
      new Map((runner.facts?.toolchains ?? []).map((tool) => [tool.name, tool.version])),
    ]),
  );
  const toolchainRows = PROBED_TOOLCHAINS.map((name) =>
    buildRow(
      columns,
      name,
      name,
      { text: "Not tracked", tone: "faint", note: null, tooltip: NOT_TRACKED_TEXT },
      NOT_TRACKED_TEXT,
      columns.map((column) => {
        const version = versionsByRunner.get(column.runnerId)?.get(name);
        return version === undefined
          ? buildCell(NOT_INSTALLED, null, column.isAway)
          : buildCell({ kind: "version", isOlder: false }, version, column.isAway);
      }),
    ),
  );

  return {
    columns,
    groups: [
      {
        name: HARNESSES_GROUP,
        rows: [
          runnerRow,
          ...harnesses.map((harness) => buildHarnessRow(columns, harness, timezone, today)),
        ],
      },
      { name: TOOLCHAINS_GROUP, rows: toolchainRows },
    ],
  };
};

/**
 * Describes how many updates a machine has, for its card: "1 update" or "2
 * updates". Returns `null` for none. It counts the runner and each harness
 * that is older than its latest release, including a version below the floor
 * that is also older. Toolchains never count, and neither does a version that
 * is not known or has no order.
 */
export const describeMachineUpdates = (
  runner: Runner,
  harnesses: readonly Harness[],
  controllerVersion: string,
): string | null => {
  const outdatedHarnesses = harnesses.filter(
    (harness) =>
      rankHarness(
        harness.runners.find((entry) => entry.runnerId === runner.id),
        readHarnessLatestVersion(harness),
      ).isOlder,
  ).length;
  const count = outdatedHarnesses + (rankRunner(runner, controllerVersion).isOlder ? 1 : 0);
  return count === 0 ? null : `${String(count)} ${plural(count, "update", "updates")}`;
};

/**
 * Lists the toolchains found on a machine with their versions, for the Tools
 * part of its page. They run in the order of the probed list; a toolchain
 * outside the list, which a newer runner may report, goes after them in the
 * order reported. `notInstalledText` names the probed toolchains that are
 * missing ("Not installed: terraform, dotnet"), or is `null` when none is.
 * A runner that has not reported its facts has no tools and no text.
 */
export const listMachineTools = (runner: Runner): MachineTools => {
  const reported = runner.facts?.toolchains;
  if (reported === undefined) return { tools: [], notInstalledText: null };
  const rank = new Map<string, number>(PROBED_TOOLCHAINS.map((name, index) => [name, index]));
  const unlisted = PROBED_TOOLCHAINS.length;
  const tools = reported
    .map(({ name, version }) => ({ name, version }))
    .toSorted((a, b) => (rank.get(a.name) ?? unlisted) - (rank.get(b.name) ?? unlisted));
  const found = new Set(reported.map((tool) => tool.name));
  const missing = PROBED_TOOLCHAINS.filter((name) => !found.has(name));
  return {
    tools,
    notInstalledText: missing.length === 0 ? null : `Not installed: ${missing.join(", ")}`,
  };
};
