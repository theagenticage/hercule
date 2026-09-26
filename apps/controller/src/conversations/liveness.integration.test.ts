/**
 * Tests that two messages an hour apart land in the same session, on the
 * controller's side, through `conversation.send` and the runner socket
 * against a real controller and one fake runner.
 *
 * The controller keeps no idle timer: the runner decides when to unload an
 * idle process and reports `session.exited { reason: "idle_unload" }`. The
 * hour of waiting is the runner supervisor's test. Here the fake runner
 * reports the unload straight away, and the next message resumes the same
 * session in place.
 */
import { describe, expect, it, vi } from "vitest";
import type { ProviderEvent } from "@hercule/protocol";
import { get } from "../http/testing";
import {
  WAIT_DEADLINE_MS,
  at,
  reportEvent,
  waitForSession,
  waitForStartFrames,
  waitUntil,
  withAgentFleet,
  type Arranged,
} from "../sessions/testing";
import {
  listConversationSessions,
  readDefaultConversation,
  runTurn,
  sendMessage,
  startConversationSession,
} from "./testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

/** Returns the ids of the turns in a session's transcript that completed, oldest first. */
const listCompletedTurns = async (
  arranged: Arranged,
  sessionId: string,
): Promise<ReadonlyArray<string>> => {
  const response = await get(
    arranged.harness.base,
    `/api/v1/sessions/${sessionId}/transcript`,
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const page = (await response.json()) as {
    items: ReadonlyArray<{ position: number; event: ProviderEvent }>;
  };
  return page.items.flatMap((row) =>
    row.event._tag === "turn.completed" ? [row.event.turnId] : [],
  );
};

describe("a message after the runner unloaded the idle session", () => {
  it("resumes the same session on the same runner, and its transcript holds both turns", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation } = await readDefaultConversation(arranged);
      const session = await startConversationSession(arranged, conversation.id, "first", "N");
      const next = await runTurn(arranged, session.id, 2, "t1", ["answer one"]);
      reportEvent(arranged.wire, next, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "session.exited",
        reason: "idle_unload",
      });
      await waitForSession(arranged, session.id, (one) => one.status === "exited");

      await sendMessage(arranged, conversation.id, "second");

      const frames = await waitForStartFrames(arranged, session.id, 2);
      expect(frames[1]!.spec.continue).toEqual({ mode: "resume", nativeSessionId: "N" });
      const sessions = await listConversationSessions(arranged, conversation.id);
      expect(sessions.map((one) => one.id)).toEqual([session.id]);
      expect(sessions[0]!.runnerId).toBe(arranged.runnerId);

      // Sequence numbers start again at 1 for the resumed process.
      reportEvent(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "session.started",
        providerRefs: { nativeSessionId: "N" },
      });
      await waitForSession(arranged, session.id, (one) => one.status === "busy");
      await runTurn(arranged, session.id, 2, "t2", ["answer two"]);

      const turns = await waitUntil("wrote the second turn", async () => {
        const found = await listCompletedTurns(arranged, session.id);
        return found.length >= 2 ? found : undefined;
      });
      expect(turns).toEqual(["t1", "t2"]);
    });
  });
});
