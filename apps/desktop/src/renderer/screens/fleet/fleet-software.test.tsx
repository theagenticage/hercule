/**
 * Tests how the Software section draws a `FleetSoftware` value: each kind of
 * cell, the Latest column, a tool's detail opening in place, a machine's
 * column head, and the key. What each cell says is decided by
 * `describeFleetSoftware` in `@hercule/client-core/software`; these tests hand
 * the section finished values.
 */
import { useState, type JSX } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FleetSoftware, SoftwareCell, SoftwareRow } from "@hercule/client-core/software";
import { FleetSoftwarePanel } from "./fleet-software";

const COLUMNS = [
  { runnerId: "runner-atlas", name: "atlas", isAway: false },
  { runnerId: "runner-mini", name: "mini", isAway: true },
] as const;

const buildCell = (
  kind: SoftwareCell["kind"],
  text: string,
  over: Partial<SoftwareCell> = {},
): SoftwareCell => ({ kind, text, tooltip: null, isAway: false, ...over });

const buildRow = (key: string, name: string, cells: readonly SoftwareCell[]): SoftwareRow => ({
  key,
  name,
  latest: { text: "2.0.84", tone: "ink", note: null, tooltip: null },
  cells,
  detail: {
    description: "Runs Claude models.",
    latestLine: "Latest release 2.0.84, checked 09:00.",
    versions: [
      { text: "2.0.84", machines: ["atlas"] },
      { text: "2.0.78", machines: ["mini"] },
    ],
  },
});

const SOFTWARE: FleetSoftware = {
  columns: COLUMNS,
  groups: [
    {
      name: "Harnesses",
      rows: [
        buildRow("claude-code/claude-code", "Claude Code", [
          buildCell("latest", "2.0.84"),
          buildCell("older", "2.0.78", { isAway: true }),
        ]),
        {
          ...buildRow("codex/codex", "Codex", [
            buildCell("below-floor", "0.9.0", { tooltip: "Too old for this Hercule: update it" }),
            buildCell("not-installed", "Not installed", { isAway: true }),
          ]),
          latest: {
            text: "0.46.0",
            tone: "ink",
            note: "checked 09:00",
            tooltip: "The check failed.",
          },
        },
        buildRow("pi/pi", "pi", [
          buildCell("unknown-version", "Installed", {
            tooltip: "The version of this tool is not known yet.",
          }),
          buildCell("version", "0.9.2", { isAway: true }),
        ]),
      ],
    },
    {
      name: "Toolchains",
      rows: [
        {
          ...buildRow("go", "go", [
            buildCell("version", "go1.25.3 linux/arm64"),
            buildCell("not-installed", "Not installed", { isAway: true }),
          ]),
          latest: {
            text: "Not tracked",
            tone: "faint",
            note: null,
            tooltip: "Hercule does not follow this tool's releases yet.",
          },
          detail: {
            description: null,
            latestLine: "Hercule does not follow this tool's releases yet.",
            versions: [{ text: "go1.25.3 linux/arm64", machines: ["atlas"] }],
          },
        },
      ],
    },
  ],
};

/** Renders the section with an open row it keeps, as the Fleet page does. */
function Panel({
  software = SOFTWARE,
  onOpenMachine,
}: {
  readonly software?: FleetSoftware;
  readonly onOpenMachine: (runnerId: string) => void;
}): JSX.Element {
  const [openKey, setOpenKey] = useState<string | null>(null);
  return (
    <FleetSoftwarePanel
      software={software}
      openKey={openKey}
      onToggle={(key) => setOpenKey((current) => (current === key ? null : key))}
      onOpenMachine={onOpenMachine}
    />
  );
}

const renderPanel = (software: FleetSoftware = SOFTWARE) => {
  const onOpenMachine = vi.fn();
  render(<Panel software={software} onOpenMachine={onOpenMachine} />);
  return { onOpenMachine, table: screen.getByRole("table", { name: "Software on each machine" }) };
};

/** Returns the row of the tool `name`, found by its name button. */
const getToolRow = (table: HTMLElement, name: string): HTMLElement =>
  within(table)
    .getAllByRole("row")
    .find((row) => within(row).queryByRole("button", { name }) !== null)!;

describe("FleetSoftwarePanel", () => {
  it("heads the grid with Tool, Latest and one button per machine, and groups the tools", () => {
    const { table } = renderPanel();

    expect(screen.getByRole("heading", { level: 2, name: "Software" })).toBeTruthy();
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((head) => head.textContent),
    ).toEqual(["Tool", "Latest", "atlas", "mini"]);
    expect(
      within(table)
        .getAllByRole("rowheader")
        .map((head) => head.textContent),
    ).toEqual(["Harnesses", "Claude Code", "Codex", "pi", "Toolchains", "go"]);
  });

  it("opens a machine from its column head", async () => {
    const user = userEvent.setup();
    const { onOpenMachine, table } = renderPanel();

    await user.click(within(table).getByRole("button", { name: "Open mini at Software" }));

    expect(onOpenMachine).toHaveBeenCalledExactlyOnceWith("runner-mini");
  });

  it("mutes the head of a machine that is away", () => {
    const { table } = renderPanel();

    expect(
      within(table).getByRole("button", { name: "Open atlas at Software" }).className,
    ).not.toContain("is-away");
    expect(
      within(table).getByRole("button", { name: "Open mini at Software" }).className,
    ).toContain("is-away");
  });

  describe("the cells", () => {
    /** Returns the cells of the tool `name` after its Latest cell, one per machine. */
    const getMachineCells = (table: HTMLElement, name: string): HTMLElement[] =>
      within(getToolRow(table, name)).getAllByRole("cell").slice(1);

    it("draws a check for the latest version, named by the version", () => {
      const { table } = renderPanel();

      const [atlas] = getMachineCells(table, "Claude Code");

      expect(atlas!.className).toContain("is-latest");
      expect(atlas!.querySelector("svg")).not.toBeNull();
      expect(atlas!.textContent).toBe("");
      expect(within(atlas!).getByRole("img", { name: "2.0.84" })).toBeTruthy();
      expect(atlas!.title).toBe("2.0.84");
    });

    it("draws an older version as text, and a version below the floor with its tooltip", () => {
      const { table } = renderPanel();

      const [, mini] = getMachineCells(table, "Claude Code");
      const [atlas] = getMachineCells(table, "Codex");

      expect(mini!.className).toContain("is-older");
      expect(mini!.textContent).toBe("2.0.78");
      expect(atlas!.className).toContain("is-below-floor");
      expect(atlas!.textContent).toBe("0.9.0");
      expect(atlas!.title).toBe("Too old for this Hercule: update it");
    });

    it("draws a short dash for a tool that is not installed, and says so to assistive technology", () => {
      const { table } = renderPanel();

      const [, mini] = getMachineCells(table, "Codex");

      expect(mini!.className).toContain("is-not-installed");
      expect(mini!.textContent).toBe("–");
      expect(within(mini!).getByRole("img", { name: "Not installed" })).toBeTruthy();
    });

    it("draws Installed, with its tooltip, for a version that is not known", () => {
      const { table } = renderPanel();

      const [atlas] = getMachineCells(table, "pi");

      expect(atlas!.className).toContain("is-unknown-version");
      expect(atlas!.textContent).toBe("Installed");
      expect(atlas!.title).toBe("The version of this tool is not known yet.");
    });

    it("draws the version of a machine that is away as muted text, a latest one too, and keeps a dash a dash", () => {
      const { table } = renderPanel({
        ...SOFTWARE,
        groups: [
          {
            name: "Harnesses",
            rows: [
              buildRow("claude-code/claude-code", "Claude Code", [
                buildCell("latest", "2.0.84", { isAway: true }),
                buildCell("below-floor", "0.9.0", {
                  isAway: true,
                  tooltip: "Too old for this Hercule: update it",
                }),
              ]),
              buildRow("codex/codex", "Codex", [
                buildCell("version", "go1.25.3", { isAway: true }),
                buildCell("not-installed", "Not installed", { isAway: true }),
              ]),
            ],
          },
        ],
      });

      const [latest, belowFloor] = getMachineCells(table, "Claude Code");
      const [version, missing] = getMachineCells(table, "Codex");

      expect(latest!.textContent).toBe("2.0.84");
      expect(latest!.querySelector("svg")).toBeNull();
      expect(belowFloor!.textContent).toBe("0.9.0");
      expect(version!.textContent).toBe("go1.25.3");
      expect(missing!.textContent).toBe("–");
    });

    it("draws Unknown, with its tooltip, for a toolchain the machine's runner is too old to look for", () => {
      const tooltip = "This machine's runner is too old to look for go. Update it to see it.";
      const { table } = renderPanel({
        ...SOFTWARE,
        groups: [
          {
            name: "Toolchains",
            rows: [
              buildRow("go", "go", [
                buildCell("not-probed", "Unknown", { tooltip }),
                buildCell("version", "1.25.3"),
              ]),
            ],
          },
        ],
      });

      const [atlas] = getMachineCells(table, "go");

      expect(atlas!.className).toContain("is-not-probed");
      expect(atlas!.textContent).toBe("Unknown");
      expect(atlas!.title).toBe(tooltip);
    });

    it("draws a raw version whole in its tooltip, and mutes the cells of a machine that is away", () => {
      const { table } = renderPanel();

      const [atlas] = getMachineCells(table, "go");
      const [, away] = getMachineCells(table, "pi");

      expect(atlas!.className).toContain("is-version");
      expect(atlas!.title).toBe("go1.25.3 linux/arm64");
      expect(away!.className).toContain("is-away");
      expect(atlas!.className).not.toContain("is-away");
    });
  });

  describe("the Latest column", () => {
    it("draws the version, the note after it, and the tooltip of a failed check", () => {
      const { table } = renderPanel();

      const latest = within(getToolRow(table, "Codex")).getAllByRole("cell")[0]!;

      expect(latest.textContent).toBe("0.46.0checked 09:00");
      expect(within(latest).getByText("checked 09:00")).toBeTruthy();
      expect(latest.title).toBe("The check failed.");
    });

    it("draws a tool whose releases are not followed in the faint tone", () => {
      const { table } = renderPanel();

      const latest = within(getToolRow(table, "go")).getAllByRole("cell")[0]!;

      expect(latest.textContent).toBe("Not tracked");
      expect(latest.className).toContain("is-faint");
    });
  });

  describe("a tool's detail", () => {
    it("opens in place under its row when the name is pressed, and closes when it is pressed again", async () => {
      const user = userEvent.setup();
      const { table } = renderPanel();
      const name = within(table).getByRole("button", { name: "Claude Code" });
      expect(name.getAttribute("aria-expanded")).toBe("false");
      expect(within(table).queryByText("Runs Claude models.")).toBeNull();

      await user.click(name);

      expect(name.getAttribute("aria-expanded")).toBe("true");
      const detail = document.getElementById(name.getAttribute("aria-controls")!)!;
      expect(within(detail).getByText("Runs Claude models.")).toBeTruthy();
      expect(within(detail).getByText("Latest release 2.0.84, checked 09:00.")).toBeTruthy();
      // The detail is the row right after the tool's own.
      expect(getToolRow(table, "Claude Code").nextElementSibling).toBe(detail);

      await user.click(name);

      expect(name.getAttribute("aria-expanded")).toBe("false");
      expect(within(table).queryByText("Runs Claude models.")).toBeNull();
    });

    it("lists the machines by version", async () => {
      const user = userEvent.setup();
      const { table } = renderPanel();

      await user.click(within(table).getByRole("button", { name: "Claude Code" }));

      const detail = document.querySelector<HTMLElement>(".fleet-sw-detail")!;
      expect([...detail.querySelectorAll("dl > div")].map((group) => group.textContent)).toEqual([
        "2.0.84atlas",
        "2.0.78mini",
      ]);
    });

    it("opens one tool at a time", async () => {
      const user = userEvent.setup();
      const { table } = renderPanel();

      await user.click(within(table).getByRole("button", { name: "Claude Code" }));
      await user.click(within(table).getByRole("button", { name: "Codex" }));

      expect(
        within(table).getByRole("button", { name: "Claude Code" }).getAttribute("aria-expanded"),
      ).toBe("false");
      expect(
        within(table).getByRole("button", { name: "Codex" }).getAttribute("aria-expanded"),
      ).toBe("true");
      expect(document.querySelectorAll(".fleet-sw-detail")).toHaveLength(1);
    });

    it("leaves out the description of a tool that has none", async () => {
      const user = userEvent.setup();
      const { table } = renderPanel();

      await user.click(within(table).getByRole("button", { name: "go" }));

      const detail = document.querySelector<HTMLElement>(".fleet-sw-detail")!;
      expect(detail.querySelector(".fleet-sw-blurb")).toBeNull();
      expect(
        within(detail).getByText("Hercule does not follow this tool's releases yet."),
      ).toBeTruthy();
    });
  });

  it("keeps its heading and says Software shows once a machine has joined, in place of the grid and the key, when there are no machines", () => {
    render(
      <FleetSoftwarePanel
        software={{ columns: [], groups: [] }}
        openKey={null}
        onToggle={() => undefined}
        onOpenMachine={() => undefined}
      />,
    );

    expect(screen.getByRole("heading", { level: 2, name: "Software" })).toBeTruthy();
    expect(screen.getByText("Software shows here once a machine has joined.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(document.querySelector(".fleet-sw-key")).toBeNull();
  });

  it("explains the cells in a key under the grid, and offers nothing to install or update", () => {
    renderPanel();

    const key = document.querySelector<HTMLElement>(".fleet-sw-key")!;

    expect(key.textContent).toBe(" latest1.2.3 older– not installed");
    expect(screen.queryByRole("button", { name: /update|install/i })).toBeNull();
  });
});
