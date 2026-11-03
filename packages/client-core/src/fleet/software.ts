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
import { compareReleaseVersions, isReleaseVersion } from "./versions";

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
 * - `not-probed`: the machine's runner is too old to have looked for this
 *   toolchain, so nothing is known about it. Draws "Unknown".
 */
export type SoftwareCellKind =
  | "latest"
  | "older"
  | "below-floor"
  | "not-installed"
  | "version"
  | "unknown-version"
  | "not-probed";

/** One machine's cell in one row of the grid. */
export interface SoftwareCell {
  readonly kind: SoftwareCellKind;
  /**
   * The version to draw, "Installed" for `unknown-version`, "Unknown" for
   * `not-probed`, and "Not installed" for `not-installed` (which is drawn as
   * a dash, so this is its accessible text).
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
  /**
   * The version, "Installed" when the machines have it with no known version,
   * "Not looked for" when their runners are too old to look for the tool, or
   * "Not installed".
   */
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
  /**
   * The machines by version, newest first, then versions with no known order,
   * then "Not looked for", then "Not installed".
   */
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
  /**
   * "Not installed: terraform, dotnet", naming the toolchains the runner
   * looked for and did not find. `null` when it found every one it looked for.
   */
  readonly notInstalledText: string | null;
  /**
   * "This runner is too old to look for node, pnpm: update it to see them.",
   * naming the probed toolchains the runner did not look for. `null` when it
   * looked for all of them.
   */
  readonly notProbedText: string | null;
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
const NOT_PROBED_TEXT = "Unknown";
const NOT_PROBED_GROUP = "Not looked for";

/**
 * The toolchains a runner built before the probed list grew looked for. Its
 * facts have no `probedToolchains`, so this is what absent means.
 */
const OLDEST_PROBED_TOOLCHAINS: readonly string[] = ["git", "gh"];

/** How one installed (or missing) tool on one machine ranks against its latest release. */
type Standing =
  | { readonly kind: "not-installed" | "unknown-version"; readonly isOlder: false }
  | {
      readonly kind: "latest" | "older" | "below-floor" | "version";
      /** The version the machine has, which the cell draws. */
      readonly version: string;
      /**
       * Whether a newer release exists than the machine's version. True for
       * `older`, and also for a `below-floor` version that is older than the
       * latest release: the update count includes it, the cell shows the floor.
       */
      readonly isOlder: boolean;
    };

const NOT_INSTALLED: Standing = { kind: "not-installed", isOlder: false };
const UNKNOWN_VERSION: Standing = { kind: "unknown-version", isOlder: false };

/** Ranks a known version against the latest release. `version` when the order is not known. */
const rankAgainstLatest = (version: string, latest: string | null): Standing => {
  const order = latest === null ? undefined : compareReleaseVersions(version, latest);
  if (order === undefined) return { kind: "version", version, isOlder: false };
  return order === -1
    ? { kind: "older", version, isOlder: true }
    : { kind: "latest", version, isOlder: false };
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
    ? { kind: "below-floor", version: onMachine.version, isOlder: ranked.isOlder }
    : ranked;
};

/**
 * Describes the failed read of a harness's latest release in two sentences.
 * The stored error is its own sentence, so its capital letter is correct.
 * `hasVersion` says whether an earlier read succeeded. Returns `null` when the
 * last read did not fail.
 */
const describeReadFailure = (
  release: HarnessLatestRelease | null,
  hasVersion: boolean,
): string | null => {
  if (release?.error == null) return null;
  const reason = release.error.replace(/\.$/, "");
  return hasVersion
    ? `The last check for a newer release failed. ${reason}.`
    : `No release read yet: the last check failed. ${reason}.`;
};

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

const buildCell = (standing: Standing, isAway: boolean): SoftwareCell => ({
  kind: standing.kind,
  text:
    "version" in standing
      ? standing.version
      : standing.kind === "not-installed"
        ? "Not installed"
        : "Installed",
  tooltip:
    standing.kind === "below-floor"
      ? BELOW_FLOOR_TOOLTIP
      : standing.kind === "unknown-version"
        ? UNKNOWN_VERSION_TOOLTIP
        : null,
  isAway,
});

/**
 * Builds the cell of a toolchain nobody looked for. The tooltip depends on
 * why: a runner that has not reported yet has looked at nothing, while a
 * runner that has reported but is too old does not know the tool.
 */
const buildNotProbedCell = (
  toolchain: string,
  hasReported: boolean,
  isAway: boolean,
): SoftwareCell => ({
  kind: "not-probed",
  text: NOT_PROBED_TEXT,
  tooltip: hasReported
    ? `This machine's runner is too old to look for ${toolchain}. Update it to see it.`
    : "This machine has not reported its tools yet.",
  isAway,
});

/**
 * Returns the names of the toolchains the machine's runner looked for. A
 * runner without `probedToolchains` is older than the list and looked for
 * `git` and `gh` only. A runner that has sent no facts yet has looked for
 * nothing, so none of its tools can be called not installed.
 */
const listProbedToolchains = (runner: Runner): readonly string[] =>
  runner.facts === null ? [] : (runner.facts.probedToolchains ?? OLDEST_PROBED_TOOLCHAINS);

/**
 * Groups the machines of a row by the version their cell shows. The groups
 * run newest first by `compareReleaseVersions`, then the versions with no
 * known order in the order they first appear, then "Not looked for", then
 * "Not installed".
 */
const groupMachinesByVersion = (
  columns: readonly SoftwareColumn[],
  cells: readonly SoftwareCell[],
): readonly SoftwareVersionGroup[] => {
  const byText = new Map<string, string[]>();
  const missing: string[] = [];
  const notProbed: string[] = [];
  cells.forEach((cell, index) => {
    const name = columns[index]!.name;
    if (cell.kind === "not-installed" || cell.kind === "not-probed") {
      (cell.kind === "not-installed" ? missing : notProbed).push(name);
      return;
    }
    const group = byText.get(cell.text);
    if (group === undefined) byText.set(cell.text, [name]);
    else group.push(name);
  });
  const ordered: SoftwareVersionGroup[] = [];
  const unordered: SoftwareVersionGroup[] = [];
  for (const [text, machines] of byText) {
    (isReleaseVersion(text) ? ordered : unordered).push({ text, machines });
  }
  ordered.sort((a, b) => -(compareReleaseVersions(a.text, b.text) ?? 0));
  return [
    ...ordered,
    ...unordered,
    ...(notProbed.length === 0 ? [] : [{ text: NOT_PROBED_GROUP, machines: notProbed }]),
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
  const latestVersion = release?.version ?? null;
  const failure = describeReadFailure(release, latestVersion !== null);
  const checkedAt = formatCheckedAt(release, timezone, today);
  const byRunner = new Map(harness.runners.map((entry) => [entry.runnerId, entry]));
  const cells = columns.map((column) => {
    const onMachine = byRunner.get(column.runnerId);
    return buildCell(rankHarness(onMachine, latestVersion), column.isAway);
  });
  const checked = checkedAt === null ? "" : `, checked ${checkedAt}`;
  const releaseLine = latestVersion === null ? null : `Latest release ${latestVersion}${checked}.`;
  // With no release read yet, the failure sentence already says so.
  const latestLine =
    releaseLine === null
      ? (failure ?? "Not checked yet.")
      : failure === null
        ? releaseLine
        : `${releaseLine} ${failure}`;
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
    latestLine,
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
    `Latest release ${controllerVersion}, this controller's version: a runner updates to its controller's version.`,
    machines.map((runner, index) =>
      buildCell(rankRunner(runner, controllerVersion), columns[index]!.isAway),
    ),
  );

  const reports = machines.map((runner) => ({
    versions: new Map((runner.facts?.toolchains ?? []).map((tool) => [tool.name, tool.version])),
    probed: new Set(listProbedToolchains(runner)),
    hasReported: runner.facts !== null,
  }));
  const toolchainRows = PROBED_TOOLCHAINS.map((name) =>
    buildRow(
      columns,
      name,
      name,
      { text: "Not tracked", tone: "faint", note: null, tooltip: NOT_TRACKED_TEXT },
      NOT_TRACKED_TEXT,
      columns.map((column, index) => {
        const { versions, probed, hasReported } = reports[index]!;
        const version = versions.get(name);
        // A tool that was found is shown whatever the list of probed tools says.
        if (version !== undefined) {
          return buildCell({ kind: "version", version, isOlder: false }, column.isAway);
        }
        return probed.has(name)
          ? buildCell(NOT_INSTALLED, column.isAway)
          : buildNotProbedCell(name, hasReported, column.isAway);
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
        harness.latestRelease?.version ?? null,
      ).isOlder,
  ).length;
  const count = outdatedHarnesses + (rankRunner(runner, controllerVersion).isOlder ? 1 : 0);
  return count === 0 ? null : `${String(count)} ${plural(count, "update", "updates")}`;
};

/**
 * Lists the toolchains found on a machine with their versions, for the Tools
 * part of its page, in the order the runner reported them (the runner reports
 * in the order of the probed list). The two texts split the probed
 * toolchains that were not found:
 *
 * - `notInstalledText` names those the runner looked for ("Not installed:
 *   terraform, dotnet").
 * - `notProbedText` names those a runner too old to know them did not look
 *   for.
 *
 * A runner that has not reported its facts has no tools and no text.
 */
export const listMachineTools = (runner: Runner): MachineTools => {
  if (runner.facts === null) return { tools: [], notInstalledText: null, notProbedText: null };
  const tools = runner.facts.toolchains.map(({ name, version }) => ({ name, version }));
  const found = new Set(tools.map((tool) => tool.name));
  const probed = new Set(listProbedToolchains(runner));
  const missing = PROBED_TOOLCHAINS.filter((name) => !found.has(name));
  const notInstalled = missing.filter((name) => probed.has(name));
  const notProbed = missing.filter((name) => !probed.has(name));
  return {
    tools,
    notInstalledText:
      notInstalled.length === 0 ? null : `Not installed: ${notInstalled.join(", ")}`,
    notProbedText:
      notProbed.length === 0
        ? null
        : `This runner is too old to look for ${notProbed.join(", ")}: update it to see ${notProbed.length === 1 ? "it" : "them"}.`,
  };
};
