import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  FleetHeader,
  type FleetHeaderPlace,
  type FleetSection,
  type FleetSectionJumps,
} from "./fleet-header";

const MACHINE = { name: "atlas", kind: "server" } as const;

const FLEET_SECTIONS: ReadonlyArray<FleetSection> = [
  { id: "machines", label: "Machines", count: { text: "2 need you", isYou: true } },
  { id: "software", label: "Software", count: { text: "up to date", isYou: false } },
];

/**
 * Renders the header in a router that has the routes its crumbs link to.
 * `buildPlace` gets the jump links the page carries and returns the place.
 */
const renderHeader = async (
  buildPlace: (jumps: FleetSectionJumps) => FleetHeaderPlace = (jumps) => ({
    page: "fleet",
    ...jumps,
  }),
  {
    sections = FLEET_SECTIONS,
    activeSectionId = "machines",
  }: { sections?: ReadonlyArray<FleetSection>; activeSectionId?: string | null } = {},
) => {
  const onJump = vi.fn();
  const onAddMachine = vi.fn();
  const place = buildPlace({ sections, activeSectionId, onJump });
  const rootRoute = createRootRoute({
    component: () => <FleetHeader place={place} onAddMachine={onAddMachine} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/fleet" }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/fleet"] }),
  });
  render(<RouterProvider router={router} />);
  await screen.findByRole("navigation", { name: "Fleet" });
  return { onJump, onAddMachine };
};

describe("FleetHeader", () => {
  it("titles the Fleet page 'Fleet' and lights the section in view", async () => {
    await renderHeader();
    expect(screen.getByRole("heading", { name: "Fleet" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Machines 2 need you" }).ariaCurrent).toBe(
      "location",
    );
    expect(screen.getByRole("button", { name: "Software up to date" }).ariaCurrent).toBeNull();
  });

  it("calls onJump with the section pressed", async () => {
    const { onJump } = await renderHeader();
    await userEvent.click(screen.getByRole("button", { name: /Software/ }));
    expect(onJump).toHaveBeenCalledExactlyOnceWith("software");
  });

  it("calls onAddMachine on every page", async () => {
    const { onAddMachine } = await renderHeader(
      (jumps) => ({ page: "machine", machine: MACHINE, ...jumps }),
      { sections: [], activeSectionId: null },
    );
    await userEvent.click(screen.getByRole("button", { name: "Add a machine" }));
    expect(onAddMachine).toHaveBeenCalledOnce();
  });

  it("names a machine's page by the crumb 'Fleet', a link back, then the machine", async () => {
    await renderHeader((jumps) => ({ page: "machine", machine: MACHINE, ...jumps }), {
      sections: [{ id: "capacity", label: "Capacity" }],
      activeSectionId: null,
    });
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByRole("link", { name: "Fleet" }).getAttribute("href")).toBe("/fleet");
    expect(screen.getByText("atlas").closest(".ptab")?.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Capacity" })).toBeTruthy();
  });

  it("names the activity page by the crumbs 'Fleet', the machine, then 'Activity', with no jump links", async () => {
    await renderHeader(() => ({ page: "activity", runnerId: "r-1", machine: MACHINE }));
    expect(screen.getByRole("link", { name: "Fleet" }).getAttribute("href")).toBe("/fleet");
    expect(screen.getByRole("link", { name: "atlas" }).getAttribute("href")).toBe("/fleet/r-1");
    expect(screen.getByText("Activity").getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("button", { name: /Machines|Software/ })).toBeNull();
  });
});
