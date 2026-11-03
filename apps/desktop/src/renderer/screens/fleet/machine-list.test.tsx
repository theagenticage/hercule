/**
 * Tests how the machine list puts its rows together from `MachineSummary`
 * values. What each row says is decided by `describeFleetPage` in
 * `@hercule/client-core/fleet`; the route integration tests cover switching to
 * the list and opening a machine from it.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MachineSummary } from "@hercule/client-core/fleet";
import {
  BUSY_MACHINE,
  DRAINING_MACHINE,
  FULL_DISK_MACHINE,
  OFFLINE_MACHINE,
} from "./fleet.testing";
import { MachineList, MachineRow } from "./machine-list";
import { buildMachineTransitionName } from "./machine-transition";

const renderList = (machines: readonly MachineSummary[]) => {
  const onOpen = vi.fn();
  render(
    <MachineList>
      {machines.map((machine) => (
        <MachineRow key={machine.runnerId} machine={machine} allow={null} onOpen={onOpen} />
      ))}
    </MachineList>,
  );
  return { onOpen, rows: () => screen.getAllByRole("row").slice(1) };
};

describe("MachineList", () => {
  it("heads its columns Machine, Sessions, Room, Disk, Memory and Needs you", () => {
    renderList([BUSY_MACHINE]);

    expect(screen.getAllByRole("columnheader").map((head) => head.textContent)).toEqual([
      "Machine",
      "Sessions",
      "Room",
      "Disk",
      "Memory",
      "Needs you",
    ]);
  });

  it("opens a machine from its name", async () => {
    const user = userEvent.setup();
    const { onOpen, rows } = renderList([BUSY_MACHINE, FULL_DISK_MACHINE]);
    const [busy] = rows();

    await user.click(within(busy!).getByRole("button", { name: "atlas" }));

    expect(onOpen).toHaveBeenCalledExactlyOnceWith("runner-busy");
  });

  it("carries each machine's view transition name on its row", () => {
    const { rows } = renderList([BUSY_MACHINE, OFFLINE_MACHINE]);

    expect(rows().map((row) => row.style.getPropertyValue("view-transition-name"))).toEqual([
      buildMachineTransitionName("runner-busy"),
      buildMachineTransitionName("runner-off"),
    ]);
  });

  it("always words the status under the name, also for an online machine", () => {
    const { rows } = renderList([BUSY_MACHINE]);
    const [busy] = rows();

    expect(within(busy!).getByText("Online")).toBeTruthy();
    expect(within(busy!).queryByRole("img")).toBeNull();
  });

  it("shows the free disk on one line, and a dash for the room of a machine told to take no new work", () => {
    const { rows } = renderList([BUSY_MACHINE, DRAINING_MACHINE]);
    const [busy, draining] = rows();

    expect(within(busy!).getByText("21.5 GB").nextElementSibling?.textContent).toBe("free");
    expect(within(draining!).getAllByText("Takes no new work")).toHaveLength(1);
    // The cells are the dot, Machine, Sessions, Room: the fourth.
    expect(within(draining!).getAllByRole("cell")[3]?.textContent).toBe("–");
  });

  it("shows an offline machine's last sighting and no button but its name", () => {
    const { rows } = renderList([OFFLINE_MACHINE]);
    const [offline] = rows();

    expect(within(offline!).getByText("Offline since 09:12")).toBeTruthy();
    expect(within(offline!).getAllByRole("button")).toHaveLength(1);
  });
});
