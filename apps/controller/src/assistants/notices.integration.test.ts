/**
 * Tests the notices an assistant's conversation gets when a turn or the
 * session ends without an answer, from what the fake runner reports on the
 * runner socket, against a real controller.
 *
 * A notice is a conversation message from the assistant, with sender role
 * `notice`, whose text is that the assistant couldn't answer, and why. A
 * failure is never silent in the conversation:
 *
 * - a failed or interrupted turn writes one, even after it wrote reply text;
 * - a session that ends while someone waits on it writes one, however it
 *   ends: an exit the runner reports, a stop before a runner took it, a
 *   runner that restarted, was retired or was lost, or a workspace that could
 *   not be made. Someone waits while the session is queued, starting or
 *   busy, or while a message sent to it is still unanswered.
 *
 * An exit while idle with no message waiting, and an idle unload, write none,
 * because nobody is waiting. A Thread writes none at all.
 */
import { describe, expect, it, vi } from "vitest";
import { Duration, Effect } from "effect";
import type { ExitReason } from "@hercule/protocol";
import type { Conversation, ConversationMessage, Session } from "@hercule/contract";
import { post, send } from "../http/testing";
import {
  WAIT_DEADLINE_MS,
  at,
  listFrames,
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

/** The conversation of these tests: the default assistant's, renamed to Ada, and its session, idle after "hi". */
interface AdaConversation {
  readonly conversation: Conversation;
  readonly session: Session;
}

/**
 * Renames the default assistant to Ada, sets its reply mode, and starts its
 * conversation session with the message "hi". The runner's next sequence number
 * for the session is 2.
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
 * wrote it about `sessionId`, with `why` as the reason and no turn id.
 */
const expectSessionNotice = async (
  arranged: Arranged,
  conversationId: string,
  sessionId: string,
  why: string,
): Promise<void> => {
  const answers = await waitUntil("wrote the notice", async () => {
    const found = await listAnswers(arranged, conversationId);
    return found.length > 0 ? found : undefined;
  });
  expect(answers).toHaveLength(1);
  expect(answers[0]).toMatchObject({
    senderRole: "notice",
    senderLabel: "Ada",
    text: `Ada couldn't answer: ${why}`,
    sessionId,
    turnId: null,
    actor: "system",
  });
};

/** Reports a turn start at sequence number 2 and waits until the session is busy. */
const startTurn = async (arranged: Arranged, sessionId: string): Promise<void> => {
  reportEvent(arranged.wire, 2, {
    eventId: crypto.randomUUID(),
    sessionId,
    at,
    _tag: "turn.started",
    turnId: "t1",
  });
  await waitForSession(arranged, sessionId, (one) => one.status === "busy");
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

describe("a turn that ends without an answer", () => {
  it("writes a notice with the turn's error and id when the turn fails", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation, session } = await startAda(arranged);

      await runTurn(arranged, session.id, 2, "t1", [], { state: "failed", error: "rate limited" });

      const answers = await listAnswers(arranged, conversation.id);
      expect(answers).toHaveLength(1);
      expect(answers[0]).toMatchObject({
        senderRole: "notice",
        senderLabel: "Ada",
        text: "Ada couldn't answer: rate limited",
        sessionId: session.id,
        turnId: "t1",
        actor: "system",
      });
    });
  });

  it("records that the turn failed when the failed turn has no error", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation, session } = await startAda(arranged);

      await runTurn(arranged, session.id, 2, "t1", [], { state: "failed" });

      expect((await listAnswers(arranged, conversation.id)).map((one) => one.text)).toEqual([
        "Ada couldn't answer: the turn failed",
      ]);
    });
  });

  it("records that the turn was interrupted when the turn is interrupted", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation, session } = await startAda(arranged);

      await runTurn(arranged, session.id, 2, "t1", [], { state: "interrupted" });

      const answers = await listAnswers(arranged, conversation.id);
      expect(answers.map((one) => [one.senderRole, one.text, one.turnId])).toEqual([
        ["notice", "Ada couldn't answer: the turn was interrupted", "t1"],
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
        ["notice", "Ada couldn't answer: rate limited"],
      ]);
    });
  });

  it("in turn-end mode, writes the turn's text as the reply and then the notice", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation, session } = await startAda(arranged, "turn-end");

      await runTurn(arranged, session.id, 2, "t1", ["b"], {
        state: "failed",
        error: "rate limited",
      });

      const answers = await listAnswers(arranged, conversation.id);
      expect(answers.map((one) => [one.senderRole, one.text])).toEqual([
        ["assistant", "b"],
        ["notice", "Ada couldn't answer: rate limited"],
      ]);
    });
  });

  // A turn is split into several texts by its tool calls. A completed turn's
  // reply is its last text (AC-15), but an interrupted one has no answer, so
  // its reply is all it said, not the fragment after the last tool call.
  it("in turn-end mode, writes every text of an interrupted turn as one reply, then the notice", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation, session } = await startAda(arranged, "turn-end");

      await runTurn(arranged, session.id, 2, "t1", ["1 2 3", "4 5 6", "7 8"], {
        state: "interrupted",
      });

      const answers = await listAnswers(arranged, conversation.id);
      expect(answers.map((one) => [one.senderRole, one.text])).toEqual([
        ["assistant", "1 2 3\n\n4 5 6\n\n7 8"],
        ["notice", "Ada couldn't answer: the turn was interrupted"],
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
    ["workspace_failed", "its workspace could not be made"],
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
          text: `Ada couldn't answer: ${text}`,
          turnId: null,
        });
      });
    },
  );

  it("writes no notice for an idle unload", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation, session } = await startAda(arranged);
      // The runner only unloads an idle session. Reporting the unload while
      // busy shows that the reason alone keeps the notice out.
      await startTurn(arranged, session.id);

      await reportExit(arranged, session.id, 3, "idle_unload");

      expect(await listAnswers(arranged, conversation.id)).toEqual([]);
    });
  });
});

describe("a session stopped before a runner took it", () => {
  it("writes the notice a stopped session gets, because the message that queued it goes unanswered", async () => {
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
      await expectSessionNotice(arranged, conversation.id, session.id, "its session was stopped");
    });
  });
});

describe("a session its runner stops holding", () => {
  it("writes a notice when the runner reports its sessions without this one", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation, session } = await startAda(arranged);
      await startTurn(arranged, session.id);

      // A runner that restarted without a clean exit lists the sessions it
      // still holds, and this one is not among them.
      arranged.wire.send({ _tag: "sessionsReport", sessions: [] });

      await waitForSession(arranged, session.id, (one) => one.status === "exited");
      await expectSessionNotice(arranged, conversation.id, session.id, "its runner restarted");
    });
  });

  it("writes a notice when its runner is retired while it is busy", async () => {
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
      await expectSessionNotice(arranged, conversation.id, session.id, "its runner was retired");
    });
  });

  it("writes a notice when its runner is retired while it waits in the queue", async () => {
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
      await expectSessionNotice(arranged, conversation.id, session.id, "its runner was retired");
    });
  });

  it("writes a notice when its runner is lost for longer than the session's time limit", async () => {
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
          "its runner could not be reached",
        );
      },
      { lostRunnerSweepInterval: Duration.millis(50) },
    );
  });
});

describe("a session whose workspace could not be made", () => {
  it("writes a notice with the runner's error", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation, session } = await startAda(arranged);
      await startTurn(arranged, session.id);
      // A conversation session opens no workspace of its own, so the test
      // puts this one in a workspace that is still being made.
      const workspaceId = "0199e0e7-0000-7000-8000-0000000000c1";
      const hex = (id: string) => id.replaceAll("-", "");
      await Effect.runPromise(
        Effect.orDie(
          Effect.gen(function* () {
            const sql = arranged.harness.sql;
            yield* sql`INSERT INTO workspaces (id, runner_id, kind, status, created_at)
                       VALUES (unhex(${hex(workspaceId)}), unhex(${hex(arranged.runnerId)}),
                               'ephemeral', 'provisioning', ${at})`;
            yield* sql`UPDATE sessions SET workspace_id = unhex(${hex(workspaceId)})
                       WHERE id = unhex(${hex(session.id)})`;
          }),
        ),
      );

      arranged.wire.send({
        _tag: "workspaceReport",
        workspaceId,
        status: "failed",
        message: "fatal: could not read from remote repository",
      } as never);

      await waitForSession(arranged, session.id, (one) => one.status === "exited");
      await expectSessionNotice(
        arranged,
        conversation.id,
        session.id,
        "its workspace could not be made: fatal: could not read from remote repository",
      );
    });
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

describe("a session that exits while idle with a message still unanswered", () => {
  it("writes a notice when the message was sent and the runner never answered it", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation, session } = await startAda(arranged);
      arranged.wire.answering(() => undefined);
      await sendMessage(arranged, conversation.id, "are you there?");
      await waitUntil("sent the message's input frame", () =>
        listFrames(arranged.wire, "sessionInput").length > 0 ? true : undefined,
      );

      await reportExit(arranged, session.id, 2, "crash");

      await expectSessionNotice(arranged, conversation.id, session.id, "its session crashed");
    });
  });

  it("writes a notice when the runner accepted the message but no turn started from it", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation, session } = await startAda(arranged);
      const next = await runTurn(arranged, session.id, 2, "t1", ["hello"]);
      await sendMessage(arranged, conversation.id, "are you there?");
      await waitUntil("the runner accepted the message as a new turn", async () =>
        (await listInputs(arranged, session.id)).find(
          (one) => one.text === "are you there?" && one.status === "delivered",
        ),
      );

      await reportExit(arranged, session.id, next, "crash");

      const answers = await waitUntil("wrote the notice", async () => {
        const found = await listAnswers(arranged, conversation.id);
        return found.length > 1 ? found : undefined;
      });
      expect(answers).toHaveLength(2);
      expect(answers[0]!.text).toBe("hello");
      expect(answers[1]).toMatchObject({
        senderRole: "notice",
        senderLabel: "Ada",
        text: "Ada couldn't answer: its session crashed",
        sessionId: session.id,
        turnId: null,
        actor: "system",
      });
    });
  });

  it("writes a notice when the runner refused the message and it still waits", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation, session } = await startAda(arranged);
      arranged.wire.answering(() => ({ message: "the harness is not ready" }));
      await sendMessage(arranged, conversation.id, "are you there?");
      await waitUntil("stored the refusal on the input", async () =>
        (await listInputs(arranged, session.id)).find(
          (one) => one.text === "are you there?" && one.reason !== null,
        ),
      );

      await reportExit(arranged, session.id, 2, "stopped");

      await expectSessionNotice(arranged, conversation.id, session.id, "its session was stopped");
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
      await waitForSession(arranged, thread.id, (one) => one.status === "idle");

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
