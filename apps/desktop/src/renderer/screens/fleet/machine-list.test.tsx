/**
 * Tests how the machine list puts its rows together. What each row says is
 * decided by `@hercule/client-core/fleet`; the route integration tests cover
 * switching to the list and opening a machine from it.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  BUSY_MACHINE,
  DRAINING_MACHINE,
  FULL_DISK_MACHINE,
  NOW,
  OFFLINE_MACHINE,
  TIMEZONE,
} from "./fleet.testing";
import { MachineList } from "./machine-list";
import { buildMachineTransitionName } from "./machine-transition";

const renderList = (machines: Parameters<typeof MachineList>[0]["machines"]) => {
  const onOpen = vi.fn();
  const onAllow = vi.fn();
  render(
    <MachineList
      machines={machines}
      timezone={TIMEZONE}
      now={NOW}
      pendingAllowRunnerIds={new Set()}
      onOpen={onOpen}
      onAllow={onAllow}
    />,
  );
  return { onOpen, onAllow, rows: () => screen.getAllByRole("row").slice(1) };
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

  it("calls onAllow from the Allow button and onOpen from the name, each once", async () => {
    const user = userEvent.setup();
    const { onOpen, onAllow, rows } = renderList([BUSY_MACHINE, FULL_DISK_MACHINE]);
    const [busy] = rows();

    await user.click(within(busy!).getByRole("button", { name: "Allow 17" }));
    expect(onAllow).toHaveBeenCalledExactlyOnceWith("runner-busy", 17);
    expect(onOpen).not.toHaveBeenCalled();

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
