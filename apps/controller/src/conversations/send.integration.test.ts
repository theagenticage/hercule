/**
 * Tests `conversation.send` over HTTP, `POST /api/v1/conversations/:id/messages`,
 * against a real controller and one fake runner on the runner socket.
 *
 * The send stores the owner's message and hands it to the assistant that answers
 * the conversation. What the tests check is what that hand-over does to the
 * conversation's sessions, in each state the current session can be in: a new
 * session is placed, the text is queued or delivered to the current one, or the
 * current one is resumed in place. A current session that cannot be resumed
 * never blocks the conversation: the next send places a new session.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { SessionInput } from "@hercule/protocol";
import { readErrorBody, send } from "../http/testing";
import {
  WAIT_DEADLINE_MS,
  at,
  createProfile,
  listFrames,
  listInputs,
  listSessions,
  readSession,
  reportEvent,
  spawnAgentUnder,
  spawnSessionOrFail,
  waitForSession,
  waitForStartFrames,
  waitUntil,
  withAgentFleet,
  type Arranged,
} from "../sessions/testing";
import {
  listConversationSessions,
  listMessages,
  readDefaultConversation,
  runTurn,
  requestSend,
  sendMessage,
  startConversationSession,
  waitForConversationSessions,
} from "./testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

/** The refusal placement gives when no runner can take the session. */
const NO_RUNNER =
  "no connected runner is logged in to that provider instance; log in on a machine first";

/** The refusal for any actor but the user (AD-6). */
const OWNER_ONLY =
  "conversation.send records the message as the owner's; only the user can send it";

/** Sets the runner's session cap through `runner.update`, as the runner page does. */
const setSessionCap = async (arranged: Arranged, cap: number): Promise<void> => {
  const response = await send(
    "PATCH",
    arranged.harness.base,
    `/api/v1/runners/${arranged.runnerId}`,
    { body: { maxConcurrentSessions: cap }, token: arranged.token },
  );
  expect(response.status, await response.clone().text()).toBe(200);
};

/** Returns the input frames the runner received for one session, oldest first. */
const listInputFramesFor = (arranged: Arranged, sessionId: string): ReadonlyArray<SessionInput> =>
  listFrames<SessionInput>(arranged.wire, "sessionInput").filter(
    (frame) => frame.sessionId === sessionId,
  );

describe("conversation.send to a conversation with no session", () => {
  it("stores the owner's message and places one session from the assistant", async () => {
    await withAgentFleet(async (arranged) => {
      const { assistant, conversation } = await readDefaultConversation(arranged);

      const message = await sendMessage(arranged, conversation.id, "hi");

      expect(message).toMatchObject({
        conversationId: conversation.id,
        text: "hi",
        senderRole: "owner",
        senderLabel: "rogier",
        actor: "user",
        sessionId: null,
        turnId: null,
      });
      const sessions = await waitForConversationSessions(arranged, conversation.id, 1);
      expect(sessions).toHaveLength(1);
      expect(await listSessions(arranged)).toHaveLength(1);
      const session = sessions[0]!;
      expect(session.conversationId).toBe(conversation.id);
      expect(session.agentId).toBe(assistant.id);
      expect(session.workspaceId).toBeNull();
      expect(session.accessMode).toBe(assistant.accessMode);
      const [frame] = await waitForStartFrames(arranged, session.id, 1);
      expect(frame!.spec.disallowedTools).toEqual(assistant.disallowedTools);
      expect(frame!.spec.systemPrompt).toBe(
        `Your name is ${assistant.name}.\n\n${assistant.systemPrompt}`,
      );
      expect(frame!.spec.timeouts).toMatchObject({ idleMs: 900_000 });
    });
  });

  it("gives a Thread on the same controller no idle timeout", async () => {
    await withAgentFleet(async (arranged) => {
      const thread = await spawnSessionOrFail(arranged, { prompt: "hello" });

      const [frame] = await waitForStartFrames(arranged, thread.id, 1);

      expect(frame!.spec.timeouts).not.toHaveProperty("idleMs");
    });
  });

  it("fails with invalid_state and keeps neither the message nor a session when no runner can take it", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation } = await readDefaultConversation(arranged);
      // `reserved` is set on the row, because `runner.update` does not allow
      // reserving the fleet's default runner, and the one runner here is it.
      await Effect.runPromise(
        Effect.orDie(
          arranged.harness.sql`
            UPDATE runners SET reserved = 1
            WHERE id = unhex(replace(${arranged.runnerId}, '-', ''))`,
        ),
      );

      const response = await requestSend(arranged, conversation.id, "hi");

      expect(response.status).toBe(409);
      expect(await readErrorBody(response)).toMatchObject({
        code: "invalid_state",
        message: NO_RUNNER,
      });
      expect((await listMessages(arranged, conversation.id)).items).toEqual([]);
      expect(await listSessions(arranged)).toEqual([]);
    });
  });

  it("queues the session on a runner at its cap, and keeps the message", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation } = await readDefaultConversation(arranged);
      await setSessionCap(arranged, 1);
      const thread = await spawnSessionOrFail(arranged, { prompt: "take the slot" });
      await waitForStartFrames(arranged, thread.id, 1);

      await sendMessage(arranged, conversation.id, "hi");

      const [session] = await waitForConversationSessions(arranged, conversation.id, 1);
      expect(session!.status).toBe("queued");
      expect(session!.runnerId).toBe(arranged.runnerId);
      expect((await listMessages(arranged, conversation.id)).items.map((one) => one.text)).toEqual([
        "hi",
      ]);
    });
  });

  it("makes exactly one session for two sends issued at once, with both messages in send order", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation } = await readDefaultConversation(arranged);

      const sent = await Promise.all([
        sendMessage(arranged, conversation.id, "one"),
        sendMessage(arranged, conversation.id, "two"),
      ]);

      const inOrder = [...sent].sort((a, b) => a.position - b.position).map((one) => one.text);
      const stored = await listMessages(arranged, conversation.id, "sort=position:asc");
      expect(stored.items.map((one) => one.text)).toEqual(inOrder);
      expect(await listSessions(arranged)).toHaveLength(1);
      const [session] = await listConversationSessions(arranged, conversation.id);
      expect((await listInputs(arranged, session!.id)).map((one) => one.text)).toEqual(inOrder);
    });
  });
});

describe("conversation.send to a conversation with a current session", () => {
  it("delivers the message to an idle session after answering, without waiting for the runner", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation } = await readDefaultConversation(arranged);
      const session = await startConversationSession(arranged, conversation.id, "hi");
      await waitUntil(
        "sent the first message's input frame",
        () => listInputFramesFor(arranged, session.id)[0],
      );
      await runTurn(arranged, session.id, 2, "t1", ["hello"]);
      // The runner never answers from here on. A send that waited for its
      // answer would not return.
      arranged.wire.answering(() => undefined);

      const response = await requestSend(arranged, conversation.id, "again");

      expect(response.status, await response.clone().text()).toBe(200);
      const frame = await waitUntil(
        "sent the second message's input frame",
        () => listInputFramesFor(arranged, session.id)[1],
      );
      expect(frame.input.text).toBe("again");
      expect(await listConversationSessions(arranged, conversation.id)).toHaveLength(1);
    });
  });

  it("queues the message as the user's input on a busy session", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation } = await readDefaultConversation(arranged);
      const session = await startConversationSession(arranged, conversation.id, "hi");
      reportEvent(arranged.wire, 2, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "turn.started",
        turnId: "t1",
      });
      await waitForSession(arranged, session.id, (one) => one.status === "busy");

      await sendMessage(arranged, conversation.id, "later");

      expect(await listInputs(arranged, session.id)).toContainEqual(
        expect.objectContaining({ text: "later", source: "user", status: "queued" }),
      );
      expect(await listConversationSessions(arranged, conversation.id)).toHaveLength(1);
    });
  });

  it("queues the message as the user's input on a starting session", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation } = await readDefaultConversation(arranged);
      await sendMessage(arranged, conversation.id, "hi");
      const [session] = await waitForConversationSessions(arranged, conversation.id, 1);
      await waitForStartFrames(arranged, session!.id, 1);
      expect((await listConversationSessions(arranged, conversation.id))[0]!.status).toBe(
        "starting",
      );

      await sendMessage(arranged, conversation.id, "second");

      expect(await listInputs(arranged, session!.id)).toContainEqual(
        expect.objectContaining({ text: "second", source: "user", status: "queued" }),
      );
      expect(await listConversationSessions(arranged, conversation.id)).toHaveLength(1);
    });
  });

  it("queues the message as the user's input on a queued session", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation } = await readDefaultConversation(arranged);
      await setSessionCap(arranged, 1);
      const thread = await spawnSessionOrFail(arranged, { prompt: "take the slot" });
      await waitForStartFrames(arranged, thread.id, 1);
      await sendMessage(arranged, conversation.id, "hi");
      const [session] = await waitForConversationSessions(arranged, conversation.id, 1);
      expect(session!.status).toBe("queued");

      await sendMessage(arranged, conversation.id, "second");

      expect(await listInputs(arranged, session!.id)).toContainEqual(
        expect.objectContaining({ text: "second", source: "user", status: "queued" }),
      );
      expect(await listConversationSessions(arranged, conversation.id)).toHaveLength(1);
    });
  });

  it("resumes an exited, resumable session in place, on the same runner", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation } = await readDefaultConversation(arranged);
      const session = await startConversationSession(arranged, conversation.id, "hi");
      const next = await runTurn(arranged, session.id, 2, "t1", ["hello"]);
      reportEvent(arranged.wire, next, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "session.exited",
        reason: "stopped",
      });
      const exited = await waitForSession(arranged, session.id, (one) => one.status === "exited");
      expect(exited.resumable).toBe(true);

      await sendMessage(arranged, conversation.id, "again");

      const resumed = await waitForSession(
        arranged,
        session.id,
        (one) => one.status === "starting",
      );
      expect(resumed.runnerId).toBe(arranged.runnerId);
      const frames = await waitForStartFrames(arranged, session.id, 2);
      expect(frames[1]!.spec.continue).toEqual({ mode: "resume", nativeSessionId: "native-1" });
      expect(await listConversationSessions(arranged, conversation.id)).toHaveLength(1);
    });
  });

  it("resumes under the access mode and permission profile the assistant has now", async () => {
    await withAgentFleet(async (arranged) => {
      const { assistant, conversation } = await readDefaultConversation(arranged);
      const session = await startConversationSession(arranged, conversation.id, "hi");
      expect(session).toMatchObject({
        requestedAccessMode: "full-access",
        accessMode: "full-access",
      });
      const next = await runTurn(arranged, session.id, 2, "t1", ["hello"]);
      reportEvent(arranged.wire, next, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "session.exited",
        reason: "idle_unload",
      });
      await waitForSession(arranged, session.id, (one) => one.status === "exited");
      const profile = await createProfile(arranged, "careful", ["agent.read"]);
      const updated = await send(
        "PATCH",
        arranged.harness.base,
        `/api/v1/assistants/${assistant.id}`,
        {
          body: { accessMode: "approval-required", permissionProfileId: profile.id },
          token: arranged.token,
        },
      );
      expect(updated.status, await updated.clone().text()).toBe(200);

      await sendMessage(arranged, conversation.id, "again");

      const frames = await waitForStartFrames(arranged, session.id, 2);
      expect(frames[1]!.spec.accessMode).toBe("approval-required");
      expect(frames[1]!.spec.continue).toEqual({ mode: "resume", nativeSessionId: "native-1" });
      expect(await readSession(arranged, session.id)).toMatchObject({
        requestedAccessMode: "approval-required",
        accessMode: "approval-required",
        permissionProfileId: profile.id,
      });
    });
  });

  it("places a new session after one that exited not resumable, and gives the next message to the newest", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation } = await readDefaultConversation(arranged);
      await sendMessage(arranged, conversation.id, "hi");
      const [first] = await waitForConversationSessions(arranged, conversation.id, 1);
      await waitForStartFrames(arranged, first!.id, 1);
      // An exit before the runner reported a native id leaves nothing to resume.
      reportEvent(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: first!.id,
        at,
        _tag: "session.exited",
        reason: "crash",
      });
      const ended = await waitForSession(arranged, first!.id, (one) => one.status === "exited");
      expect(ended.resumable).toBe(false);

      await sendMessage(arranged, conversation.id, "again");

      const [newest] = await waitForConversationSessions(arranged, conversation.id, 2);
      expect(newest!.id).not.toBe(first!.id);
      expect(newest!.conversationId).toBe(conversation.id);

      await sendMessage(arranged, conversation.id, "third");

      expect((await listInputs(arranged, newest!.id)).map((one) => one.text)).toEqual([
        "again",
        "third",
      ]);
      expect((await listInputs(arranged, first!.id)).map((one) => one.text)).toEqual(["hi"]);
    });
  });
});

describe("conversation.send when the current session cannot be resumed", () => {
  /** Drains the fleet's first runner, so it takes no new sessions and resumes none. */
  const drainRunner = async (arranged: Arranged): Promise<void> => {
    const drained = await send(
      "POST",
      arranged.harness.base,
      `/api/v1/runners/${arranged.runnerId}/drain`,
      { body: {}, token: arranged.token },
    );
    expect(drained.status, await drained.clone().text()).toBe(200);
  };

  it("places a new session when the exited one's runner is draining, instead of refusing every send", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation } = await readDefaultConversation(arranged);
      const session = await startConversationSession(arranged, conversation.id, "hi");
      const next = await runTurn(arranged, session.id, 2, "t1", ["hello"]);
      reportEvent(arranged.wire, next, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "session.exited",
        reason: "stopped",
      });
      const exited = await waitForSession(arranged, session.id, (one) => one.status === "exited");
      // The transcript is still there; only the runner that holds it refuses.
      expect(exited.resumable).toBe(true);
      const other = await arranged.enlist();
      await drainRunner(arranged);

      const response = await requestSend(arranged, conversation.id, "again");

      expect(response.status, await response.clone().text()).toBe(200);
      const [newest] = await waitForConversationSessions(arranged, conversation.id, 2);
      expect(newest!.id).not.toBe(session.id);
      expect(newest!.runnerId).toBe(other.runnerId);
      expect((await listInputs(arranged, newest!.id)).map((one) => one.text)).toEqual(["again"]);
      // The new session answers the message, so no notice is written, and
      // the old session keeps no copy of the message.
      expect(
        (await listMessages(arranged, conversation.id)).items.filter(
          (one) => one.senderRole === "notice",
        ),
      ).toEqual([]);
      expect((await listInputs(arranged, session.id)).map((one) => one.text)).toEqual(["hi"]);
    });
  });

  it("cancels a message held through an idle unload when the session cannot be resumed, and writes a notice", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation } = await readDefaultConversation(arranged);
      const session = await startConversationSession(arranged, conversation.id, "hi");
      const next = await runTurn(arranged, session.id, 2, "t1", ["hello"]);
      // The runner never answers the next input, so the message is still
      // held when the runner unloads the session.
      arranged.wire.answering(() => undefined);
      await sendMessage(arranged, conversation.id, "again");
      await waitUntil(
        "sent the second message's input frame",
        () => listInputFramesFor(arranged, session.id)[1],
      );
      await drainRunner(arranged);

      reportEvent(arranged.wire, next, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "session.exited",
        reason: "idle_unload",
      });

      const notice = await waitUntil("wrote the notice", async () =>
        (await listMessages(arranged, conversation.id)).items.find(
          (one) => one.senderRole === "notice",
        ),
      );
      expect(notice).toMatchObject({
        senderLabel: "Hercule",
        text:
          "Hercule couldn't answer: its session could not be resumed " +
          "(that runner is draining and takes no new sessions); " +
          "send the message again to start a new session",
        sessionId: session.id,
        actor: "system",
      });
      const held = (await listInputs(arranged, session.id)).find((one) => one.text === "again");
      expect(held).toMatchObject({
        status: "cancelled",
        reason:
          "the session could not be resumed: that runner is draining and takes no new sessions",
      });
      expect((await readSession(arranged, session.id)).status).toBe("exited");
    });
  });
});

describe("conversation.send from anyone but the user", () => {
  it("is forbidden for a session, even one whose profile holds agent.write, and stores nothing", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation } = await readDefaultConversation(arranged);
      const profile = await createProfile(arranged, "assistant writer", [
        "agent.read",
        "agent.write",
      ]);
      const { token } = await spawnAgentUnder(arranged, profile);

      const response = await requestSend(arranged, conversation.id, "hi", token);

      expect(response.status).toBe(403);
      expect(await readErrorBody(response)).toMatchObject({
        code: "forbidden",
        message: OWNER_ONLY,
      });
      expect((await listMessages(arranged, conversation.id)).items).toEqual([]);
      expect(await listConversationSessions(arranged, conversation.id)).toEqual([]);
    });
  });
});
