/**
 * Tests `buildSpawnLines`, which builds one line per subagent a turn
 * started.
 */
import { describe, expect, it } from "vitest";
import type { ThreadItem, ThreadTurn } from "../threads/turns";
import { buildSpawnLines } from "./spawn-lines";
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
const SUBAGENTS = [A, B, A1, A1X];

describe("buildSpawnLines", () => {
  it("builds one line per subagent item whose record is read, in item order", () => {
    const lines = buildSpawnLines(TURN, SUBAGENTS, [], NOW);

    expect(lines).toEqual([
      {
        subagentId: "b",
        status: "completed",
        waiting: false,
        name: "Read the docs",
        state: { word: "done", hue: "muted", duration: "45s" },
        below: 0,
        waitsOnYou: false,
      },
      {
        subagentId: "a",
        status: "running",
        waiting: false,
        name: "Check the redirect",
        state: { word: "working", hue: "live", duration: "1m 30s" },
        below: 2,
        waitsOnYou: false,
      },
    ]);
  });

  it("says one waits on you when a subagent below it asks, without marking it waiting itself", () => {
    const [, a] = buildSpawnLines(TURN, SUBAGENTS, [buildRequest("r-1", "a1x")], NOW);

    expect(a).toMatchObject({ waiting: false, waitsOnYou: true, state: { word: "working" } });
  });

  it("marks a subagent that asks itself as waiting on you", () => {
    const [, a] = buildSpawnLines(TURN, SUBAGENTS, [buildRequest("r-1", "a")], NOW);

    expect(a).toMatchObject({ waiting: true, waitsOnYou: true, state: { word: "waiting on you" } });
  });
});
