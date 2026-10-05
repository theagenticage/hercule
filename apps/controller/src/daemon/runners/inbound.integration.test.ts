/**
 * Tests what the controller does with a session's waiting input when the
 * runner reports that the session exited, over the runner socket against a
 * real controller and one fake runner.
 *
 * - A conversation's session keeps its waiting input through any exit, and
 *   is resumed in place at once, so the input runs exactly once.
 * - A Thread keeps no waiting input through an exit, an `idle_unload`
 *   included: the input is cancelled.
 * - The crash-loop guard: a resumed session that exits before starting any
 *   turn is not resumed again for the same input. The input waits for the
 *   next message.
 */
import { describe, expect, it, vi } from "vitest";
import { Duration } from "effect";
import type { ExitReason } from "@hercule/protocol";
import type { Session } from "@hercule/contract";
import {
  WAIT_DEADLINE_MS,
  at,
  listFrames,
  listInputs,
  readSession,
  reportEvent,
  spawnSessionOrFail,
  waitForSession,
  waitForStartFrames,
  waitUntil,
  withAgentFleet,
  type Arranged,
  type InputCarrier,
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

/**
 * Starts a conversation session and puts it in a turn, then sends the message
 * "again", which the runner refuses to steer. The message is left queued and
 * unsent, and the session busy. The runner's next sequence number is 3, and
 * it accepts every later input.
 */
const holdQueuedMessage = async (
  arranged: Arranged,
): Promise<{ session: Session; inputId: string }> => {
  const session = await startSession(arranged);
  reportEvent(arranged.wire, 2, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "turn.started",
    turnId: "t1",
  });
  await waitForSession(arranged, session.id, (one) => one.status === "busy");
  arranged.wire.answering(() => ({ message: "no steering now" }));
  await sendMessage(arranged, session.conversationId!, "again");
  const queued = await waitUntil("put the refused steer back in the queue", async () => {
    const row = (await listInputs(arranged, session.id)).find((one) => one.text === "again");
    return row?.status === "queued" && row.sentAt === null && row.reason !== null ? row : undefined;
  });
  arranged.wire.answering(() => "opened");
  return { session, inputId: queued.id };
};

/** Reports that the resumed process of the session started, with sequence number 1. */
const reportResumed = (arranged: Arranged, sessionId: string): void =>
  reportEvent(arranged.wire, 1, {
    eventId: crypto.randomUUID(),
    sessionId,
    at,
    _tag: "session.started",
    providerRefs: { nativeSessionId: "native-1" },
  });

/** Waits long enough for several passes of the queued-input sweep to have run. */
const letTheSweepRun = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300));

/**
 * Returns the frames that carried one input to the runner from the session's
 * `index`-th start frame on, that start frame included: a start frame carries
 * the session's first input, and a `sessionInput` carries each later one.
 */
const listCarriersSinceStart = (
  arranged: Arranged,
  sessionId: string,
  index: number,
  inputId: string,
): ReadonlyArray<InputCarrier> => {
  const starts = arranged.wire.frames
    .map((frame, position) => ({ frame, position }))
    .filter(({ frame }) => frame._tag === "sessionStart" && frame.sessionId === sessionId);
  const from = starts[index]?.position ?? arranged.wire.frames.length;
  return arranged.wire.frames
    .slice(from)
    .filter(
      (frame): frame is InputCarrier =>
        (frame._tag === "sessionInput" || frame._tag === "sessionStart") &&
        frame.requestId === inputId,
    );
};

/**
 * Checks that an exited session with a waiting input was resumed in place:
 * the runner receives a second start frame that resumes the native session
 * and carries the input. The runner's answer to that start delivers the
 * input, and no input frame sends it again. For a conversation's session, it
 * also checks that no second session was made for the conversation.
 */
const expectResumedAndRunOnce = async (
  arranged: Arranged,
  session: Session,
  inputId: string,
): Promise<void> => {
  const frames = await waitForStartFrames(arranged, session.id, 2);
  expect(frames[1]!.spec.continue).toEqual({ mode: "resume", nativeSessionId: "native-1" });
  expect(frames[1]!.requestId).toBe(inputId);
  if (session.conversationId !== null) {
    expect(await listConversationSessions(arranged, session.conversationId)).toHaveLength(1);
  }

  const delivered = await waitUntil("delivered the kept input", async () => {
    const row = (await listInputs(arranged, session.id)).find((one) => one.id === inputId);
    return row?.status === "delivered" ? row : undefined;
  });
  expect(delivered.text).toBe("again");
  await letTheSweepRun();
  expect(
    listCarriersSinceStart(arranged, session.id, 1, inputId).map((frame) => frame._tag),
  ).toEqual(["sessionStart"]);
};

/**
 * The sweep runs often in these tests, and an input the runner does not
 * answer is given up on quickly, so a test that waits for either stays short.
 */
const FAST: Parameters<typeof withAgentFleet>[1] = {
  eventRoutingInterval: Duration.millis(50),
  inputDeadline: Duration.millis(300),
};

describe("an exit of a conversation's session with input waiting", () => {
  it.each<ExitReason>(["idle_unload", "crash", "stopped", "process_exit"])(
    "keeps a queued input through a %s exit, resumes the session in place at once, and runs the input once",
    async (reason) => {
      await withAgentFleet(async (arranged) => {
        const { session, inputId } = await holdQueuedMessage(arranged);

        await reportExit(arranged, session.id, 3, reason);

        const kept = (await listInputs(arranged, session.id)).find((one) => one.id === inputId);
        expect(kept?.status).not.toBe("cancelled");
        await expectResumedAndRunOnce(arranged, session, inputId);
      });
    },
  );

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
    }, FAST);
  });

  it("neither sends twice nor loses an input that was on the wire at the exit, when a second message tries to deliver", async () => {
    await withAgentFleet(async (arranged) => {
      const session = await startSession(arranged);
      const next = await runTurn(arranged, session.id, 2, "t1", ["hello"]);
      arranged.wire.answering(() => undefined);
      await sendMessage(arranged, session.conversationId!, "again");
      const sent = await waitUntil("sent the message to the runner", async () => {
        const row = (await listInputs(arranged, session.id)).find((one) => one.text === "again");
        return row?.sentAt !== null && row !== undefined ? row : undefined;
      });
      await reportExit(arranged, session.id, next, "crash");
      arranged.wire.answering(() => "opened");

      // A second delivery attempt while the first input is still on the
      // wire: the owner's next message, and every sweep pass besides.
      await sendMessage(arranged, session.conversationId!, "and again");
      await letTheSweepRun();
      // The session is resumed once, after the first send gave up.
      const frames = await waitForStartFrames(arranged, session.id, 2);
      expect(frames[1]!.spec.continue).toEqual({ mode: "resume", nativeSessionId: "native-1" });
      const first = await waitUntil("delivered the input that was on the wire", async () => {
        const row = (await listInputs(arranged, session.id)).find((one) => one.id === sent.id);
        return row?.status === "delivered" ? row : undefined;
      });
      expect(first.text).toBe("again");
      await letTheSweepRun();

      expect(listFrames(arranged.wire, "sessionStart")).toHaveLength(2);
      // Sent once to the process that crashed, and once more on the start
      // that resumed the session: the older input rides the start, ahead of
      // the newer one.
      expect(
        listCarriersSinceStart(arranged, session.id, 0, sent.id).map((frame) => frame._tag),
      ).toEqual(["sessionInput", "sessionStart"]);
      const second = (await listInputs(arranged, session.id)).find(
        (one) => one.text === "and again",
      );
      expect(second?.status).not.toBe("cancelled");
    }, FAST);
  });
});

describe("the crash-loop guard", () => {
  it("does not resume a session that exits before starting a turn, until a new message arrives", async () => {
    await withAgentFleet(async (arranged) => {
      const { session, inputId } = await holdQueuedMessage(arranged);
      // The resumed process dies before it has started, so before any turn.
      // A runner whose start fails refuses the input the start carries, and
      // then reports the exit.
      arranged.wire.answering(() => ({ message: "the harness crashed" }));
      await reportExit(arranged, session.id, 3, "crash");
      await waitForStartFrames(arranged, session.id, 2);
      await waitUntil("put the refused start input back to waiting", async () => {
        const row = (await listInputs(arranged, session.id)).find((one) => one.id === inputId);
        return row?.sentAt === null && row.reason === "the harness crashed" ? row : undefined;
      });
      await reportExit(arranged, session.id, 1, "crash");
      await letTheSweepRun();

      expect(listFrames(arranged.wire, "sessionStart")).toHaveLength(2);
      const held = await waitForSession(arranged, session.id, (one) => one.resumeHeld);
      expect(held.status).toBe("exited");
      expect(
        (await listInputs(arranged, session.id)).find((one) => one.id === inputId)?.status,
      ).toBe("queued");

      // A new message lifts the hold: the session is resumed for every input
      // that waits.
      arranged.wire.answering(() => "opened");
      await sendMessage(arranged, session.conversationId!, "are you there?");
      await waitForStartFrames(arranged, session.id, 3);
      expect((await readSession(arranged, session.id)).resumeHeld).toBe(false);
    }, FAST);
  });
});

describe("an exit of a Thread with input waiting", () => {
  /** Spawns a Thread, starts it and puts it in a turn, then queues the input "again" for it. */
  const holdQueuedThreadInput = async (arranged: Arranged) => {
    const thread = await spawnSessionOrFail(arranged, { prompt: "hello" });
    await waitForStartFrames(arranged, thread.id, 1);
    reportResumed(arranged, thread.id);
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
    return { thread, inputId: queued!.id };
  };

  // An idle unload is no exception: only a conversation's session keeps its
  // input through an exit.
  it.each<ExitReason>(["idle_unload", "stopped"])(
    "cancels the queued input for a %s exit, and does not resume the Thread",
    async (reason) => {
      await withAgentFleet(async (arranged) => {
        const { thread, inputId } = await holdQueuedThreadInput(arranged);

        await reportExit(arranged, thread.id, 3, reason);

        const cancelled = await waitUntil("cancelled the queued input", async () => {
          const row = (await listInputs(arranged, thread.id)).find((one) => one.id === inputId);
          return row?.status === "cancelled" ? row : undefined;
        });
        expect(cancelled.reason).toContain("exited (");
        expect(listFrames(arranged.wire, "sessionStart")).toHaveLength(1);
      });
    },
  );
});
