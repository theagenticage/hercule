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
  NEARLY_FULL_DISK_MACHINE,
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

  it("shows a disk that is 87% full as a meter and its percentage in the you colour, with the free space under it", () => {
    const { rows } = renderList([NEARLY_FULL_DISK_MACHINE]);
    const [orbit] = rows();
    // The cells are the dot, Machine, Sessions, Room, Disk: the fifth.
    const disk = within(orbit!).getAllByRole("cell")[4]!;

    expect(within(disk).getByText("87%").className).toBe("is-you");
    expect(disk.querySelector(".fleet-meter--you i")?.getAttribute("style")).toBe("width: 87%;");
    expect(within(disk).getByText("69.8 GB free")).toBeTruthy();
    expect(within(orbit!).getByText("Disk 87% full")).toBeTruthy();
    expect(within(orbit!).getByRole("button", { name: "Clean up…" })).toBeTruthy();
  });

  it("draws the forecast under the disk meter in the you colour in place of the free space", () => {
    const forecast: MachineSummary = {
      ...NEARLY_FULL_DISK_MACHINE,
      diskCaption: { text: "Limit in 12 days", isForecast: true },
    };
    const { rows } = renderList([forecast]);
    const disk = within(rows()[0]!).getAllByRole("cell")[4]!;

    expect(within(disk).getByText("Limit in 12 days").className).toBe("is-you");
    expect(within(disk).queryByText("69.8 GB free")).toBeNull();
  });

  it("words the sessions against the cap, with the waiting ones in the you colour, and a dash while away", () => {
    const { rows } = renderList([BUSY_MACHINE, OFFLINE_MACHINE]);
    // The cells are the dot, Machine, Sessions: the third.
    const [busy, offline] = rows().map((row) => within(row).getAllByRole("cell")[2]!);

    expect(busy!.querySelector("small")?.textContent).toBe("12 of 16 · 5 waiting");
    expect(busy!.querySelector("small")?.className).toBe("is-you");
    expect(offline!.querySelector("small")?.textContent).toBe("– of 16");
    expect(offline!.querySelector("small")?.className).toBe("");
  });

  it("draws a dash for a disk and memory the runner has not reported", () => {
    const notReported = {
      value: "–",
      unit: "",
      freeAmount: "",
      share: null,
      level: "normal",
    } as const;
    const { rows } = renderList([{ ...BUSY_MACHINE, disk: notReported, memory: notReported }]);
    // The cells are the dot, Machine, Sessions, Room, Disk, Memory: the fifth and the sixth.
    const [, , , , disk, memory] = within(rows()[0]!).getAllByRole("cell");

    expect(disk!.textContent).toBe("–");
    expect(memory!.textContent).toBe("–");
  });

  it("shows an offline machine's last sighting and no button but its name", () => {
    const { rows } = renderList([OFFLINE_MACHINE]);
    const [offline] = rows();

    expect(within(offline!).getByText("Offline since 09:12")).toBeTruthy();
    expect(within(offline!).getAllByRole("button")).toHaveLength(1);
  });
});
