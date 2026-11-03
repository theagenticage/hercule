/**
 * Tests how a machine's card puts the parts of its `MachineSummary` together.
 * What each part says is decided by `describeFleetPage` in
 * `@hercule/client-core/fleet`; the route integration tests cover pressing a
 * card's buttons.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MachineSummary } from "@hercule/client-core/fleet";
import type { MachineFaces, WorkFace } from "@hercule/client-core/machine-work";
import {
  BUSY_MACHINE,
  DRAINING_MACHINE,
  FULL_DISK_MACHINE,
  NEARLY_FULL_DISK_MACHINE,
  OFFLINE_MACHINE,
} from "./fleet.testing";
import { MachineCard } from "./machine-card";
import { buildMachineTransitionName } from "./machine-transition";

const renderCard = (
  machine: MachineSummary,
  onOpen = vi.fn(),
  faces?: MachineFaces,
  updatesText?: string,
): HTMLElement => {
  const { container } = render(
    <MachineCard
      machine={machine}
      faces={faces}
      updatesText={updatesText}
      allow={null}
      onOpen={onOpen}
    />,
  );
  return container.firstElementChild as HTMLElement;
};

const buildFaces = (shown: number, moreCount: number): MachineFaces => ({
  faces: Array.from({ length: shown }, (_, index): WorkFace => ({
    kind: "thread",
    seed: `session-${String(index)}`,
    pose: "working",
  })),
  moreCount,
});

describe("MachineCard", () => {
  it("carries its machine's view transition name, the one the machine's page head carries", () => {
    const card = renderCard(BUSY_MACHINE);

    expect(card.style.getPropertyValue("view-transition-name")).toBe(
      buildMachineTransitionName("runner-busy"),
    );
  });

  it("opens its machine from the name", async () => {
    const onOpen = vi.fn();
    renderCard(BUSY_MACHINE, onOpen);

    await userEvent.setup().click(screen.getByRole("button", { name: "atlas" }));

    expect(onOpen).toHaveBeenCalledExactlyOnceWith("runner-busy");
  });

  it("draws no status label for an online machine, and names the state on its dot instead", () => {
    const card = renderCard(BUSY_MACHINE);

    expect(within(card).queryByText("Online")).toBeNull();
    expect(within(card).getByRole("img", { name: "Online" })).toBeTruthy();
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

  it("draws the sessions running against the cap, and a dash for a machine that is away", () => {
    const sessions = (card: HTMLElement) =>
      within(card).getByText("Sessions").closest(".fleet-gauge")?.querySelector("b")?.textContent;

    expect(sessions(renderCard(BUSY_MACHINE))).toBe("12 of 16");
    expect(sessions(renderCard(OFFLINE_MACHINE))).toBe("– of 16");
  });

  it("draws a dash and an empty meter for a disk and memory the runner has not reported", () => {
    const notReported = {
      value: "–",
      unit: "",
      freeAmount: "",
      share: null,
      level: "normal",
    } as const;
    const card = renderCard({ ...BUSY_MACHINE, disk: notReported, memory: notReported });
    const [disk, memory] = ["Disk", "Memory"].map((label) =>
      within(card).getByText(label).closest(".fleet-gauge"),
    );

    expect(disk?.querySelector("b")?.textContent).toBe("–");
    expect(memory?.querySelector("b")?.textContent).toBe("–");
    expect(card.querySelectorAll(".fleet-meter i")).toHaveLength(2);
  });

  it("shows the disk's free space and an empty meter while the runner does not report its disk size", () => {
    const card = renderCard(BUSY_MACHINE);
    const [diskMeter] = card.querySelectorAll<HTMLElement>(".fleet-meter i");

    expect(within(card).getByText("21.5", { exact: false }).textContent).toBe("21.5 GB free");
    expect(diskMeter?.style.width).toBe("0%");
  });

  it("shows a disk that is 87% full as its percentage, in the you colour, with its meter that full", () => {
    const card = renderCard(NEARLY_FULL_DISK_MACHINE);
    const gauge = within(card).getByText("Disk").closest(".fleet-gauge");
    const [diskMeter] = card.querySelectorAll<HTMLElement>(".fleet-meter i");

    expect(gauge?.classList.contains("fleet-gauge--you")).toBe(true);
    expect(gauge?.querySelector("b")?.textContent).toBe("87%");
    expect(within(card).queryByText(/GB free/)).toBeNull();
    expect(diskMeter?.style.width).toBe("87%");
    expect(card.querySelector(".fleet-meter--you")).toBeTruthy();
  });

  it("names the 87% in its need line, with the Clean up button drawn inert", () => {
    const card = renderCard(NEARLY_FULL_DISK_MACHINE);

    expect(within(card).getByText("Disk 87% full")).toBeTruthy();
    expect(
      within(card).getByRole("button", { name: "Clean up…" }).getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("draws the faces of the machine's work left of its room, with the count they leave out", () => {
    const card = renderCard(BUSY_MACHINE, vi.fn(), buildFaces(5, 2));
    const faces = within(card).getByRole("img", { name: "7 groups at work here" });
    const room = card.querySelector(".fleet-room");

    expect(faces.querySelectorAll("svg")).toHaveLength(5);
    expect(within(faces).getByText("+2")).toBeTruthy();
    expect(faces.compareDocumentPosition(room!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("draws no count when the faces show every group, and names a lone group in the singular", () => {
    const card = renderCard(BUSY_MACHINE, vi.fn(), buildFaces(1, 0));
    const faces = within(card).getByRole("img", { name: "1 group at work here" });

    expect(faces.querySelectorAll("small")).toHaveLength(0);
  });

  it("draws no faces for a machine with no work", () => {
    const card = renderCard(BUSY_MACHINE);

    expect(within(card).queryByRole("img", { name: /at work here/ })).toBeNull();
  });

  it("draws the updates line under the need line, in no hue", () => {
    const card = renderCard(NEARLY_FULL_DISK_MACHINE, vi.fn(), undefined, "2 updates");
    const need = within(card).getByText("Disk 87% full");
    const updates = within(card).getByText("2 updates");

    expect(need.compareDocumentPosition(updates) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(updates.className).toBe("fleet-updates");
  });

  it("draws the updates line alone, in the need line's place, for a machine that needs nothing", () => {
    const card = renderCard(DRAINING_MACHINE, vi.fn(), undefined, "1 update");

    expect(card.querySelector(".fleet-card-foot")?.textContent).toBe("1 update");
  });

  it("draws no updates line for a machine with none", () => {
    const card = renderCard(NEARLY_FULL_DISK_MACHINE);

    expect(card.querySelector(".fleet-updates")).toBeNull();
  });
});
