/**
 * Tests the divider under a thread turn:
 *
 * - `showsTurnDivider(turn, live)` decides whether the turn shows one;
 * - `describeTurnDivider(turn, live, now)` returns its words;
 * - `describeTurnEnding(turn)` returns the words for how a turn ended;
 * - `describeThreadItem(item)` returns the line an opened divider lists for
 *   one tool item.
 */
import { describe, expect, it } from "vitest";
import {
  describeThreadItem,
  describeTurnDivider,
  describeTurnEnding,
  showsTurnDivider,
} from "./turn-divider";
import type { ThreadItem, ThreadTurn } from "./turns";

const STARTED_AT = "2026-09-08T10:00:00.000Z";

const ITEM: ThreadItem = {
  itemId: "tool1",
  kind: "command_execution",
  verb: "command",
  target: "ls -la",
  result: "completed",
};

/** Builds a turn that completed after five seconds with no tool items. */
const buildTurn = (over: Partial<ThreadTurn> = {}): ThreadTurn => ({
  turnId: "t1",
  user: "Fix the login bug",
  items: [],
  assistantText: "Done.",
  startedAt: STARTED_AT,
  duration: 5_000,
  endState: "completed",
  ...over,
});

describe("showsTurnDivider", () => {
  it("shows no divider for a completed turn with no tool items", () => {
    expect(showsTurnDivider(buildTurn(), false)).toBe(false);
  });

  it("shows the divider for a turn with tool items", () => {
    expect(showsTurnDivider(buildTurn({ items: [ITEM] }), false)).toBe(true);
  });

  it("shows the divider for a live turn, before it has any items", () => {
    const turn = buildTurn({ duration: null, endState: null });

    expect(showsTurnDivider(turn, true)).toBe(true);
  });

  it.each([
    ["was stopped", { endState: "interrupted" }],
    ["failed", { endState: "failed" }],
    ["was cut short", { endState: null, duration: null }],
  ] as const)("shows the divider for a turn with no items that %s", (_, over) => {
    expect(showsTurnDivider(buildTurn(over), false)).toBe(true);
  });
});

describe("describeTurnDivider", () => {
  it("counts a live turn from its start to now", () => {
    const turn = buildTurn({ duration: null, endState: null });

    expect(describeTurnDivider(turn, true, Date.parse(STARTED_AT) + 12_000)).toBe(
      "Working for 12s",
    );
  });

  it.each([
    ["completed", "Worked for 5s"],
    ["interrupted", "Stopped after 5s"],
    ["failed", "Failed after 5s"],
  ] as const)("describes a turn that ended %s as %s", (endState, words) => {
    expect(describeTurnDivider(buildTurn({ endState }), false, 0)).toBe(words);
  });

  it("describes a turn with no turn.completed row as cut short, never as 0s", () => {
    const turn = buildTurn({ duration: null, endState: null });

    expect(describeTurnDivider(turn, false, 0)).toBe("Cut short");
  });
});

describe("describeTurnEnding", () => {
  it.each([
    [{ endState: "interrupted", duration: 4_000 }, "Stopped after 4s"],
    [{ endState: "failed", duration: 4_000 }, "Failed after 4s"],
    [{ endState: null, duration: null }, "Cut short"],
  ] as const)("describes the ending %o as %s", (ending, words) => {
    expect(describeTurnEnding(ending)).toBe(words);
  });
});

describe("describeThreadItem", () => {
  it("joins the verb, target and result", () => {
    expect(describeThreadItem(ITEM)).toBe("command · ls -la · completed");
  });

  it("leaves out a target the item did not report, so no separator is doubled", () => {
    expect(describeThreadItem({ ...ITEM, target: "" })).toBe("command · completed");
  });
});
