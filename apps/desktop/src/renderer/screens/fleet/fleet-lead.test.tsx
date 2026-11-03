/**
 * Tests how the Fleet page's lead is laid out. The words themselves are
 * decided by `describeFleetPage` in `@hercule/client-core/fleet`.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FleetPageLead } from "./fleet-lead";

describe("FleetPageLead", () => {
  it("draws the headline above the line of totals", () => {
    render(
      <FleetPageLead
        lead={{
          headline: [{ text: "Every machine is healthy.", kind: "plain" }],
          detail: [{ text: "No machine is online.", kind: "plain" }],
        }}
      />,
    );

    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Every machine is healthy.");
    expect(screen.getByText("No machine is online.").tagName).toBe("P");
  });

  it("draws no line of totals under a headline that has none", () => {
    const { container } = render(
      <FleetPageLead
        lead={{ headline: [{ text: "No machine has joined yet.", kind: "plain" }], detail: [] }}
      />,
    );

    expect(container.querySelector("p")).toBeNull();
  });
});
