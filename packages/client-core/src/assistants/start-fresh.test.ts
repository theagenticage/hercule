/**
 * Tests `decideStartFresh(session)`: Start fresh is offered only for a
 * conversation whose session has started working, and otherwise comes with
 * the reason it is not.
 */
import { describe, expect, it } from "vitest";
import { buildSession } from "../threads/workspaces.testing";
import { decideStartFresh } from "./start-fresh";

describe("decideStartFresh", () => {
  it("is unavailable, with its reason, while the conversation has no session yet", () => {
    expect(decideStartFresh(null)).toEqual({
      available: false,
      reason: "No session yet. Send a message to start one.",
    });
  });

  it("is unavailable, with its reason, for a session that has not started", () => {
    const session = buildSession({ id: "s1", conversationId: "c1", startedAt: null });

    expect(decideStartFresh(session)).toEqual({
      available: false,
      reason: "No turn yet. The session has not started working.",
    });
  });

  it("is available for a session that has started, running or idle-unloaded", () => {
    const started = buildSession({
      id: "s1",
      conversationId: "c1",
      startedAt: "2026-10-16T08:00:00.000Z",
    });

    expect(decideStartFresh(started)).toEqual({ available: true });
    expect(decideStartFresh({ ...started, status: "exited" })).toEqual({ available: true });
  });
});
