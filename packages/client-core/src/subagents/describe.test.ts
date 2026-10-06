/**
 * Tests the words a screen shows for one subagent: `nameSubagent`,
 * `nameSubagentParent`, `isSubagentWaiting`, `decideSubagentMark`, `decideSubagentPose`,
 * `describeSubagentState`,
 * `describeSubagentLine`, `formatTokenCount`, `formatSubagentTokens`,
 * `describeSubagentMeta` and `describeSubagentStop`.
 */
import { describe, expect, it } from "vitest";
import type { SessionRequest } from "@hercule/contract";
import {
  decideSubagentMark,
  decideSubagentPose,
  describeSubagentLine,
  describeSubagentMeta,
  describeSubagentState,
  describeSubagentStop,
  formatSubagentTokens,
  formatTokenCount,
  isSubagentWaiting,
  nameSubagent,
  nameSubagentParent,
} from "./describe";
import { buildRequest, buildSubagent } from "./subagents.testing";

const NOW = new Date("2026-10-05T09:16:02.000Z");

describe("nameSubagent", () => {
  it("names a subagent by its description", () => {
    expect(
      nameSubagent(buildSubagent({ id: "a", description: "Read the docs", agentType: "Explore" })),
    ).toBe("Read the docs");
  });

  it("falls back to its agent type, then to Subagent, while it has no description", () => {
    expect(nameSubagent(buildSubagent({ id: "a", agentType: "Explore" }))).toBe("Explore");
    expect(nameSubagent(buildSubagent({ id: "a" }))).toBe("Subagent");
  });
});

describe("nameSubagentParent", () => {
  const planner = buildSubagent({ id: "p", description: "Plan the migration" });
  const reader = buildSubagent({ id: "r", parentSubagentId: "p" });

  it("names the parent subagent", () => {
    expect(nameSubagentParent(reader, [planner, reader])).toBe("Plan the migration");
  });

  it("names the main agent when the session's own agent started it", () => {
    expect(nameSubagentParent(planner, [planner, reader])).toBe("the main agent");
  });
});

describe("isSubagentWaiting", () => {
  const requests = [buildRequest("r-1", "a"), buildRequest("r-2")];

  it("is true for a subagent with an open Request of its own, whatever its status", () => {
    expect(isSubagentWaiting(buildSubagent({ id: "a" }), requests)).toBe(true);
    expect(isSubagentWaiting(buildSubagent({ id: "a", status: "stopped" }), requests)).toBe(true);
  });

  it("is false for a subagent with no open Request of its own", () => {
    expect(isSubagentWaiting(buildSubagent({ id: "b" }), requests)).toBe(false);
  });
});

describe("decideSubagentMark", () => {
  it("marks a running subagent working, or waiting while it waits on the user", () => {
    expect(decideSubagentMark("running", false)).toBe("working");
    expect(decideSubagentMark("running", true)).toBe("waiting");
  });

  it("marks an ended subagent by how it ended, whether or not a Request is still open", () => {
    expect(decideSubagentMark("completed", true)).toBe("done");
    expect(decideSubagentMark("failed", true)).toBe("failed");
    expect(decideSubagentMark("stopped", false)).toBe("stopped");
  });
});

describe("decideSubagentPose", () => {
  it("poses a subagent as its mark, and a stopped one idle", () => {
    expect(decideSubagentPose("running", false)).toBe("working");
    expect(decideSubagentPose("running", true)).toBe("waiting");
    expect(decideSubagentPose("completed", false)).toBe("done");
    expect(decideSubagentPose("failed", false)).toBe("failed");
    expect(decideSubagentPose("stopped", true)).toBe("idle");
  });
});

describe("describeSubagentState", () => {
  it("measures a running subagent until now", () => {
    expect(describeSubagentState(buildSubagent({ id: "a" }), false, NOW)).toEqual({
      word: "working",
      hue: "live",
      duration: "16m 2s",
    });
  });

  it("reads waiting on you while it runs and waits", () => {
    expect(describeSubagentState(buildSubagent({ id: "a" }), true, NOW)).toMatchObject({
      word: "waiting on you",
      hue: "attn",
    });
  });

  it.each([
    ["completed", "done", "muted"],
    ["failed", "failed", "fail"],
    ["stopped", "stopped", "muted"],
  ] as const)("reads a %s subagent as %s in %s, measured until it ended", (status, word, hue) => {
    const ended = buildSubagent({ id: "a", status, endedAt: "2026-10-05T09:02:20.000Z" });
    expect(describeSubagentState(ended, true, NOW)).toEqual({ word, hue, duration: "2m 20s" });
  });
});

describe("describeSubagentLine", () => {
  const asked = { requestId: "r-1", itemId: "item-1", subagentId: "a" };
  const decisions = ["allow", "deny"] as const;
  const paths = { paths: ["checkout.ts"] };
  const question = { question: "Which bank?", header: "Bank", options: [], multiSelect: false };

  it.each<[string, SessionRequest]>([
    ["Waiting on you to allow a command", buildRequest("r-1", "a")],
    [
      "Waiting on you to allow a file change",
      { ...asked, kind: "file_change_approval", decisions, detail: paths },
    ],
    [
      "Waiting on you to allow a file read",
      { ...asked, kind: "file_read_approval", decisions, detail: paths },
    ],
    [
      "Waiting on you to allow a tool",
      { ...asked, kind: "tool_approval", decisions, detail: { toolName: "WebFetch" } },
    ],
    [
      "Waiting on you to answer a question",
      { ...asked, kind: "question", detail: { questions: [question] } },
    ],
  ])("reads %s while that kind of Request of its own is open", (text, request) => {
    const subagent = buildSubagent({ id: "a", activity: "Reading checkout.ts" });
    expect(describeSubagentLine(subagent, [buildRequest("r-0"), request])).toEqual({
      text,
      hue: "attn",
    });
  });

  it("shows what a running subagent does now", () => {
    const subagent = buildSubagent({ id: "a", activity: "Reading checkout.ts" });
    expect(describeSubagentLine(subagent, [])).toEqual({
      text: "Reading checkout.ts",
      hue: "live",
    });
  });

  it("shows the result of an ended subagent, in the fail hue when it failed", () => {
    const done = buildSubagent({ id: "a", status: "completed", result: "Found it" });
    expect(describeSubagentLine(done, [])).toEqual({ text: "Found it", hue: "muted" });
    expect(describeSubagentLine({ ...done, status: "failed" }, [])).toEqual({
      text: "Found it",
      hue: "fail",
    });
  });

  it("returns null while the record holds no line yet", () => {
    expect(describeSubagentLine(buildSubagent({ id: "a" }), [])).toBeNull();
    expect(describeSubagentLine(buildSubagent({ id: "a", status: "stopped" }), [])).toBeNull();
  });
});

describe("formatTokenCount", () => {
  it.each([
    [0, "0"],
    [950, "950"],
    [1000, "1.0k"],
    [41_700, "41.7k"],
    [999_949, "999.9k"],
    [999_950, "1.0M"],
    [1_200_000, "1.2M"],
  ])("formats %d as %s", (tokens, text) => {
    expect(formatTokenCount(tokens)).toBe(text);
  });
});

describe("formatSubagentTokens", () => {
  it("formats the count of the subagent's own Token Usage", () => {
    const usage = { inputTokens: 40_000, outputTokens: 1_000, cacheReadTokens: 700 };
    expect(formatSubagentTokens(buildSubagent({ id: "a", usage }))).toBe("41.7k");
  });

  it("returns undefined when the harness reported no count, rather than 0", () => {
    expect(formatSubagentTokens(buildSubagent({ id: "a" }))).toBeUndefined();
  });
});

describe("describeSubagentMeta", () => {
  it("joins the agent type, the model, the tokens and the tool calls", () => {
    const subagent = buildSubagent({
      id: "a",
      agentType: "Explore",
      model: "claude-sonnet-5",
      usage: { inputTokens: 40_000, outputTokens: 1_000, cacheReadTokens: 700 },
      toolCalls: 5,
    });
    expect(describeSubagentMeta(subagent)).toBe("Explore · claude-sonnet-5 · 41.7k tok · 5 tools");
  });

  it("leaves out what the record does not hold, tokens included, and counts one tool", () => {
    expect(describeSubagentMeta(buildSubagent({ id: "a", toolCalls: 1 }))).toBe("1 tool");
  });
});

describe("describeSubagentStop", () => {
  const planner = buildSubagent({ id: "p" });
  const reader = buildSubagent({ id: "r", parentSubagentId: "p" });
  const runner = buildSubagent({ id: "d", parentSubagentId: "r" });

  it("reads Stop, with no tooltip, when nothing is below the subagent", () => {
    expect(describeSubagentStop(runner, [planner, reader, runner])).toEqual({
      label: "Stop",
      title: undefined,
    });
  });

  it("counts every subagent below it, at any depth", () => {
    expect(describeSubagentStop(reader, [planner, reader, runner])).toEqual({
      label: "Stop with 1 below",
      title: "Also stops the subagent below it",
    });
    expect(describeSubagentStop(planner, [planner, reader, runner])).toEqual({
      label: "Stop with 2 below",
      title: "Also stops the 2 subagents below it",
    });
  });

  it("returns null once the subagent has ended", () => {
    expect(describeSubagentStop({ ...planner, status: "completed" }, [planner])).toBeNull();
  });
});
