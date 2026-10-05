/**
 * Tests `buildSessionAgentState` and `buildSubagentAgentState`, which read
 * the state of one agent of a session from its records: whether it works,
 * whether a harness process runs it, its own open Requests and its model.
 */
import { describe, expect, it } from "vitest";
import type { SessionRequest, Subagent } from "@hercule/contract";
import { buildSessionAgentState, buildSubagentAgentState } from "./agent-state";
import { buildSession } from "./workspaces.testing";

const buildRequest = (requestId: string, subagentId?: string): SessionRequest => ({
  requestId,
  itemId: `item-${requestId}`,
  kind: "command_approval",
  decisions: ["allow", "deny"],
  detail: { command: "git push" },
  ...(subagentId === undefined ? {} : { subagentId }),
});

const SUBAGENT: Subagent = {
  id: "agent-1",
  sessionId: "s-1",
  status: "running",
  toolCalls: 2,
  startedAt: "2026-10-05T09:00:00.000Z",
};

const SESSION = buildSession({
  id: "s-1",
  status: "busy",
  openRequests: [
    buildRequest("r-1", "agent-1"),
    buildRequest("r-2"),
    buildRequest("r-3", "agent-2"),
  ],
});

describe("buildSessionAgentState", () => {
  it("keeps only the Requests the session's own agent asked, oldest first", () => {
    expect(buildSessionAgentState(SESSION).openRequests.map((r) => r.requestId)).toEqual(["r-2"]);
  });

  it.each([
    ["starting", true, true],
    ["busy", true, true],
    ["idle", false, true],
    ["queued", false, false],
    ["exited", false, false],
  ] as const)("reads a %s session as working=%s, harnessRunning=%s", (status, working, running) => {
    expect(buildSessionAgentState({ ...SESSION, status })).toMatchObject({
      working,
      harnessRunning: running,
    });
  });

  it("takes the session's model", () => {
    expect(buildSessionAgentState(SESSION).model).toBe(SESSION.modelSelection.model);
  });
});

describe("buildSubagentAgentState", () => {
  it("keeps only the Requests the subagent asked", () => {
    expect(buildSubagentAgentState(SUBAGENT, SESSION).openRequests.map((r) => r.requestId)).toEqual(
      ["r-1"],
    );
  });

  it("works while the subagent runs, and not after it ended", () => {
    expect(buildSubagentAgentState(SUBAGENT, SESSION).working).toBe(true);
    expect(buildSubagentAgentState({ ...SUBAGENT, status: "completed" }, SESSION).working).toBe(
      false,
    );
  });

  it("reads whether a harness runs from the session, which hosts the subagent", () => {
    expect(buildSubagentAgentState(SUBAGENT, { ...SESSION, status: "exited" }).harnessRunning).toBe(
      false,
    );
  });

  it("takes the subagent's model, and the session's when the subagent names none", () => {
    expect(buildSubagentAgentState({ ...SUBAGENT, model: "claude-haiku-5" }, SESSION).model).toBe(
      "claude-haiku-5",
    );
    expect(buildSubagentAgentState(SUBAGENT, SESSION).model).toBe(SESSION.modelSelection.model);
  });
});
