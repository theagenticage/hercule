/**
 * Tests how a machine's card puts its parts together. What each part says is
 * decided by `@hercule/client-core/fleet`; the route integration tests cover
 * pressing a card's buttons.
 */
import { describe, expect, it, vi } from "vitest";
import { render, within } from "@testing-library/react";
import type { FleetMachine } from "@hercule/client-core/fleet";
import {
  BUSY_MACHINE,
  DRAINING_MACHINE,
  FULL_DISK_MACHINE,
  NOW,
  OFFLINE_MACHINE,
  TIMEZONE,
} from "./fleet.testing";
import { MachineCard } from "./machine-card";
import { buildMachineTransitionName } from "./machine-transition";

const renderCard = (machine: FleetMachine): HTMLElement => {
  const { container } = render(
    <MachineCard
      machine={machine}
      timezone={TIMEZONE}
      now={NOW}
      allowPending={false}
      onOpen={vi.fn()}
      onAllow={vi.fn()}
    />,
  );
  return container.firstElementChild as HTMLElement;
};

describe("MachineCard", () => {
  it("carries its machine's view transition name, the one the machine's page head carries", () => {
    const card = renderCard(BUSY_MACHINE);

    expect(card.style.getPropertyValue("view-transition-name")).toBe(
      buildMachineTransitionName("runner-busy"),
    );
  });

  it("names a machine told to take no new work once, in its status, and not again as its room", () => {
    const card = renderCard(DRAINING_MACHINE);

    expect(within(card).getAllByText("Takes no new work")).toHaveLength(1);
  });

  it("shows no room for a machine whose disk is below its limit, because its need line says so", () => {
    const card = renderCard(FULL_DISK_MACHINE);

    expect(within(card).queryByText(/^Room for|^Full$|^Takes no new work$/)).toBeNull();
    expect(within(card).getByText(/^Disk below its limit/)).toBeTruthy();
  });

  it("shows an offline machine's word and when it was last heard from, with no room and no button but its name", () => {
    const card = renderCard(OFFLINE_MACHINE);

    expect(within(card).getAllByText("Offline")).toHaveLength(1);
    expect(within(card).getByText("Offline since 09:12")).toBeTruthy();
    expect(within(card).queryByText(/^Room for|^Full$|^Takes no new work$/)).toBeNull();
    expect(within(card).getAllByRole("button")).toHaveLength(1);
  });
});
