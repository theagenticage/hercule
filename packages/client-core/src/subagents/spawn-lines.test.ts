/**
 * Tests `findSpawnedSubagents`, which finds the subagents a turn started,
 * and `buildSpawnLines`, which builds one line per subagent.
 */
import { describe, expect, it } from "vitest";
import type { ThreadItem, ThreadTurn } from "../threads/turns";
import { buildSpawnLines, findSpawnedSubagents } from "./spawn-lines";
import { buildRequest, buildSubagent } from "./subagents.testing";

const NOW = new Date("2026-10-05T09:01:30.000Z");

/** Builds a completed item of the turn. */
const buildItem = (itemId: string, kind: ThreadItem["kind"]): ThreadItem => ({
  itemId,
  kind,
  verb: kind,
  target: "",
  result: "completed",
});

const TURN: ThreadTurn = {
  turnId: "t-1",
  user: "Fix the redirect",
  items: [
    buildItem("spawn-b", "subagent"),
    buildItem("cmd", "command_execution"),
    buildItem("spawn-a", "subagent"),
    buildItem("spawn-unread", "subagent"),
  ],
  assistantText: "",
  startedAt: "2026-10-05T09:00:00.000Z",
  duration: null,
  endState: null,
};

const A = buildSubagent({ id: "a", itemId: "spawn-a", description: "Check the redirect" });
const B = buildSubagent({
  id: "b",
  itemId: "spawn-b",
  description: "Read the docs",
  status: "completed",
  endedAt: "2026-10-05T09:00:45.000Z",
});
const A1 = buildSubagent({ id: "a1", parentSubagentId: "a", itemId: "spawn-a1" });
const A1X = buildSubagent({ id: "a1x", parentSubagentId: "a1", itemId: "spawn-a1x" });
// A subagent of `a` whose item id is the same as `b`'s: an item id is
// unique only within one agent's transcript.
const A2 = buildSubagent({ id: "a2", parentSubagentId: "a", itemId: "spawn-b" });
const SUBAGENTS = [B, A, A1, A1X, A2];

describe("findSpawnedSubagents", () => {
  it("finds the subagents of the turn's subagent items whose record is read, ordered by start and then by id", () => {
    expect(findSpawnedSubagents(TURN, undefined, SUBAGENTS).map((each) => each.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("takes any run of items, such as one work stretch of a turn", () => {
    const stretch = { items: [buildItem("spawn-a", "subagent")] };
    expect(findSpawnedSubagents(stretch, undefined, SUBAGENTS).map((each) => each.id)).toEqual([
      "a",
    ]);
  });

  it("leaves out a subagent another agent started, even when its item id matches", () => {
    expect(findSpawnedSubagents(TURN, "a", SUBAGENTS).map((each) => each.id)).toEqual(["a2"]);
  });
});

describe("buildSpawnLines", () => {
  it("builds one line per subagent, in the order given", () => {
    expect(buildSpawnLines([B, A], SUBAGENTS, [], NOW)).toEqual([
      {
        subagentId: "b",
        status: "completed",
        waiting: false,
        name: "Read the docs",
        state: { word: "done", hue: "muted", duration: "45s" },
        notes: [],
      },
      {
        subagentId: "a",
        status: "running",
        waiting: false,
        name: "Check the redirect",
        state: { word: "working", hue: "live", duration: "1m 30s" },
        notes: [{ text: "3 below", hue: "muted" }],
      },
    ]);
  });

  it("says one waits on the user when a subagent below it asks, without marking it waiting itself", () => {
    const [a] = buildSpawnLines([A], SUBAGENTS, [buildRequest("r-1", "a1x")], NOW);

    expect(a).toMatchObject({
      waiting: false,
      state: { word: "working" },
      notes: [
        { text: "3 below", hue: "muted" },
        { text: "one waits on you", hue: "attn" },
      ],
    });
  });

  it("counts the subagents below it that wait on the user when there are several", () => {
    const [a] = buildSpawnLines(
      [A],
      SUBAGENTS,
      [buildRequest("r-1", "a1x"), buildRequest("r-2", "a2")],
      NOW,
    );

    expect(a?.notes).toEqual([
      { text: "3 below", hue: "muted" },
      { text: "2 wait on you", hue: "attn" },
    ]);
  });

  it("marks a subagent that asks itself as waiting on you, without saying one below waits", () => {
    const [a] = buildSpawnLines([A], SUBAGENTS, [buildRequest("r-1", "a")], NOW);

    expect(a).toMatchObject({
      waiting: true,
      state: { word: "waiting on you" },
      notes: [{ text: "3 below", hue: "muted" }],
    });
  });
});
