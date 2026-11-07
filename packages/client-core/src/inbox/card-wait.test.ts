/** Tests the wait of a card and the line that says its facts may be old. */
import { describe, expect, it } from "vitest";
import { buildInboxCard, buildRequestCard, buildSignalLine } from "./cards.testing";
import {
  describeCardTime,
  describeCardTrust,
  describeCardWait,
  findNextCardTimeChange,
  findNextSignalAgeChange,
  formatSignalAge,
  isCardTimeDependent,
} from "./card-wait";

const NOW = new Date("2026-11-07T12:00:00.000Z");
const hoursAgo = (hours: number): string =>
  new Date(NOW.getTime() - hours * 3_600_000).toISOString();

describe("describeCardWait", () => {
  it.each([
    [0.2, "1h", "Waiting 1 hour"],
    [5.9, "5h", "Waiting 5 hours"],
    [23.9, "23h", "Waiting 23 hours"],
    [24, "1d", "Waiting 1 day"],
    [50, "2d", "Waiting 2 days"],
  ])("writes a wait of %s hours as %s", (hours, text, words) => {
    const card = buildRequestCard("1", { waitingSince: hoursAgo(hours) });
    expect(describeCardWait(card, NOW)).toMatchObject({ text, words });
  });

  it.each([
    [5, "fresh"],
    [5.9, "fresh"],
    [6, "recent"],
    [23, "recent"],
    [24, "due"],
    [71, "due"],
    [72, "over"],
    [500, "over"],
  ])("puts a wait of %s hours on a 24-hour patience at %s", (hours, level) => {
    const card = buildRequestCard("1", { patience: 24, waitingSince: hoursAgo(hours) });
    expect(describeCardWait(card, NOW)?.level).toBe(level);
  });

  it("measures the same hours against the patience of the kind", () => {
    const wait = (patience: number) =>
      describeCardWait(buildRequestCard("1", { patience, waitingSince: hoursAgo(12) }), NOW)?.level;
    expect(wait(12)).toBe("due");
    expect(wait(336)).toBe("fresh");
  });

  it("counts from the first observation when the card has no waiting-since", () => {
    const card = buildRequestCard("1", { firstObservedAt: hoursAgo(48) });
    expect(describeCardWait(card, NOW)?.text).toBe("2d");
  });

  it("treats a patience of zero as one hour, so the level is still defined", () => {
    const card = buildRequestCard("1", { patience: 0, waitingSince: hoursAgo(4) });
    expect(describeCardWait(card, NOW)?.level).toBe("over");
  });

  it("reads a wait that starts in the future as one fresh hour", () => {
    const card = buildRequestCard("1", { waitingSince: hoursAgo(-3) });
    expect(describeCardWait(card, NOW)).toMatchObject({ text: "1h", level: "fresh" });
  });

  it("has no wait for a kind without a clock", () => {
    expect(describeCardWait(buildInboxCard("1", { pace: "slow" }), NOW)).toBeNull();
  });

  it("has no wait once a Task holds the card", () => {
    expect(describeCardWait(buildRequestCard("1", { taskId: "task-1" }), NOW)).toBeNull();
  });
});

describe("describeCardTrust", () => {
  it.each([
    ["fresh", { access: "ok", stale: false }, undefined],
    ["stale", { access: "ok", stale: true }, "Last read 3 days ago"],
    [
      "inaccessible",
      { access: "inaccessible", stale: true },
      "No account can read this now. Last read 3 days ago",
    ],
    ["deleted", { access: "deleted", stale: false }, "Deleted at the source"],
  ] as const)("says what a %s card shows", (_name, state, line) => {
    const card = buildInboxCard("1", { ...state, observedAt: hoursAgo(80) });
    expect(describeCardTrust(card, NOW)).toBe(line);
  });
});

describe("isCardTimeDependent", () => {
  it("is true for a wait that counts, and for facts that may be old", () => {
    expect(isCardTimeDependent(buildRequestCard("1"))).toBe(true);
    expect(isCardTimeDependent(buildInboxCard("2", { stale: true }))).toBe(true);
    expect(isCardTimeDependent(buildInboxCard("3", { access: "inaccessible" }))).toBe(true);
  });

  it("is false for a card whose wait ended with a Task, and for one with no clock", () => {
    expect(isCardTimeDependent(buildRequestCard("1", { taskId: "task-1" }))).toBe(false);
    expect(isCardTimeDependent(buildInboxCard("2"))).toBe(false);
  });

  it("is false for a deleted card, whose line has no time in it", () => {
    expect(isCardTimeDependent(buildInboxCard("1", { access: "deleted", stale: true }))).toBe(
      false,
    );
  });
});

describe("findNextCardTimeChange", () => {
  const waiting = (hours: number, patience: number) =>
    buildRequestCard("1", { patience, waitingSince: hoursAgo(hours) });
  const hoursUntil = (card: ReturnType<typeof waiting>) =>
    (findNextCardTimeChange(card, NOW).getTime() - NOW.getTime()) / 3_600_000;

  it.each([
    // [hours waited, patience, hours until the text or the level changes]
    [0.5, 1000, 1.5],
    [1.5, 1000, 0.5],
    [2, 1000, 1],
    [5.5, 1000, 0.5],
    [23.5, 1000, 0.5],
    [24, 1000, 24],
    [50, 1000, 22],
    // The level changes before the text: a quarter of 6 hours is 1.5, and 75 is three times 25.
    [1.2, 6, 0.3],
    [73, 25, 2],
  ])(
    "after a wait of %s hours on a patience of %s hours, changes in %s hours",
    (hours, patience, until) => {
      expect(hoursUntil(waiting(hours, patience))).toBeCloseTo(until, 5);
    },
  );

  it("describes something different at the moment it names, and the same just before it", () => {
    for (const [hours, patience] of [
      [0.5, 1000],
      [3.3, 7],
      [23.9, 24],
      [30, 24],
      [100, 24],
    ] as const) {
      const card = waiting(hours, patience);
      const change = findNextCardTimeChange(card, NOW);
      const before = describeCardTime(card, new Date(change.getTime() - 1));
      expect(describeCardTime(card, NOW)).toEqual(before);
      expect(describeCardTime(card, change)).not.toEqual(before);
    }
  });

  it("waits for the second hour when a wait that has not started shows one hour", () => {
    const card = buildRequestCard("1", { patience: 1000, waitingSince: hoursAgo(-3) });
    expect(hoursUntil(card)).toBeCloseTo(5, 5);
  });

  it("changes when the age of the facts does, if that comes first", () => {
    const card = buildInboxCard("1", { stale: true, observedAt: hoursAgo(47.5) });
    expect(hoursUntil(card)).toBeCloseTo(0.5, 5);
  });

  it("is never for a card that does not depend on the time", () => {
    const change = findNextCardTimeChange(buildInboxCard("1"), NOW);
    expect(change.getTime()).toBeGreaterThan(NOW.getTime() + 1e12);
  });
});

describe("formatSignalAge", () => {
  const MINUTE = 60_000;
  it.each([
    [0, "1m"],
    [30_000, "1m"],
    [MINUTE, "1m"],
    [4.9 * MINUTE, "4m"],
    [59 * MINUTE, "59m"],
    [60 * MINUTE, "1h"],
    [23.9 * 60 * MINUTE, "23h"],
    [24 * 60 * MINUTE, "1d"],
    [5.5 * 24 * 60 * MINUTE, "5d"],
    [-MINUTE, "1m"],
  ])("writes %s ms ago as %s", (ago, text) => {
    expect(formatSignalAge(new Date(NOW.getTime() - ago).toISOString(), NOW)).toBe(text);
  });
});

describe("findNextSignalAgeChange", () => {
  it("names a moment at which the age reads differently, and not one just before it", () => {
    for (const minutes of [
      0,
      0.5,
      1,
      1.5,
      7,
      59.5,
      60,
      61,
      600,
      23.5 * 60,
      24 * 60,
      60 * 60,
      130 * 60,
    ]) {
      const at = new Date(NOW.getTime() - minutes * 60_000).toISOString();
      const change = findNextSignalAgeChange(at, NOW);
      expect(change.getTime()).toBeGreaterThan(NOW.getTime());
      expect(formatSignalAge(at, new Date(change.getTime() - 1))).toBe(formatSignalAge(at, NOW));
      expect(formatSignalAge(at, change)).not.toBe(formatSignalAge(at, NOW));
    }
  });
});

describe("the age of a row's sentence", () => {
  const landed = (minutesAgo: number) =>
    buildSignalLine("s1", "Tessa commented", {
      createdAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
    });
  const row = (overrides = {}) =>
    buildInboxCard("1", { signals: { openCount: 2, latest: landed(4) }, ...overrides });

  it("is drawn on a row whose sentence comes from a signal", () => {
    expect(describeCardTime(row(), NOW).signalAge).toBe("4m");
    expect(isCardTimeDependent(row())).toBe(true);
  });

  it.each([
    [
      "a request, which has its wait",
      buildRequestCard("1", { signals: { openCount: 1, latest: landed(4) } }),
    ],
    ["a row a Task holds", row({ taskId: "task-1" })],
    ["a row with no signal", buildInboxCard("1")],
  ])("is not drawn on %s", (_name, card) => {
    expect(describeCardTime(card, NOW).signalAge).toBeUndefined();
  });

  it("sets the next change of a row at the next minute while the signal is young", () => {
    const change = findNextCardTimeChange(row(), NOW);
    expect(change.getTime() - NOW.getTime()).toBe(60_000);
  });
});
