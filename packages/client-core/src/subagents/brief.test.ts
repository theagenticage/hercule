/**
 * Tests `findSubagentBrief`, which finds the brief a subagent's page opens
 * with.
 */
import { describe, expect, it } from "vitest";
import type { ThreadTurn } from "../threads/turns";
import { findSubagentBrief } from "./brief";

/** Builds a finished turn with `user` as its user message. */
const buildTurn = (turnId: string, user: string): ThreadTurn => ({
  turnId,
  user,
  items: [],
  assistantText: "",
  startedAt: "2026-10-05T09:00:00.000Z",
  duration: null,
  endState: null,
});

describe("findSubagentBrief", () => {
  it("returns the user message of the first turn", () => {
    expect(
      findSubagentBrief([buildTurn("t-1", "Read the docs"), buildTurn("t-2", "And then?")]),
    ).toEqual({ turnId: "t-1", text: "Read the docs" });
  });

  it("returns undefined while no turn is read, or the first holds no user message", () => {
    expect(findSubagentBrief([])).toBeUndefined();
    expect(findSubagentBrief([buildTurn("t-1", "")])).toBeUndefined();
  });
});
