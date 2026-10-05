/**
 * Tests the notices an assistant's conversation gets when a session ends, from
 * what the fake runner reports on the runner socket, against a real
 * controller.
 *
 * A notice is a conversation message from the assistant, with sender role
 * `notice`, stamped with the system. There are two:
 *
 * - "<name> was interrupted: <why>", when a reply was cut off: a turn failed
 *   or was stopped while the session lives, or the session exited while a
 *   turn was running,
 *   however it ended: an exit the runner reports, or a runner that restarted,
 *   was retired or was lost;
 * - "<name> can't be reached: <why>", when a message waits for a session that
 *   exited and cannot be resumed, such as one that exited before it ever
 *   started, or for a resumed session that exited before it started a turn.
 *
 * A stopped turn writes the reply text it produced, then its notice. An exit
 * while idle writes none, a message still waiting
 * included: the message is kept for the resumed process. A Thread writes
 * none at all.
 */
import { describe, expect, it, vi } from "vitest";
import { Duration, Effect } from "effect";
import type { ExitReason } from "@hercule/protocol";
import type { Conversation, ConversationMessage, Session } from "@hercule/contract";
import { get, post, send } from "../http/testing";
import {
  WAIT_DEADLINE_MS,
  at,
  listInputs,
  reportEvent,
  spawnSessionOrFail,
  waitForSession,
  waitForStartFrames,
  waitUntil,
  withAgentFleet,
  type Arranged,
} from "../sessions/testing";
import {
  listMessages,
  readDefaultConversation,
  runTurn,
  sendMessage,
  startConversationSession,
  waitForConversationSessions,
} from "../conversations/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

/**
 * The notice for the message that queued a session that exited before it
 * started. The message is kept for a resume, but a session that never started
 * has no transcript to resume, so the queued-input sweep gives up on it.
 */
const NEVER_STARTED =
  "Ada can't be reached: its session could not be resumed (that session left no " +
  "provider-native session, so its transcript is gone and there is nothing to resume); " +
  "send the message again to start a new session";

/** The conversation of these tests: the default assistant's, renamed to Ada, and its session, busy with the turn "hi" opened. */
interface AdaConversation {
  readonly conversation: Conversation;
  readonly session: Session;
}

/**
 * Renames the default assistant to Ada, sets its reply mode, and starts its
 * conversation session with the message "hi". The runner answers that "hi"
 * opened a turn and reports nothing more, so the session is `busy` until the
 * test reports that turn's end. The runner's next sequence number for the
 * session is 2.
 */
const startAda = async (
  arranged: Arranged,
  reply: "turn-end" | "segments" = "turn-end",
): Promise<AdaConversation> => {
  const { assistant, conversation } = await readDefaultConversation(arranged);
  const renamed = await send("PATCH", arranged.harness.base, `/api/v1/assistants/${assistant.id}`, {
    body: { name: "Ada", reply },
    token: arranged.token,
  });
  expect(renamed.status, await renamed.clone().text()).toBe(200);
  const session = await startConversationSession(arranged, conversation.id, "hi");
  return { conversation, session };
};

/** Returns the conversation's messages that are not the owner's, oldest first. */
const listAnswers = async (
  arranged: Arranged,
  conversationId: string,
): Promise<ReadonlyArray<ConversationMessage>> =>
  (await listMessages(arranged, conversationId, "sort=position:asc")).items.filter(
    (one) => one.senderRole !== "owner",
  );

/** Renames the default assistant to Ada and returns its web conversation. */
const renameToAda = async (arranged: Arranged): Promise<Conversation> => {
  const { assistant, conversation } = await readDefaultConversation(arranged);
  const renamed = await send("PATCH", arranged.harness.base, `/api/v1/assistants/${assistant.id}`, {
    body: { name: "Ada" },
    token: arranged.token,
  });
  expect(renamed.status, await renamed.clone().text()).toBe(200);
  return conversation;
};

/**
 * Caps the runner at one session and has a Thread take that slot, so the
 * next conversation session waits in the queue with no runner holding it.
 */
const fillTheRunner = async (arranged: Arranged): Promise<void> => {
  const capped = await send(
    "PATCH",
    arranged.harness.base,
    `/api/v1/runners/${arranged.runnerId}`,
    {
      body: { maxConcurrentSessions: 1 },
      token: arranged.token,
    },
  );
  expect(capped.status, await capped.clone().text()).toBe(200);
  const thread = await spawnSessionOrFail(arranged, { prompt: "take the slot" });
  await waitForStartFrames(arranged, thread.id, 1);
};

/** Sends "hi" to Ada while the runner is full, and returns the session it queues. */
const queueAdaSession = async (arranged: Arranged, conversationId: string): Promise<Session> => {
  await fillTheRunner(arranged);
  await sendMessage(arranged, conversationId, "hi");
  const [session] = await waitForConversationSessions(arranged, conversationId, 1);
  expect(session!.status).toBe("queued");
  return session!;
};

/**
 * Waits for the one notice of the conversation and checks that the system
 * wrote it about `sessionId`, with the text `text` and no turn id.
 */
const expectSessionNotice = async (
  arranged: Arranged,
  conversationId: string,
  sessionId: string,
  text: string,
): Promise<void> => {
  const answers = await waitUntil("wrote the notice", async () => {
    const found = await listAnswers(arranged, conversationId);
    return found.length > 0 ? found : undefined;
  });
  expect(answers).toHaveLength(1);
  expect(answers[0]).toMatchObject({
    senderRole: "notice",
    senderLabel: "Ada",
    text,
    sessionId,
    turnId: null,
    actor: "system",
  });
};

/**
 * Reports the start of the turn "hi" opened, at sequence number 2, and waits
 * until the controller has written it to the transcript.
 *
 * The session already reads `busy` before this report, because "hi" was
 * waiting for it, so its status cannot show that the report was applied. The
 * transcript row commits together with every other write for the report,
 * such as the session's last activity time, so once the row is there nothing
 * from this report is still to come.
 */
const startTurn = async (arranged: Arranged, sessionId: string): Promise<void> => {
  reportEvent(arranged.wire, 2, {
    eventId: crypto.randomUUID(),
    sessionId,
    at,
    _tag: "turn.started",
    turnId: "t1",
  });
  await waitUntil("wrote the turn's start", async () => {
    const response = await get(
      arranged.harness.base,
      `/api/v1/sessions/${sessionId}/transcript`,
      arranged.token,
    );
    const { items } = (await response.json()) as {
      readonly items: ReadonlyArray<{ readonly event: { readonly _tag: string } }>;
    };
    return items.some((row) => row.event._tag === "turn.started") ? true : undefined;
  });
};

/** Reports the session's exit at sequence number `seq` and waits until the session has exited. */
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
  await waitForSession(arranged, sessionId, (one) => one.status === "exited");
};

/** The notice for a turn that failed with the runner's error "rate limited". */
const TURN_FAILED = "Ada was interrupted: its turn failed: rate limited";

describe("a turn that fails while the session lives", () => {
  it("writes the notice with the runner's error when the turn produced no text", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation, session } = await startAda(arranged);

      await runTurn(arranged, session.id, 2, "t1", [], { state: "failed", error: "rate limited" });

      const answers = await listAnswers(arranged, conversation.id);
      expect(answers.map((one) => [one.senderRole, one.text])).toEqual([["notice", TURN_FAILED]]);
      expect(answers[0]).toMatchObject({ sessionId: session.id, actor: "system" });
    });
  });

  it("writes the notice without an error when the runner gave none", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation, session } = await startAda(arranged);

      await runTurn(arranged, session.id, 2, "t1", [], { state: "failed" });

      const answers = await listAnswers(arranged, conversation.id);
      expect(answers.map((one) => [one.senderRole, one.text])).toEqual([
        ["notice", "Ada was interrupted: its turn failed"],
      ]);
    });
  });

  it("in segments mode, keeps the reply already stored and writes the notice after it", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation, session } = await startAda(arranged, "segments");

      await runTurn(arranged, session.id, 2, "t1", ["a"], {
        state: "failed",
        error: "rate limited",
      });

      const answers = await listAnswers(arranged, conversation.id);
      expect(answers.map((one) => [one.senderRole, one.text])).toEqual([
        ["assistant", "a"],
        ["notice", TURN_FAILED],
      ]);
    });
  });

  it("in turn-end mode, writes the failed turn's text as the reply and the notice after it", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation, session } = await startAda(arranged, "turn-end");

      await runTurn(arranged, session.id, 2, "t1", ["b"], {
        state: "failed",
        error: "rate limited",
      });

      const answers = await listAnswers(arranged, conversation.id);
      expect(answers.map((one) => [one.senderRole, one.text])).toEqual([
        ["assistant", "b"],
        ["notice", TURN_FAILED],
      ]);
    });
  });
});

/** The notice for a turn that was stopped. */
const TURN_STOPPED = "Ada was interrupted: its turn was stopped";

describe("a turn that is stopped while the session lives", () => {
  it("writes the notice, stamped with the system, when the turn produced no text", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation, session } = await startAda(arranged);

      await runTurn(arranged, session.id, 2, "t1", [], { state: "interrupted" });

      const answers = await listAnswers(arranged, conversation.id);
      expect(answers.map((one) => [one.senderRole, one.text])).toEqual([["notice", TURN_STOPPED]]);
      expect(answers[0]).toMatchObject({ sessionId: session.id, actor: "system" });
    });
  });

  it("in segments mode, keeps the reply already stored and writes the notice after it", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation, session } = await startAda(arranged, "segments");

      await runTurn(arranged, session.id, 2, "t1", ["a"], { state: "interrupted" });

      const answers = await listAnswers(arranged, conversation.id);
      expect(answers.map((one) => [one.senderRole, one.text])).toEqual([
        ["assistant", "a"],
        ["notice", TURN_STOPPED],
      ]);
    });
  });

  // A turn is split into several texts by its tool calls. A completed turn's
  // reply is its last text (AC-15), but an interrupted one has no answer, so
  // its reply is all it said, not the fragment after the last tool call.
  it("in turn-end mode, writes every text of the turn as one reply, then the notice", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation, session } = await startAda(arranged, "turn-end");

      await runTurn(arranged, session.id, 2, "t1", ["1 2 3", "4 5 6", "7 8"], {
        state: "interrupted",
      });

      const answers = await listAnswers(arranged, conversation.id);
      expect(answers.map((one) => [one.senderRole, one.text])).toEqual([
        ["assistant", "1 2 3\n\n4 5 6\n\n7 8"],
        ["notice", TURN_STOPPED],
      ]);
    });
  });
});

describe("a session that exits while busy", () => {
  const REASON_TEXTS: ReadonlyArray<readonly [ExitReason, string]> = [
    ["crash", "its session crashed"],
    ["process_exit", "its harness process exited"],
    ["stopped", "its session was stopped"],
    ["runner_restart", "its runner restarted"],
    ["inactivity_timeout", "its session timed out"],
    ["absolute_timeout", "its session reached its time limit"],
  ];

  it.each(REASON_TEXTS)(
    "writes one notice with no turn id for the reason %s",
    async (reason, text) => {
      await withAgentFleet(async (arranged) => {
        const { conversation, session } = await startAda(arranged);
        await startTurn(arranged, session.id);

        await reportExit(arranged, session.id, 3, reason);

        const answers = await listAnswers(arranged, conversation.id);
        expect(answers).toHaveLength(1);
        expect(answers[0]).toMatchObject({
          senderRole: "notice",
          senderLabel: "Ada",
          text: `Ada was interrupted: ${text}`,
          turnId: null,
        });
      });
    },
  );
});

describe("a session that exits after the runner opened a turn, before the turn started", () => {
  it("writes that the assistant was interrupted, because the turn counts as running from the runner's answer", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation, session } = await startAda(arranged);
      const next = await runTurn(arranged, session.id, 2, "t1", ["hello"]);
      await sendMessage(arranged, conversation.id, "are you there?");
      // The runner answers that the message opened a turn, and exits before
      // it reports `turn.started`, as a harness can that starts its turn
      // after it answers.
      await waitUntil("delivered the message as a new turn", async () =>
        (await listInputs(arranged, session.id)).find(
          (one) => one.text === "are you there?" && one.delivery === "opened",
        ),
      );
      await waitForSession(arranged, session.id, (one) => one.status === "busy");

      await reportExit(arranged, session.id, next, "crash");

      const answers = await waitUntil("wrote the notice", async () => {
        const found = await listAnswers(arranged, conversation.id);
        return found.length > 1 ? found : undefined;
      });
      expect(answers.map((one) => [one.senderRole, one.text])).toEqual([
        ["assistant", "hello"],
        ["notice", "Ada was interrupted: its session crashed"],
      ]);
      expect(answers[1]).toMatchObject({ sessionId: session.id, turnId: null, actor: "system" });
    });
  });
});

describe("a session stopped before a runner took it", () => {
  it("writes that the assistant can't be reached, because the message that queued it is never taken", async () => {
    await withAgentFleet(async (arranged) => {
      const conversation = await renameToAda(arranged);
      const session = await queueAdaSession(arranged, conversation.id);

      // The user stops the session, but the notice is the system's.
      const stopped = await post(
        arranged.harness.base,
        `/api/v1/sessions/${session.id}/stop`,
        {},
        arranged.token,
      );

      expect(stopped.status, await stopped.clone().text()).toBe(200);
      expect((await stopped.json()) as Session).toMatchObject({ status: "exited" });
      await expectSessionNotice(arranged, conversation.id, session.id, NEVER_STARTED);
    });
  });
});

describe("a session its runner stops holding", () => {
  it("writes that the assistant was interrupted when the runner reports its sessions without this one", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation, session } = await startAda(arranged);
      await startTurn(arranged, session.id);

      // A runner that restarted without a clean exit lists the sessions it
      // still holds, and this one is not among them.
      arranged.wire.send({ _tag: "sessionsReport", sessions: [] });

      await waitForSession(arranged, session.id, (one) => one.status === "exited");
      await expectSessionNotice(
        arranged,
        conversation.id,
        session.id,
        "Ada was interrupted: its runner restarted",
      );
    });
  });

  it("writes that the assistant was interrupted when its runner is retired while it is busy", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation, session } = await startAda(arranged);
      await startTurn(arranged, session.id);

      const retired = await post(
        arranged.harness.base,
        `/api/v1/runners/${arranged.runnerId}/retire`,
        { force: true },
        arranged.token,
      );

      expect(retired.status, await retired.clone().text()).toBe(200);
      await waitForSession(arranged, session.id, (one) => one.status === "exited");
      await expectSessionNotice(
        arranged,
        conversation.id,
        session.id,
        "Ada was interrupted: its runner was retired",
      );
    });
  });

  it("writes that the assistant can't be reached when its runner is retired while it waits in the queue", async () => {
    await withAgentFleet(async (arranged) => {
      const conversation = await renameToAda(arranged);
      const session = await queueAdaSession(arranged, conversation.id);

      const retired = await post(
        arranged.harness.base,
        `/api/v1/runners/${arranged.runnerId}/retire`,
        { force: true },
        arranged.token,
      );

      expect(retired.status, await retired.clone().text()).toBe(200);
      await waitForSession(arranged, session.id, (one) => one.status === "exited");
      await expectSessionNotice(arranged, conversation.id, session.id, NEVER_STARTED);
    });
  });

  it("writes that the assistant was interrupted when its runner is lost for longer than the session's time limit", async () => {
    await withAgentFleet(
      async (arranged) => {
        const { conversation, session } = await startAda(arranged);
        await startTurn(arranged, session.id);

        arranged.wire.close();
        // Nothing has been heard about the session for longer than its
        // absolute timeout, eight hours by default.
        await Effect.runPromise(
          Effect.orDie(arranged.harness.sql`
            UPDATE sessions SET last_activity_at = '2026-01-01T00:00:00.000Z'
            WHERE id = unhex(replace(${session.id}, '-', ''))
          `),
        );

        await waitForSession(arranged, session.id, (one) => one.status === "exited");
        await expectSessionNotice(
          arranged,
          conversation.id,
          session.id,
          "Ada was interrupted: its runner could not be reached",
        );
      },
      { lostRunnerSweepInterval: Duration.millis(50) },
    );
  });
});

describe("a session that exits while idle", () => {
  it.each<ExitReason>(["stopped", "idle_unload"])(
    "writes no notice for the reason %s when every message was answered",
    async (reason) => {
      await withAgentFleet(async (arranged) => {
        const { conversation, session } = await startAda(arranged);
        const next = await runTurn(arranged, session.id, 2, "t1", ["hello"]);

        await reportExit(arranged, session.id, next, reason);

        expect((await listAnswers(arranged, conversation.id)).map((one) => one.text)).toEqual([
          "hello",
        ]);
      });
    },
  );
});

describe("a session that exits while idle with a message still waiting", () => {
  it("writes no notice and resumes the session for the message the runner refused", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation, session } = await startAda(arranged);
      const next = await runTurn(arranged, session.id, 2, "t1", []);
      arranged.wire.answering(() => ({ message: "the harness is not ready" }));
      await sendMessage(arranged, conversation.id, "are you there?");
      await waitUntil("stored the refusal on the input", async () =>
        (await listInputs(arranged, session.id)).find(
          (one) => one.text === "are you there?" && one.reason !== null,
        ),
      );

      // Not `reportExit`: the session is resumed straight after the exit, so
      // it may never be seen as exited.
      reportEvent(arranged.wire, next, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "session.exited",
        reason: "stopped",
      });

      // The session was never resumed, so the crash-loop guard does not hold
      // it: it is resumed for the message. A retry that was on the wire at the
      // exit is answered and put back, never dropped.
      await waitForStartFrames(arranged, session.id, 2);
      const inputs = await listInputs(arranged, session.id);
      expect(inputs.find((one) => one.text === "are you there?")?.status).toBe("queued");
      expect(await listAnswers(arranged, conversation.id)).toEqual([]);
    });
  });
});

describe("a resumed session that exits before it starts a turn", () => {
  it("writes that the assistant can't be reached, and resumes it again for the owner's next message", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation, session } = await startAda(arranged);
      const next = await runTurn(arranged, session.id, 2, "t1", []);
      await reportExit(arranged, session.id, next, "idle_unload");
      // A runner whose start fails refuses the input the start carries, and
      // then reports the exit.
      arranged.wire.answering(() => ({ message: "the harness crashed" }));
      await sendMessage(arranged, conversation.id, "are you there?");
      await waitForStartFrames(arranged, session.id, 2);
      await waitUntil("recorded the refusal", async () => {
        const found = (await listInputs(arranged, session.id)).find(
          (one) => one.text === "are you there?",
        );
        return found?.reason === "the harness crashed" ? found : undefined;
      });
      arranged.wire.answering(() => "opened");

      // The resumed process numbers its events from 1 again.
      await reportExit(arranged, session.id, 1, "crash");

      await expectSessionNotice(
        arranged,
        conversation.id,
        session.id,
        "Ada can't be reached: its session exited before it could start a turn; " +
          "send another message to try again",
      );
      const held = await waitForSession(arranged, session.id, (one) => one.resumeHeld);
      expect(held.status).toBe("exited");
      expect(
        (await listInputs(arranged, session.id)).find((one) => one.text === "are you there?")
          ?.status,
      ).toBe("queued");

      await sendMessage(arranged, conversation.id, "and now?");

      await waitForStartFrames(arranged, session.id, 3);
    });
  });
});

describe("a Thread", () => {
  it("writes no notice for a failed turn or an exit while busy", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation } = await startAda(arranged);
      const thread = await spawnSessionOrFail(arranged, { prompt: "hello" });
      await waitForStartFrames(arranged, thread.id, 1);
      reportEvent(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: thread.id,
        at,
        _tag: "session.started",
        providerRefs: { nativeSessionId: "native-thread" },
      });
      await waitForSession(arranged, thread.id, (one) => one.status === "busy");

      const next = await runTurn(arranged, thread.id, 2, "t1", [], {
        state: "failed",
        error: "rate limited",
      });
      reportEvent(arranged.wire, next, {
        eventId: crypto.randomUUID(),
        sessionId: thread.id,
        at,
        _tag: "turn.started",
        turnId: "t2",
      });
      await waitForSession(arranged, thread.id, (one) => one.status === "busy");
      await reportExit(arranged, thread.id, next + 1, "crash");

      expect(await listAnswers(arranged, conversation.id)).toEqual([]);
    });
  });
});
