/** Tests what the head row of a group says: its label, the time of the member that placed it, its most pressing ask, its sources and its count. */
import type { InboxThing } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { NO_OFFERS } from "./card-hand-off";
import { buildInboxAsk, buildInboxThing } from "./cards.testing";
import { describeInboxGroupRow } from "./inbox-group-row";
import type { InboxGroupView } from "./inbox-groups";
import type { InboxRowContext } from "./inbox-row";

const NOW = new Date("2026-11-12T12:00:00.000Z");
const hoursAgo = (hours: number): string =>
  new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const CONTEXT: InboxRowContext = {
  order: "waiting",
  now: NOW,
  userName: "Rogier",
  offers: NO_OFFERS,
};

/** A thing that asks, with `who` as the asker, waiting for `hours`. */
const asking = (id: string, who: string, hours: number, overrides: Partial<InboxThing> = {}) =>
  buildInboxThing(id, {
    asks: [
      buildInboxAsk(`a${id}`, who, {
        createdAt: hoursAgo(hours),
        say: { say: `${who} mentioned you`, tone: "plain" },
      }),
    ],
    askCount: 1,
    waitingSince: hoursAgo(hours),
    patience: 24,
    ...overrides,
  });

/** A group of `rows` that the first row placed, `size` things large. */
const groupOf = (
  rows: readonly InboxThing[],
  overrides: Partial<InboxGroupView<InboxThing>> = {},
): InboxGroupView<InboxThing> => ({
  key: "group:1",
  labelRef: rows[0]!.ref,
  label: "Retry a failed card payment",
  size: rows.length,
  isCut: false,
  isOpen: false,
  placedBy: rows[0],
  rows,
  matchingCount: rows.length,
  matchingRefs: rows.map((row) => row.ref),
  tick: "none",
  ...overrides,
});

describe("describeInboxGroupRow", () => {
  it("draws the label as the title and the count of things", () => {
    const view = describeInboxGroupRow(
      groupOf([asking("1", "Mei", 2), asking("2", "Omar", 3)]),
      CONTEXT,
    );
    expect(view.key).toBe("group:1");
    expect(view.title).toBe("Retry a failed card payment");
    expect(view.count).toBe("2 things");
  });

  it("counts the group's size, which can be more than the rows the list holds", () => {
    const rows = [asking("1", "Mei", 2), asking("2", "Omar", 3)];
    expect(describeInboxGroupRow(groupOf(rows, { size: 14 }), CONTEXT).count).toBe("14 things");
  });

  it("takes the time from the member that placed the group", () => {
    const older = asking("1", "Mei", 5);
    const newer = asking("2", "Omar", 1);
    const view = describeInboxGroupRow(groupOf([older, newer], { placedBy: newer }), CONTEXT);
    expect(view.time).toMatchObject({ kind: "wait", text: "1h" });
  });

  it("says the ask that has waited longest and counts the other members that ask", () => {
    const rows = [asking("1", "Mei", 2), asking("2", "Omar", 30), asking("3", "Juno", 6)];
    const { reason } = describeInboxGroupRow(groupOf(rows), CONTEXT);
    expect(reason).toEqual({
      who: "Omar",
      rest: "mentioned you",
      more: 2,
      aside: undefined,
      quiet: false,
    });
  });

  it("counts members, not asks, and leaves out members a Task holds", () => {
    const twoAsks = asking("1", "Mei", 4, { askCount: 3 });
    const held = asking("2", "Omar", 40, { taskId: "task-1" });
    const view = describeInboxGroupRow(groupOf([twoAsks, held]), CONTEXT);
    expect(view.reason).toMatchObject({ who: "Mei", more: 0 });
  });

  it("says the quiet sentence of the placing member when no member asks", () => {
    const rows = [
      buildInboxThing("1", { status: { label: "In progress", shape: "half", tone: "active" } }),
      buildInboxThing("2"),
    ];
    const view = describeInboxGroupRow(groupOf(rows), CONTEXT);
    expect(view.reason).toMatchObject({ rest: "In progress", more: 0, quiet: true });
    expect(view.time).toEqual({ kind: "none" });
  });

  it("lists each source once, in the order of the first member that has it", () => {
    const rows = [
      asking("1", "Mei", 1, { source: "linear" }),
      asking("2", "Mei", 1, { source: "github" }),
      asking("3", "Mei", 1, { source: "linear" }),
      asking("4", "Mei", 1, { source: "slack" }),
    ];
    expect(describeInboxGroupRow(groupOf(rows), CONTEXT).sources).toEqual([
      "linear",
      "github",
      "slack",
    ]);
  });

  it("gives the whole row one accessible name", () => {
    const rows = [asking("1", "Mei", 30), asking("2", "Omar", 2)];
    expect(describeInboxGroupRow(groupOf(rows), CONTEXT).label).toBe(
      "Linked group, 2 things: Retry a failed card payment. Mei mentioned you, and 1 more ask. waiting 1 day, due",
    );
  });
});
