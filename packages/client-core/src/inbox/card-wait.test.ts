/** Tests the wait of a card and the line that says its facts may be old. */
import { describe, expect, it } from "vitest";
import { buildInboxCard, buildRequestCard } from "./cards.testing";
import { describeCardTrust, describeCardWait, isCardTimeDependent } from "./card-wait";

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
});
