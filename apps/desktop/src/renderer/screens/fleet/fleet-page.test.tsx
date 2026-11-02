/**
 * Tests the Fleet page's pieces as the user sees them: a machine's card and
 * its row in the list, the sessions drawing, the lead and the card that adds a
 * machine. The machines are fixtures; what each one needs is decided by
 * `@hercule/client-core/fleet`, which has its own tests.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describeFleet, drawSessions, type FleetMachine } from "@hercule/client-core/fleet";
import type { Runner } from "@hercule/contract";
import { EmptyFleetCard } from "./empty-fleet-card";
import { FleetPageLead } from "./fleet-lead";
import { MachineCard } from "./machine-card";
import { MachineList } from "./machine-list";
import { buildMachineTransitionName } from "./machine-transition";
import { SessionsFigure } from "./sessions-drawing";

const GIB = 1024 ** 3;
const TIMEZONE = "UTC";
const NOW = new Date("2026-11-02T14:00:00.000Z");

/** Returns an online runner with a cap of 16, 20 GiB of free disk and a 10 GiB disk limit. */
const buildRunner = (overrides: Partial<Runner>): Runner => ({
  id: "01a06d02-beff-7037-9f5b-042822015952",
  name: "atlas",
  connectivity: "online",
  lifecycle: "active",
  reserved: false,
  version: "0.9.3",
  labels: [],
  facts: null,
  watermark: { diskFreeBytes: 20 * GIB, availableMemoryBytes: 8 * GIB },
  maxConcurrentSessions: 16,
  diskWatermarkBytes: 10 * GIB,
  lastSeenAt: "2026-11-02T09:12:00.000Z",
  ...overrides,
});

/** Runs 12 sessions under a cap of 16, with 5 more waiting for a slot that the cap does not give them. */
const BUSY: FleetMachine = {
  runner: buildRunner({ id: "runner-busy", name: "atlas" }),
  running: 12,
  waiting: 5,
  waitingThreads: 5,
};

/** Has 5 GiB of free disk under a 10 GiB limit. */
const FULL_DISK: FleetMachine = {
  runner: buildRunner({
    id: "runner-full",
    name: "forge",
    watermark: { diskFreeBytes: 5 * GIB, availableMemoryBytes: 8 * GIB },
  }),
  running: 2,
  waiting: 0,
  waitingThreads: 0,
};

/** Is offline, and was last heard from at 09:12. */
const OFFLINE: FleetMachine = {
  runner: buildRunner({ id: "runner-off", name: "nomad", connectivity: "offline" }),
  running: 0,
  waiting: 0,
  waitingThreads: 0,
};

/** Is online but told to take no new work. */
const DRAINING: FleetMachine = {
  runner: buildRunner({ id: "runner-drain", name: "dock", lifecycle: "draining" }),
  running: 1,
  waiting: 0,
  waitingThreads: 0,
};

/** Returns the element that draws exactly `text`, such as the "12 of 16" a card splits into a number and a small unit. */
const getByWholeText = (within_: HTMLElement, text: string): HTMLElement =>
  within(within_).getByText(
    (_, element) => element?.textContent === text && element.tagName === "B",
  );

const renderCard = (machine: FleetMachine, allowPending = false) => {
  const onOpen = vi.fn();
  const onAllow = vi.fn();
  const { container } = render(
    <MachineCard
      machine={machine}
      timezone={TIMEZONE}
      now={NOW}
      allowPending={allowPending}
      onOpen={onOpen}
      onAllow={onAllow}
    />,
  );
  return { card: container.firstElementChild as HTMLElement, onOpen, onAllow };
};

describe("MachineCard", () => {
  it("shows the sessions against the cap, the room, and the first need with its Allow button", async () => {
    const user = userEvent.setup();
    const { card, onOpen, onAllow } = renderCard(BUSY);

    expect(getByWholeText(card, "12 of 16")).toBeTruthy();
    expect(within(card).getByText("Room for 4")).toBeTruthy();
    expect(within(card).getByText("5 threads wait for a slot")).toBeTruthy();

    const allow = within(card).getByRole("button", { name: "Allow 17" });
    expect(allow.getAttribute("title")).toBe(
      "Lets 17 sessions run here at once: the 12 running and the 5 waiting.",
    );
    await user.click(allow);
    expect(onAllow).toHaveBeenCalledExactlyOnceWith("runner-busy", 17);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("opens the machine's page from its name, with a press or with Enter or Space, and carries the machine's transition name", async () => {
    const user = userEvent.setup();
    const { card, onOpen } = renderCard(BUSY);

    const open = within(card).getByRole("button", { name: "atlas" });
    await user.click(open);
    open.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onOpen).toHaveBeenCalledTimes(3);
    expect(onOpen).toHaveBeenCalledWith("runner-busy");
    expect(card.style.getPropertyValue("view-transition-name")).toBe(
      buildMachineTransitionName("runner-busy"),
    );
  });

  it("shows the free disk and a Clean up button that is drawn inert while a disk is below its limit", async () => {
    const user = userEvent.setup();
    const { card, onOpen, onAllow } = renderCard(FULL_DISK);

    expect(within(card).getByText("Disk below its limit. It takes no new sessions.")).toBeTruthy();
    expect(within(card).getByText("Takes no new work")).toBeTruthy();
    const cleanUp = within(card).getByRole("button", { name: "Clean up…" });
    expect(cleanUp.getAttribute("aria-disabled")).toBe("true");
    expect(cleanUp.getAttribute("title")).toBe("Not built yet");

    await user.click(cleanUp);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onAllow).not.toHaveBeenCalled();
  });

  it("shows that Allow is saving and ignores presses meanwhile", async () => {
    const user = userEvent.setup();
    const { card, onAllow } = renderCard(BUSY, true);

    const saving = within(card).getByRole("button", { name: "Saving…" });
    expect(saving.getAttribute("aria-disabled")).toBe("true");
    await user.click(saving);
    expect(onAllow).not.toHaveBeenCalled();
  });

  it("says a machine told to take no new work once, in its status, and not again as its room", () => {
    const { card } = renderCard(DRAINING);

    expect(within(card).getAllByText("Takes no new work")).toHaveLength(1);
  });

  it("shows an offline machine's word and when it was last heard from, with no room and no button", () => {
    const { card } = renderCard(OFFLINE);

    expect(within(card).getAllByText("Offline")).toHaveLength(1);
    expect(within(card).getByText("Offline since 09:12")).toBeTruthy();
    expect(within(card).queryByText(/^Room for|^Full$|^Takes no new work$/)).toBeNull();
    // The name is its only button.
    expect(within(card).getAllByRole("button")).toHaveLength(1);
  });
});

describe("MachineList", () => {
  const renderList = (machines: readonly FleetMachine[]) => {
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
    return { onOpen, onAllow };
  };

  it("shows one row per machine with the same facts as the card", async () => {
    const user = userEvent.setup();
    const { onOpen, onAllow } = renderList([BUSY, FULL_DISK, OFFLINE]);

    expect(screen.getAllByRole("columnheader").map((head) => head.textContent)).toEqual([
      "Machine",
      "Sessions",
      "Room",
      "Disk",
      "Memory",
      "Needs you",
    ]);
    const [busy, fullDisk, offline] = screen.getAllByRole("row").slice(1);

    expect(within(busy!).getByText("12 of 16 · 5 waiting")).toBeTruthy();
    expect(within(busy!).getByText("Room for 4")).toBeTruthy();
    expect(within(busy!).getByText("5 threads wait for a slot")).toBeTruthy();
    expect(within(fullDisk!).getByRole("button", { name: "Clean up…" }).getAttribute("title")).toBe(
      "Not built yet",
    );
    expect(within(offline!).getByText("Offline since 09:12")).toBeTruthy();
    expect(within(offline!).getAllByRole("button")).toHaveLength(1);

    await user.click(within(busy!).getByRole("button", { name: "Allow 17" }));
    expect(onAllow).toHaveBeenCalledExactlyOnceWith("runner-busy", 17);
    expect(onOpen).not.toHaveBeenCalled();

    await user.click(within(busy!).getByRole("button", { name: "atlas" }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("runner-busy");
  });

  it("shows the free disk on one line, and a dash for the room of a machine told to take no new work", () => {
    renderList([BUSY, DRAINING]);

    const [busy, draining] = screen.getAllByRole("row").slice(1);
    expect(within(busy!).getByText("21.5 GB").nextElementSibling?.textContent).toBe("free");
    expect(within(draining!).getAllByText("Takes no new work")).toHaveLength(1);
    // The cells are the dot, Machine, Sessions, Room: the fourth.
    expect(within(draining!).getAllByRole("cell")[3]?.textContent).toBe("–");
  });
});

describe("SessionsFigure", () => {
  const draw = (cap: number, running: number, waiting: number) =>
    render(
      <SessionsFigure
        drawing={drawSessions({
          runner: buildRunner({ maxConcurrentSessions: cap }),
          running,
          waiting,
          waitingThreads: waiting,
        })}
        size="card"
      />,
    ).container.firstElementChild!;

  it("draws one block per slot, then one per waiting session, up to a cap of 16", () => {
    const figure = draw(16, 12, 5);

    expect(figure.querySelectorAll("i")).toHaveLength(21);
    expect(figure.querySelectorAll("i.is-run")).toHaveLength(12);
    expect(figure.querySelectorAll("i.is-wait")).toHaveLength(5);
  });

  it("draws one bar above a cap of 16", () => {
    const figure = draw(17, 12, 5);

    expect(figure.classList.contains("fleet-sessions--bar")).toBe(true);
    expect(figure.querySelectorAll("i.is-run")).toHaveLength(1);
    expect(figure.querySelectorAll("i.is-wait")).toHaveLength(1);
  });

  it("lets the running part pass a cap that was lowered", () => {
    const figure = draw(4, 6, 0);

    expect(figure.querySelectorAll("i.is-run")).toHaveLength(6);
    expect(figure.querySelectorAll("i")).toHaveLength(6);
  });
});

describe("FleetPageLead", () => {
  it("draws the count of machines that need the user in the you ink and the numbers in bold", () => {
    render(<FleetPageLead lead={describeFleet([BUSY, FULL_DISK, OFFLINE])} />);

    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Three machines need you.");
    expect(screen.getByText("Three").classList.contains("is-you")).toBe(true);
    expect(screen.getByText("14", { selector: "b" })).toBeTruthy();
  });
});

describe("EmptyFleetCard", () => {
  it("invites the user to add a machine and calls onAddMachine when pressed", async () => {
    const user = userEvent.setup();
    const onAddMachine = vi.fn();
    render(<EmptyFleetCard onAddMachine={onAddMachine} />);

    const card = screen.getByRole("button", { name: /Add a machine\./ });
    expect(card.textContent).toContain(
      "Run one command on another computer and it joins your fleet.",
    );
    await user.click(card);
    expect(onAddMachine).toHaveBeenCalledOnce();
  });
});
