/**
 * Tests how the Software section of a machine's page draws its Tools part
 * from a `MachineTools` value. Which tools a machine has, and in which order,
 * is decided by `listMachineTools` in `@hercule/client-core/software`; the
 * machine page's integration test covers the section read from a runner.
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { MachineTools } from "@hercule/client-core/software";
import { MachinePageSoftware } from "./machine-page-software";

const renderSoftware = (tools: MachineTools, isAway = false): HTMLElement => {
  render(
    <MachinePageSoftware
      id="software"
      harnesses={[]}
      accounts={[]}
      tools={tools}
      isAway={isAway}
      onSignIn={() => undefined}
    />,
  );
  return screen.getByRole("region", { name: "Software" });
};

describe("the Tools part of a machine's Software section", () => {
  it("lists the tools as given, each with its version, then the faint line of the missing ones", () => {
    const section = renderSoftware({
      tools: [
        { name: "git", version: "2.47.0" },
        { name: "node", version: "22.11.0" },
      ],
      notInstalledText: "Not installed: terraform, dotnet",
    });

    const rows = within(within(section).getByRole("list", { name: "Tools" })).getAllByRole(
      "listitem",
    );
    expect(rows.map((row) => row.textContent)).toEqual(["git2.47.0", "node22.11.0"]);
    expect(within(section).getByRole("heading", { name: "Tools" })).toBeTruthy();
    const missing = within(section).getByText("Not installed: terraform, dotnet");
    expect(
      missing.compareDocumentPosition(rows[1]!) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
  });

  it("keeps a long raw version whole in its tooltip", () => {
    const raw = "go version go1.25.3 darwin/arm64 with a long suffix";
    const section = renderSoftware({
      tools: [{ name: "go", version: raw }],
      notInstalledText: null,
    });

    expect(within(section).getByTitle(raw).textContent).toBe(raw);
    expect(within(section).queryByText(/^Not installed/)).toBeNull();
  });

  it("shows only the missing line under the heading when no tool was found", () => {
    const section = renderSoftware({ tools: [], notInstalledText: "Not installed: git, gh" });

    expect(within(section).queryByRole("list", { name: "Tools" })).toBeNull();
    expect(within(section).getByRole("heading", { name: "Tools" })).toBeTruthy();
    expect(within(section).getByText("Not installed: git, gh")).toBeTruthy();
  });

  it("leaves the part out when there is nothing to show", () => {
    const section = renderSoftware({ tools: [], notInstalledText: null });

    expect(within(section).queryByRole("heading", { name: "Tools" })).toBeNull();
  });

  it("marks the versions muted while the machine is away", () => {
    const section = renderSoftware(
      { tools: [{ name: "git", version: "2.47.0" }], notInstalledText: null },
      true,
    );

    expect(within(section).getByText("2.47.0").className).toContain("is-muted");
  });
});
