/**
 * Tests what the controller does with a session's waiting input when the
 * runner reports that the session exited, over the runner socket against a
 * real controller and one fake runner.
 *
 * An `idle_unload` exit is the runner taking an idle process down to save
 * memory. The session is resumable and the input was meant for it, so the
 * input is kept and the session is resumed in place at once, and the input
 * runs exactly once. That holds for a Thread as much as for a conversation's
 * session. Any other exit cancels the waiting input, as before.
 */
import { describe, expect, it, vi } from "vitest";
import type { ExitReason, SessionInput } from "@hercule/protocol";
import type { Session } from "@hercule/contract";
import {
  WAIT_DEADLINE_MS,
  at,
  listInputs,
  readSession,
  reportEvent,
  spawnSessionOrFail,
  waitForSession,
  waitForStartFrames,
  waitUntil,
  withAgentFleet,
  type Arranged,
} from "../../sessions/testing";
import {
  listConversationSessions,
  readDefaultConversation,
  runTurn,
  sendMessage,
  startConversationSession,
} from "../../conversations/testing";
import { post } from "../../http/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

/** Reports that the session's process exited for `reason`, and waits until the controller has applied it. */
const reportExit = async (
  arranged: Arranged,
  sessionId: string,
  seq: number,
  reason: ExitReason,
): Promise<void> => {
  reportEvent(arranged.wire, seq, {
    eventId: crypto.randomUUID(),
    sessionId,
    at,
    _tag: "session.exited",
    reason,
  });
  // The resume may already have moved the session on, so any status other
  // than `busy` or `idle` shows the exit was applied.
  await waitUntil("applied the exit", async () => {
    const found = await readSession(arranged, sessionId);
    return found.status !== "busy" && found.status !== "idle" ? found : undefined;
  });
};

/** Starts the default assistant's conversation session with the message "hi", and returns it idle. */
const startSession = async (arranged: Arranged): Promise<Session> => {
  const { conversation } = await readDefaultConversation(arranged);
  return await startConversationSession(arranged, conversation.id, "hi");
};

/** Returns the input frames for one input that the runner received after the session's `index`-th start frame. */
const listInputFramesAfterStart = (
  arranged: Arranged,
  sessionId: string,
  index: number,
  inputId: string,
): ReadonlyArray<SessionInput> => {
  const starts = arranged.wire.frames
    .map((frame, position) => ({ frame, position }))
    .filter(({ frame }) => frame._tag === "sessionStart" && frame.sessionId === sessionId);
  const from = starts[index]?.position ?? arranged.wire.frames.length;
  return arranged.wire.frames
    .slice(from)
    .filter(
      (frame): frame is SessionInput =>
        frame._tag === "sessionInput" && frame.requestId === inputId,
    );
};

/**
 * Checks that an exited session with a waiting input was resumed in place:
 * the runner receives a second start frame that resumes the native session,
 * and once the resumed process reports `session.started`, the input is sent
 * exactly once and delivered. For a conversation's session, it also checks
 * that no second session was made for the conversation.
 */
const expectResumedAndRunOnce = async (
  arranged: Arranged,
  session: Session,
  inputId: string,
): Promise<void> => {
  const frames = await waitForStartFrames(arranged, session.id, 2);
  expect(frames[1]!.spec.continue).toEqual({ mode: "resume", nativeSessionId: "native-1" });
  if (session.conversationId !== null) {
    expect(await listConversationSessions(arranged, session.conversationId)).toHaveLength(1);
  }

  // Sequence numbers start again at 1 for each start of a session.
  reportEvent(arranged.wire, 1, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "session.started",
    providerRefs: { nativeSessionId: "native-1" },
  });
  const delivered = await waitUntil("delivered the kept input", async () => {
    const row = (await listInputs(arranged, session.id)).find((one) => one.id === inputId);
    return row?.status === "delivered" ? row : undefined;
  });
  expect(delivered.text).toBe("again");
  expect(listInputFramesAfterStart(arranged, session.id, 1, inputId)).toHaveLength(1);
};

describe("an idle_unload exit with input waiting", () => {
  it("keeps a queued input, resumes the session in place at once, and runs the input once", async () => {
    await withAgentFleet(async (arranged) => {
      const session = await startSession(arranged);
      // A busy session holds the next message in its queue, unsent. The runner
      // only unloads an idle process, but the controller sees only the
      // report, so reporting it here is how the test holds a queued row at
      // the moment of the exit.
      reportEvent(arranged.wire, 2, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "turn.started",
        turnId: "t1",
      });
      await waitForSession(arranged, session.id, (one) => one.status === "busy");
      await sendMessage(arranged, session.conversationId!, "again");
      const queued = (await listInputs(arranged, session.id)).find((one) => one.text === "again");
      expect(queued).toMatchObject({ status: "queued", sentAt: null });

      await reportExit(arranged, session.id, 3, "idle_unload");

      const kept = (await listInputs(arranged, session.id)).find((one) => one.id === queued!.id);
      expect(kept?.status).not.toBe("cancelled");
      await expectResumedAndRunOnce(arranged, session, queued!.id);
    });
  });

  it("keeps an input the runner received but never answered, resumes the session, and runs the input once", async () => {
    await withAgentFleet(async (arranged) => {
      const session = await startSession(arranged);
      const next = await runTurn(arranged, session.id, 2, "t1", ["hello"]);
      // The process is going down, so the runner never answers the frame.
      arranged.wire.answering(() => undefined);
      await sendMessage(arranged, session.conversationId!, "again");
      const sent = await waitUntil("sent the message to the runner", async () => {
        const row = (await listInputs(arranged, session.id)).find((one) => one.text === "again");
        return row?.sentAt !== null && row !== undefined ? row : undefined;
      });

      await reportExit(arranged, session.id, next, "idle_unload");
      arranged.wire.answering(() => "opened");

      const kept = (await listInputs(arranged, session.id)).find((one) => one.id === sent.id);
      expect(kept?.status).not.toBe("cancelled");
      await expectResumedAndRunOnce(arranged, session, sent.id);
    });
  });
});

describe("an idle_unload exit of a Thread with input waiting", () => {
  it("resumes the Thread in place and runs the input once, like a conversation's session", async () => {
    // The rule is about the session, not about who talks to it: any session
    // the runner unloaded while input waited for it comes back for the input.
    await withAgentFleet(async (arranged) => {
      const thread = await spawnSessionOrFail(arranged, { prompt: "hello" });
      await waitForStartFrames(arranged, thread.id, 1);
      reportEvent(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: thread.id,
        at,
        _tag: "session.started",
        providerRefs: { nativeSessionId: "native-1" },
      });
      reportEvent(arranged.wire, 2, {
        eventId: crypto.randomUUID(),
        sessionId: thread.id,
        at,
        _tag: "turn.started",
        turnId: "t1",
      });
      await waitForSession(arranged, thread.id, (one) => one.status === "busy");
      const input = await post(
        arranged.harness.base,
        `/api/v1/sessions/${thread.id}/input`,
        { text: "again" },
        arranged.token,
      );
      expect(input.status, await input.clone().text()).toBe(200);
      const queued = (await listInputs(arranged, thread.id)).find((one) => one.text === "again");
      expect(queued).toMatchObject({ status: "queued", sentAt: null });

      await reportExit(arranged, thread.id, 3, "idle_unload");

      await expectResumedAndRunOnce(arranged, await readSession(arranged, thread.id), queued!.id);
    });
  });
});

describe("an exit for any other reason with input waiting", () => {
  it("cancels the queued input, as before", async () => {
    await withAgentFleet(async (arranged) => {
      const session = await startSession(arranged);
      reportEvent(arranged.wire, 2, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "turn.started",
        turnId: "t1",
      });
      await waitForSession(arranged, session.id, (one) => one.status === "busy");
      await sendMessage(arranged, session.conversationId!, "again");
      const queued = (await listInputs(arranged, session.id)).find((one) => one.text === "again");

      await reportExit(arranged, session.id, 3, "stopped");

      const cancelled = await waitUntil("cancelled the queued input", async () => {
        const row = (await listInputs(arranged, session.id)).find((one) => one.id === queued!.id);
        return row?.status === "cancelled" ? row : undefined;
      });
      expect(cancelled.reason).toContain("exited (");
      expect(
        (await waitForSession(arranged, session.id, (one) => one.status === "exited")).status,
      ).toBe("exited");
    });
  });
});
