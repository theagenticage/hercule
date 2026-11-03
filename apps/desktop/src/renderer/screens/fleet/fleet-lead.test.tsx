/**
 * Tests how the Fleet page's lead draws the parts of its sentences. The words
 * themselves are decided by `describeFleet` in `@hercule/client-core/fleet`.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { describeFleet } from "@hercule/client-core/fleet";
import { BUSY_MACHINE, FULL_DISK_MACHINE, OFFLINE_MACHINE } from "./fleet.testing";
import { FleetPageLead } from "./fleet-lead";

describe("FleetPageLead", () => {
  it("draws the count of machines that need the user in the you ink and the numbers in bold", () => {
    render(
      <FleetPageLead lead={describeFleet([BUSY_MACHINE, FULL_DISK_MACHINE, OFFLINE_MACHINE])} />,
    );

    expect(screen.getByText("Three").classList.contains("is-you")).toBe(true);
    expect(screen.getByText("14", { selector: "b" })).toBeTruthy();
  });

  it("draws no line of totals under a headline that has none", () => {
    const lead = describeFleet([]);
    expect(lead.detail).toHaveLength(0);

    const { container } = render(<FleetPageLead lead={lead} />);

    expect(container.querySelector("p")).toBeNull();
  });
});
