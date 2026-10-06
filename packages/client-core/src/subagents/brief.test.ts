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

describe("splitSubagentBrief", () => {
  const user = (text: string): ThreadBlock => ({
    kind: "user",
    key: `user:${text}`,
    itemId: text,
    text,
    at: "2026-10-05T09:00:00.000Z",
  });
  const live: ThreadBlock = { kind: "live", key: "live", model: "claude-haiku-5" };

  it("takes the first block's user message out as the brief", () => {
    const later = user("And then?");
    expect(splitSubagentBrief([user("Read the docs"), live, later])).toEqual({
      brief: "Read the docs",
      blocks: [live, later],
    });
  });

  it("returns no brief and every block when the first block is not a user message with text", () => {
    const empty = user("");
    expect(splitSubagentBrief([])).toEqual({ brief: undefined, blocks: [] });
    expect(splitSubagentBrief([live, user("Late")])).toEqual({
      brief: undefined,
      blocks: [live, user("Late")],
    });
    expect(splitSubagentBrief([empty, live])).toEqual({ brief: undefined, blocks: [empty, live] });
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
