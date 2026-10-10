/**
 * Tests `findSubagentBrief` and `splitSubagentBrief`, which find the brief a
 * subagent's page opens with, and `describeBriefSource`, which returns who
 * handed the brief over: the parent's name and the agent type.
 */
import { describe, expect, it } from "vitest";
import type { ThreadBlock } from "../threads/blocks";
import type { ThreadTurn } from "../threads/turns";
import { describeBriefSource, findSubagentBrief, splitSubagentBrief } from "./brief";
import { buildSubagent } from "./subagents.testing";

/** Builds a finished turn opened by a user message with `text`. */
const buildTurn = (turnId: string, text: string): ThreadTurn => ({
  turnId,
  userMessages: [{ itemId: `u-${turnId}`, text, attachments: [], steered: false }],
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

describe("splitSubagentBrief", () => {
  const user = (text: string): ThreadBlock => ({
    kind: "user",
    key: `user:${text}`,
    itemId: text,
    text,
    attachments: [],
    steered: false,
    at: "2026-10-05T09:00:00.000Z",
  });
  const pending: ThreadBlock = { kind: "pending", key: "pending", since: null };

  it("takes the first block's user message out as the brief", () => {
    const later = user("And then?");
    expect(splitSubagentBrief([user("Read the docs"), pending, later])).toEqual({
      brief: "Read the docs",
      blocks: [pending, later],
    });
  });

  it("finds the brief behind a warning that came first, and keeps the warning", () => {
    const warning: ThreadBlock = {
      kind: "warning",
      key: "warning:0",
      message: "the harness named a subagent",
      at: "2026-10-05T09:00:00.000Z",
    };
    expect(splitSubagentBrief([warning, user("Read the docs"), pending])).toEqual({
      brief: "Read the docs",
      blocks: [warning, pending],
    });
  });

  it("returns no brief and every block when the first block is not a user message with text", () => {
    const empty = user("");
    expect(splitSubagentBrief([])).toEqual({ brief: undefined, blocks: [] });
    expect(splitSubagentBrief([pending, user("Late")])).toEqual({
      brief: undefined,
      blocks: [pending, user("Late")],
    });
    expect(splitSubagentBrief([empty, pending])).toEqual({
      brief: undefined,
      blocks: [empty, pending],
    });
  });
});

describe("describeBriefSource", () => {
  const planner = buildSubagent({ id: "p", description: "Plan the migration" });

  it("names the parent subagent and the agent type", () => {
    const reader = buildSubagent({ id: "r", parentSubagentId: "p", agentType: "Explore" });
    expect(describeBriefSource(reader, [planner, reader])).toEqual({
      parent: "Plan the migration",
      agentType: "Explore",
    });
  });

  it("names the main agent as the parent, and leaves out an agent type the record does not hold", () => {
    expect(describeBriefSource(planner, [planner])).toEqual({
      parent: "the main agent",
      agentType: undefined,
    });
  });
});
