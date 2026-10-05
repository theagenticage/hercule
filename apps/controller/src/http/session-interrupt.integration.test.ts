/**
 * Tests the bodies `POST /sessions/:id/interrupt` accepts, over HTTP against a
 * real controller and one fake runner. The body is optional: agents, scripts
 * and older clients send the request with no body at all, and that must
 * interrupt all work in the session just as `{}` does.
 */
import { describe, expect, it, vi } from "vitest";
import type { SessionInterrupt } from "@hercule/protocol";
import type { Session } from "@hercule/contract";
import { send } from "./testing";
import {
  WAIT_DEADLINE_MS,
  at,
  listFrames,
  reportEvent,
  spawnSessionOrFail,
  waitForFrames,
  waitForSession,
  waitForStartFrames,
  withAgentFleet,
  type Arranged,
} from "../sessions/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

/** Spawns a session and has its runner report it started, so it is busy. */
const startBusySession = async (arranged: Arranged): Promise<Session> => {
  const session = await spawnSessionOrFail(arranged, { prompt: "hello" });
  await waitForStartFrames(arranged, session.id, 1);
  reportEvent(arranged.wire, 1, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "session.started",
  });
  return await waitForSession(arranged, session.id, (one) => one.status === "busy");
};

describe("session.interrupt request bodies", () => {
  it("interrupts all work when the request has no body and no content type", async () => {
    await withAgentFleet(async (arranged) => {
      const session = await startBusySession(arranged);

      const response = await fetch(
        `${arranged.harness.base}/api/v1/sessions/${session.id}/interrupt`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${arranged.token}`, connection: "close" },
        },
      );

      expect(response.status, await response.clone().text()).toBe(200);
      const [frame] = await waitForFrames<SessionInterrupt>(arranged.wire, "sessionInterrupt", 1);
      expect(frame).toEqual({ _tag: "sessionInterrupt", sessionId: session.id });
    });
  });

  it("interrupts all work when the body is empty and the content type is JSON", async () => {
    await withAgentFleet(async (arranged) => {
      const session = await startBusySession(arranged);

      const response = await send(
        "POST",
        arranged.harness.base,
        `/api/v1/sessions/${session.id}/interrupt`,
        { token: arranged.token },
      );

      expect(response.status, await response.clone().text()).toBe(200);
      const [frame] = await waitForFrames<SessionInterrupt>(arranged.wire, "sessionInterrupt", 1);
      expect(frame).toEqual({ _tag: "sessionInterrupt", sessionId: session.id });
    });
  });

  it("refuses a subagent the session has no record of with not_found", async () => {
    await withAgentFleet(async (arranged) => {
      const session = await startBusySession(arranged);

      const response = await send(
        "POST",
        arranged.harness.base,
        `/api/v1/sessions/${session.id}/interrupt`,
        { token: arranged.token, body: { subagentId: "nobody" } },
      );

      expect(response.status, await response.clone().text()).toBe(404);
      expect(listFrames<SessionInterrupt>(arranged.wire, "sessionInterrupt")).toEqual([]);
    });
  });
});
