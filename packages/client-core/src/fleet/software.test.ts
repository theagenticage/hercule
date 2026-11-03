import { Struct } from "effect";
import { describe, expect, it } from "vitest";
import type { Harness, HarnessOnRunner, Runner } from "@hercule/contract";
import { PROBED_TOOLCHAINS } from "@hercule/contract";
import { BARE, HARNESSES } from "../providers.testing";
import {
  describeFleetSoftware,
  describeMachineUpdates,
  listMachineTools,
  type FleetSoftware,
  type SoftwareCell,
  type SoftwareRow,
} from "./software";

/**
 * The facts of a runner built before the probed list was reported: it sends
 * no `probedToolchains`, and looked for `git` and `gh` only.
 */
const OLD_FACTS = Struct.omit(BARE.facts!, ["probedToolchains"]);

const TIMEZONE = "UTC";
const TODAY = new Date("2026-11-02T14:00:00.000Z");
const CONTROLLER = "0.4.2";
const CLAUDE = "claude-code/claude-code";

const ATLAS = {
  ...BARE,
  id: "01a06d02-0001-7000-8000-000000000001",
  name: "atlas",
  version: "0.4.2",
};
const MOSS = {
  ...BARE,
  id: "01a06d02-0002-7000-8000-000000000002",
  name: "moss",
  version: "0.4.2",
};

const buildRunner = (base: Runner, overrides: Partial<Runner> = {}): Runner => ({
  ...base,
  ...overrides,
});

const onMachine = (runner: Runner, overrides: Partial<HarnessOnRunner> = {}): HarnessOnRunner => ({
  runnerId: runner.id,
  installed: true,
  version: "2.1.90",
  versionVerdict: "ok",
  ...overrides,
});

/** Returns the shipped harnesses with Claude Code changed by `overrides`. */
const withClaude = (overrides: Partial<Harness>): readonly Harness[] =>
  HARNESSES.map((harness) => (harness.id === CLAUDE ? { ...harness, ...overrides } : harness));

const describeGrid = (
  runners: readonly Runner[],
  harnesses: readonly Harness[] = HARNESSES,
  controllerVersion = CONTROLLER,
): FleetSoftware => describeFleetSoftware(runners, harnesses, controllerVersion, TIMEZONE, TODAY);

const findRow = (grid: FleetSoftware, key: string): SoftwareRow => {
  const row = grid.groups.flatMap((group) => group.rows).find((candidate) => candidate.key === key);
  if (row === undefined) throw new Error(`no row ${key}`);
  return row;
};

const kindsOf = (row: SoftwareRow): readonly SoftwareCell["kind"][] =>
  row.cells.map((cell) => cell.kind);

const successfulRelease = { version: "2.1.90", checkedAt: "2026-11-02T09:00:00.000Z", error: null };

describe("describeFleetSoftware columns and groups", () => {
  it("has a column per machine in the order of the Fleet cards, without retired machines", () => {
    const retired = buildRunner(MOSS, { lifecycle: "retired" });
    const away = buildRunner(ATLAS, { connectivity: "unreachable" });
    const later = buildRunner(MOSS, { id: "01a06d02-0003-7000-8000-000000000003", name: "later" });

    const { columns } = describeGrid([later, retired, away]);

    expect(columns).toEqual([
      { runnerId: away.id, name: "atlas", isAway: true },
      { runnerId: later.id, name: "later", isAway: false },
    ]);
  });

  it("lists the runner and then each harness, then the probed toolchains in order", () => {
    const { groups } = describeGrid([ATLAS]);

    expect(groups.map((group) => group.name)).toEqual(["Harnesses", "Toolchains"]);
    expect(groups[0]!.rows.map((row) => row.key)).toEqual([
      "runner",
      ...HARNESSES.map((harness) => harness.id),
    ]);
    expect(groups[0]!.rows[0]!.name).toBe("Hercule runner");
    expect(groups[1]!.rows.map((row) => row.key)).toEqual([...PROBED_TOOLCHAINS]);
  });

  it("has no cells when no machine is shown", () => {
    const grid = describeGrid([]);

    expect(grid.columns).toEqual([]);
    expect(findRow(grid, "runner").cells).toEqual([]);
  });
});

describe("describeFleetSoftware Latest", () => {
  const latestOf = (release: Harness["latestRelease"]) =>
    findRow(describeGrid([ATLAS], withClaude({ latestRelease: release })), CLAUDE).latest;

  it("says a harness was not checked yet before any read", () => {
    const expected = { text: "Not checked yet", tone: "muted", note: null, tooltip: null };

    expect(latestOf(null)).toEqual(expected);
    expect(latestOf({ version: null, checkedAt: null, error: null })).toEqual(expected);
  });

  it("shows the version after a successful read", () => {
    expect(latestOf(successfulRelease)).toEqual({
      text: "2.1.90",
      tone: "ink",
      note: null,
      tooltip: null,
    });
  });

  it("keeps the last good version with the time it was read when the latest read failed", () => {
    expect(latestOf({ ...successfulRelease, error: "GitHub answered 503" })).toEqual({
      text: "2.1.90",
      tone: "ink",
      note: "checked 09:00",
      tooltip: "The last check for a newer release failed. GitHub answered 503.",
    });
  });

  it("does not repeat the full stop of an error that ends in one", () => {
    expect(latestOf({ ...successfulRelease, error: "Timed out." }).tooltip).toBe(
      "The last check for a newer release failed. Timed out.",
    );
  });

  it("explains a failed read when no read has succeeded", () => {
    expect(latestOf({ version: null, checkedAt: null, error: "No network" })).toEqual({
      text: "Not checked yet",
      tone: "muted",
      note: null,
      tooltip: "No release read yet: the last check failed. No network.",
    });
  });

  it("is the controller's version for the runner", () => {
    expect(findRow(describeGrid([ATLAS]), "runner").latest).toEqual({
      text: CONTROLLER,
      tone: "ink",
      note: null,
      tooltip: null,
    });
  });

  it("is not tracked for a toolchain", () => {
    expect(findRow(describeGrid([ATLAS]), "git").latest).toEqual({
      text: "Not tracked",
      tone: "faint",
      note: null,
      tooltip: "Hercule does not follow this tool's releases yet.",
    });
  });
});

describe("describeFleetSoftware harness cells", () => {
  const cellsOf = (
    entries: readonly (HarnessOnRunner | undefined)[],
    latest: string | null = "2.1.90",
  ): readonly SoftwareCell[] => {
    const runners = [ATLAS, MOSS];
    const harnesses = withClaude({
      runners: entries.filter((entry) => entry !== undefined),
      latestRelease: latest === null ? null : { ...successfulRelease, version: latest },
    });
    return findRow(describeGrid(runners, harnesses), CLAUDE).cells;
  };

  it("marks the latest version and a newer one with the check, and an older one as older", () => {
    const cells = cellsOf([
      onMachine(ATLAS, { version: "2.1.90" }),
      onMachine(MOSS, { version: "2.1.89" }),
    ]);

    expect(cells.map((cell) => cell.kind)).toEqual(["latest", "older"]);
    expect(cells.map((cell) => cell.text)).toEqual(["2.1.90", "2.1.89"]);
    expect(cellsOf([onMachine(ATLAS, { version: "2.2.0" })])[0]!.kind).toBe("latest");
  });

  it("compares numbers, not text", () => {
    expect(cellsOf([onMachine(ATLAS, { version: "2.1.9" })], "2.1.10")[0]!.kind).toBe("older");
  });

  it("lets below-floor win over the comparison, and says why", () => {
    const [atlas, moss] = cellsOf(
      [
        onMachine(ATLAS, { version: "1.0.0", versionVerdict: "below-floor" }),
        onMachine(MOSS, { version: "9.0.0", versionVerdict: "below-floor" }),
      ],
      "2.1.90",
    );

    expect(atlas).toMatchObject({
      kind: "below-floor",
      text: "1.0.0",
      tooltip: "Too old for this Hercule: update it",
    });
    expect(moss!.kind).toBe("below-floor");
  });

  it("shows not installed for a harness the machine lacks or has no entry for", () => {
    const cells = cellsOf([onMachine(ATLAS, { installed: false, version: null })]);

    expect(cells.map((cell) => cell.kind)).toEqual(["not-installed", "not-installed"]);
    expect(cells[0]!.text).toBe("Not installed");
  });

  it("shows installed with an explaining tooltip when no version is known", () => {
    expect(cellsOf([onMachine(ATLAS, { version: null })])[0]).toMatchObject({
      kind: "unknown-version",
      text: "Installed",
      tooltip: "The version of this tool is not known yet.",
    });
  });

  it("shows the plain version when the latest release is not known or has no order", () => {
    expect(cellsOf([onMachine(ATLAS)], null)[0]!.kind).toBe("version");
    expect(cellsOf([onMachine(ATLAS)], "edge")[0]!.kind).toBe("version");
    expect(cellsOf([onMachine(ATLAS, { version: "2.43" })])[0]!.kind).toBe("version");
  });

  it("compares with the last good version after a failed read", () => {
    const harnesses = withClaude({
      runners: [onMachine(ATLAS, { version: "2.1.80" })],
      latestRelease: { ...successfulRelease, error: "offline" },
    });

    expect(kindsOf(findRow(describeGrid([ATLAS], harnesses), CLAUDE))).toEqual(["older"]);
  });

  it("carries whether the machine is away, so last known versions can be muted", () => {
    const away = buildRunner(MOSS, { connectivity: "offline" });
    const harnesses = withClaude({ runners: [onMachine(ATLAS), onMachine(away)] });

    expect(
      findRow(describeGrid([ATLAS, away], harnesses), CLAUDE).cells.map((c) => c.isAway),
    ).toEqual([false, true]);
  });
});

describe("describeFleetSoftware runner cells", () => {
  const kinds = (versions: readonly (string | null)[], controller = CONTROLLER) => {
    const runners = versions.map((version, index) =>
      buildRunner(ATLAS, { id: `01a06d02-000${String(index)}-7000-8000-000000000001`, version }),
    );
    return kindsOf(findRow(describeGrid(runners, [], controller), "runner"));
  };

  it("compares each runner with its controller's version", () => {
    expect(kinds(["0.4.2", "0.4.1", "0.5.0", "0.10.0"], "0.4.2")).toEqual([
      "latest",
      "older",
      "latest",
      "latest",
    ]);
  });

  it("shows a pre-release below its release", () => {
    expect(kinds(["0.4.2-rc.1"])).toEqual(["older"]);
  });

  it("shows installed when the version is unknown, and the plain version when it has no order", () => {
    expect(kinds([null, "dev"])).toEqual(["unknown-version", "version"]);
    expect(kinds(["0.4.2"], "edge")).toEqual(["version"]);
  });
});

describe("describeFleetSoftware toolchain cells", () => {
  const withTools = (base: Runner, tools: readonly { name: string; version: string }[]): Runner =>
    buildRunner(base, {
      facts: { ...BARE.facts!, toolchains: tools.map((tool) => ({ ...tool, path: "/bin/x" })) },
    });

  it("shows the version, never older or latest, however the machines compare", () => {
    const grid = describeGrid([
      withTools(ATLAS, [{ name: "node", version: "24.1.0" }]),
      withTools(MOSS, [{ name: "node", version: "18.0.0" }]),
    ]);

    expect(findRow(grid, "node").cells.map((cell) => [cell.kind, cell.text])).toEqual([
      ["version", "24.1.0"],
      ["version", "18.0.0"],
    ]);
    for (const row of grid.groups[1]!.rows) {
      for (const cell of row.cells) expect(["older", "latest"]).not.toContain(cell.kind);
    }
  });

  describe("on a runner too old to look for most tools", () => {
    // A runner built before the list grew sends no `probedToolchains` and
    // looked for git and gh only.
    const OLD = buildRunner(ATLAS, {
      facts: {
        ...OLD_FACTS,
        toolchains: [{ name: "git", version: "2.51.0", path: "/bin/git" }],
      },
    });
    const OLD_FOUND_BOTH = buildRunner(ATLAS, {
      facts: {
        ...OLD_FACTS,
        toolchains: [
          { name: "git", version: "2.51.0", path: "/bin/git" },
          { name: "gh", version: "2.80.0", path: "/bin/gh" },
        ],
      },
    });

    it("shows Unknown, not a dash, for every tool but git and gh", () => {
      const grid = describeGrid([OLD_FOUND_BOTH]);
      const others = PROBED_TOOLCHAINS.filter((name) => name !== "git" && name !== "gh");

      expect(kindsOf(findRow(grid, "git"))).toEqual(["version"]);
      expect(kindsOf(findRow(grid, "gh"))).toEqual(["version"]);
      for (const name of others) expect(kindsOf(findRow(grid, name))).toEqual(["not-probed"]);
      expect(others).toHaveLength(10);
      expect(findRow(grid, "node").cells[0]).toEqual({
        kind: "not-probed",
        text: "Unknown",
        tooltip: "This machine's runner is too old to look for node. Update it to see it.",
        isAway: false,
      });
    });

    it("still says git and gh are not installed when the old runner looked and found none", () => {
      expect(kindsOf(findRow(describeGrid([OLD]), "gh"))).toEqual(["not-installed"]);
    });

    it("shows a tool that was found whatever the probed list says", () => {
      const grid = describeGrid([
        buildRunner(ATLAS, {
          facts: {
            ...OLD_FACTS,
            toolchains: [{ name: "node", version: "24.1.0", path: "/bin/node" }],
          },
        }),
      ]);

      expect(findRow(grid, "node").cells[0]).toMatchObject({ kind: "version", text: "24.1.0" });
    });

    it("lists the machines under Not looked for, between the versions and Not installed", () => {
      const grid = describeGrid([OLD, withTools(MOSS, [{ name: "node", version: "24.1.0" }])]);
      const ZED = withTools(
        buildRunner(MOSS, { id: "01a06d02-0003-7000-8000-000000000003", name: "zed" }),
        [],
      );

      expect(findRow(grid, "node").detail.versions).toEqual([
        { text: "24.1.0", machines: ["moss"] },
        { text: "Not looked for", machines: ["atlas"] },
      ]);
      expect(findRow(describeGrid([OLD, MOSS, ZED]), "node").detail.versions).toEqual([
        { text: "Not looked for", machines: ["atlas"] },
        { text: "Not installed", machines: ["moss", "zed"] },
      ]);
    });
  });

  it("shows a dash for a toolchain the machine lacks", () => {
    const grid = describeGrid([withTools(ATLAS, [{ name: "git", version: "2.51.0" }]), MOSS]);

    expect(kindsOf(findRow(grid, "git"))).toEqual(["version", "not-installed"]);
    expect(kindsOf(findRow(grid, "gh"))).toEqual(["not-installed", "not-installed"]);
  });

  it("shows Unknown, with its own tooltip, for a machine that has not reported its facts", () => {
    const grid = describeGrid([buildRunner(ATLAS, { facts: null })]);

    expect(kindsOf(findRow(grid, "git"))).toEqual(["not-probed"]);
    expect(findRow(grid, "git").cells[0]).toMatchObject({
      text: "Unknown",
      tooltip: "This machine has not reported its tools yet.",
    });
    expect(findRow(grid, "git").detail.versions).toEqual([
      { text: "Not looked for", machines: ["atlas"] },
    ]);
  });
});

describe("describeFleetSoftware detail", () => {
  it("describes what a tool is, and nothing for a harness it does not know", () => {
    const stranger: Harness = { ...HARNESSES[0]!, id: "acme/acme", displayName: "Acme" };
    const grid = describeGrid([ATLAS], [...HARNESSES, stranger]);

    expect(findRow(grid, CLAUDE).detail.description).toBe("Runs Claude models.");
    expect(findRow(grid, "runner").detail.description).toBe("Hosts the sessions on a machine.");
    expect(findRow(grid, "git").detail.description).toBe("Every workspace is a git checkout.");
    expect(findRow(grid, "acme/acme").detail.description).toBeNull();
  });

  it("words the latest release and when it was checked", () => {
    const line = (release: Harness["latestRelease"]) =>
      findRow(describeGrid([ATLAS], withClaude({ latestRelease: release })), CLAUDE).detail
        .latestLine;

    expect(line(successfulRelease)).toBe("Latest release 2.1.90, checked 09:00.");
    expect(line(null)).toBe("Not checked yet.");
    expect(line({ ...successfulRelease, error: "offline" })).toBe(
      "Latest release 2.1.90, checked 09:00. The last check for a newer release failed. offline.",
    );
    expect(
      line({ version: null, checkedAt: null, error: "Could not reach the npm registry." }),
    ).toBe("No release read yet: the last check failed. Could not reach the npm registry.");
    const grid = describeGrid([ATLAS]);
    expect(findRow(grid, "runner").detail.latestLine).toBe(
      "Latest release 0.4.2, this controller's version: a runner updates to its controller's version.",
    );
    expect(findRow(grid, "git").detail.latestLine).toBe(
      "Hercule does not follow this tool's releases yet.",
    );
  });

  it("lists the machines by version, newest first, then unordered versions, then not installed", () => {
    const names = ["a", "b", "c", "d", "e", "f"];
    const runners = names.map((name, index) =>
      buildRunner(ATLAS, { id: `01a06d02-000${String(index)}-7000-8000-000000000001`, name }),
    );
    const versions = ["2.1.9", "2.1.10", "2.1.9", "weird", null, null];
    const harnesses = withClaude({
      runners: runners.map((runner, index) =>
        onMachine(runner, {
          installed: index !== 5,
          version: versions[index] ?? null,
        }),
      ),
    });

    expect(findRow(describeGrid(runners, harnesses), CLAUDE).detail.versions).toEqual([
      { text: "2.1.10", machines: ["b"] },
      { text: "2.1.9", machines: ["a", "c"] },
      { text: "weird", machines: ["d"] },
      { text: "Installed", machines: ["e"] },
      { text: "Not installed", machines: ["f"] },
    ]);
  });

  it("has no version groups when no machine is shown", () => {
    expect(findRow(describeGrid([]), CLAUDE).detail.versions).toEqual([]);
  });
});

describe("describeMachineUpdates", () => {
  const harnessesFor = (runner: Runner, entry: Partial<HarnessOnRunner>): readonly Harness[] =>
    withClaude({
      runners: [onMachine(runner, entry)],
      latestRelease: successfulRelease,
    });

  it("counts the runner and each harness older than its latest release", () => {
    const old = buildRunner(ATLAS, { version: "0.4.1" });

    expect(describeMachineUpdates(old, harnessesFor(old, { version: "2.1.89" }), CONTROLLER)).toBe(
      "2 updates",
    );
  });

  it("says 1 update in the singular", () => {
    const old = buildRunner(ATLAS, { version: "0.4.1" });

    expect(describeMachineUpdates(old, harnessesFor(old, { version: "2.1.90" }), CONTROLLER)).toBe(
      "1 update",
    );
    expect(
      describeMachineUpdates(ATLAS, harnessesFor(ATLAS, { version: "2.1.89" }), CONTROLLER),
    ).toBe("1 update");
  });

  it("is null when nothing is older", () => {
    expect(
      describeMachineUpdates(ATLAS, harnessesFor(ATLAS, { version: "2.2.0" }), CONTROLLER),
    ).toBeNull();
    expect(describeMachineUpdates(ATLAS, HARNESSES, CONTROLLER)).toBeNull();
  });

  it("counts a version below the floor that is also older than the latest release", () => {
    const harnesses = harnessesFor(ATLAS, { version: "1.0.0", versionVerdict: "below-floor" });

    expect(describeMachineUpdates(ATLAS, harnesses, CONTROLLER)).toBe("1 update");
  });

  it("does not count toolchains, unknown versions, versions with no order, or tools not installed", () => {
    const unknown = buildRunner(ATLAS, {
      version: null,
      facts: { ...BARE.facts!, toolchains: [{ name: "git", version: "1.0.0", path: "/bin/git" }] },
    });

    expect(
      describeMachineUpdates(unknown, harnessesFor(unknown, { version: null }), CONTROLLER),
    ).toBeNull();
    expect(
      describeMachineUpdates(unknown, harnessesFor(unknown, { version: "2.43" }), CONTROLLER),
    ).toBeNull();
    expect(
      describeMachineUpdates(
        unknown,
        harnessesFor(unknown, { installed: false, version: null }),
        CONTROLLER,
      ),
    ).toBeNull();
  });

  it("agrees with the grid on which cells are older", () => {
    const old = buildRunner(ATLAS, { version: "0.4.1" });
    const harnesses = harnessesFor(old, { version: "2.1.89" });
    const grid = describeGrid([old], harnesses);
    const olderRows = grid.groups
      .flatMap((group) => group.rows)
      .filter((row) => row.cells[0]!.kind === "older");

    expect(describeMachineUpdates(old, harnesses, CONTROLLER)).toBe(
      `${String(olderRows.length)} updates`,
    );
  });
});

describe("listMachineTools", () => {
  const withTools = (names: readonly string[]): Runner =>
    buildRunner(ATLAS, {
      facts: {
        ...BARE.facts!,
        toolchains: names.map((name) => ({ name, version: `${name}-1`, path: `/bin/${name}` })),
      },
    });

  it("lists the tools in the order reported, and names the missing ones that were looked for", () => {
    const { tools, notInstalledText, notProbedText } = listMachineTools(
      withTools(PROBED_TOOLCHAINS.filter((name) => name !== "terraform" && name !== "dotnet")),
    );

    expect(tools.map((tool) => tool.name)).toEqual(
      PROBED_TOOLCHAINS.filter((name) => name !== "terraform" && name !== "dotnet"),
    );
    expect(tools[0]).toEqual({ name: "git", version: "git-1" });
    expect(notInstalledText).toBe("Not installed: terraform, dotnet");
    expect(notProbedText).toBeNull();
  });

  it("keeps the reported order, even for a toolchain outside the list", () => {
    const { tools } = listMachineTools(withTools(["zig", "node", "deno", "git"]));

    expect(tools.map((tool) => tool.name)).toEqual(["zig", "node", "deno", "git"]);
  });

  it("has no Not installed text when every probed toolchain is there", () => {
    expect(listMachineTools(withTools(PROBED_TOOLCHAINS)).notInstalledText).toBeNull();
  });

  it("says a runner without a probed list is too old to look for the other ten tools", () => {
    const old = buildRunner(ATLAS, {
      facts: {
        ...OLD_FACTS,
        toolchains: [
          { name: "git", version: "2.51.0", path: "/bin/git" },
          { name: "gh", version: "2.80.0", path: "/bin/gh" },
        ],
      },
    });

    expect(listMachineTools(old)).toEqual({
      tools: [
        { name: "git", version: "2.51.0" },
        { name: "gh", version: "2.80.0" },
      ],
      notInstalledText: null,
      notProbedText:
        "This runner is too old to look for node, pnpm, bun, go, rustc, python3, uv, docker, terraform, dotnet: update it to see them.",
    });
  });

  it("has no tools and no text before the runner reported its facts", () => {
    expect(listMachineTools(buildRunner(ATLAS, { facts: null }))).toEqual({
      tools: [],
      notInstalledText: null,
      notProbedText: null,
    });
  });
});
