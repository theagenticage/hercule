/**
 * Tests `assistant.delete` over HTTP, against a real controller and one fake
 * runner on the socket.
 *
 * Deleting an assistant first stops its running session and waits for the
 * runner to report the exit, then deletes the agent, the assistant, its
 * conversations and their messages in one go. The session and its transcript
 * stay, as history, and input still waiting for a session is cancelled, so
 * no session comes back for an assistant that is gone. When the session does
 * not stop by the deadline, nothing is deleted.
 */
import { describe, expect, it, vi } from "vitest";
import { Duration, Effect } from "effect";
import type { SessionStop } from "@hercule/protocol";
import type { Runner, Session } from "@hercule/contract";
import { del, get, readErrorBody } from "../http/testing";
import {
  WAIT_DEADLINE_MS,
  at,
  listFrames,
  listInputs,
  readSession,
  reportEvent,
  waitForFrames,
  waitForSession,
  withAgentFleet,
  type Arranged,
} from "../sessions/testing";
import {
  listMessages,
  readDefaultConversation,
  startConversationSession,
} from "../conversations/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

/**
 * How long the delete waits for a session to stop before it gives up. The
 * controller's deadline is 30 seconds; these tests replace it with a shorter
 * one, so the timeout test does not wait that long.
 */
const STOP_DEADLINE_MS = 1_000;

/** The id of an input a test writes straight into the database. */
const HELD_INPUT = "0199e0e7-0000-7000-8000-0000000000a1";

/** The id of a second session a test writes straight into the database. */
const OLDER_SESSION = "0199e0e7-0000-7000-8000-0000000000b1";

/** A well-formed id that matches no record. */
const NOBODY = "0199e0e7-9999-7000-8000-000000000000";

/**
 * Starts the default assistant's session and has it start a turn, so it is
 * busy. The runner's next sequence number for the session is 3.
 */
const startBusySession = async (arranged: Arranged, conversationId: string): Promise<Session> => {
  const session = await startConversationSession(arranged, conversationId, "hi");
  reportEvent(arranged.wire, 2, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "turn.started",
    turnId: "t1",
  });
  return await waitForSession(arranged, session.id, (one) => one.status === "busy");
};

/** Returns the HTTP status of a read, for a test that checks whether a record still exists. */
const readStatus = async (arranged: Arranged, path: string): Promise<number> =>
  (await get(arranged.harness.base, path, arranged.token)).status;

describe("assistant.delete", () => {
  it("stops the busy session, waits for its exit, then deletes the assistant and keeps the session as history", async () => {
    await withAgentFleet(async (arranged) => {
      const { assistant, conversation } = await readDefaultConversation(arranged);
      const session = await startBusySession(arranged, conversation.id);

      const deleting = del(
        arranged.harness.base,
        `/api/v1/assistants/${assistant.id}`,
        arranged.token,
      );
      const [stop] = await waitForFrames<SessionStop>(arranged.wire, "sessionStop", 1);
      expect(stop!.sessionId).toBe(session.id);
      // Nothing is deleted while the session is still running.
      expect(await readStatus(arranged, `/api/v1/assistants/${assistant.id}`)).toBe(200);
      reportEvent(arranged.wire, 3, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "session.exited",
        reason: "stopped",
      });
      const response = await deleting;

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await readStatus(arranged, `/api/v1/assistants/${assistant.id}`)).toBe(404);
      expect(await readStatus(arranged, `/api/v1/agents/${assistant.id}`)).toBe(404);
      expect(await readStatus(arranged, `/api/v1/conversations/${conversation.id}`)).toBe(404);
      expect(await readStatus(arranged, `/api/v1/conversations/${conversation.id}/messages`)).toBe(
        404,
      );
      const audited = await arranged.harness.audit("assistant.deleted");
      expect(audited).toHaveLength(1);
      // The stop is audited as any stop is, as the user who asked for the delete.
      const stops = await arranged.harness.audit("session.stopped");
      expect(stops).toHaveLength(1);
      expect(stops[0]?.actor).toBe("user");

      const kept = await readSession(arranged, session.id);
      expect(kept).toMatchObject({
        status: "exited",
        agentId: assistant.id,
        conversationId: conversation.id,
      });
      const transcript = await get(
        arranged.harness.base,
        `/api/v1/sessions/${session.id}/transcript`,
        arranged.token,
      );
      expect(transcript.status).toBe(200);
      expect(((await transcript.json()) as { items: ReadonlyArray<unknown> }).items).not.toEqual(
        [],
      );
    });
  });

  it(
    "fails with invalid_state naming the runner and deletes nothing when the session does not stop by the deadline",
    async () => {
      await withAgentFleet(
        async (arranged) => {
          const { assistant, conversation } = await readDefaultConversation(arranged);
          await startBusySession(arranged, conversation.id);
          const runner = (await (
            await get(arranged.harness.base, `/api/v1/runners/${arranged.runnerId}`, arranged.token)
          ).json()) as Runner;

          // The runner receives the stop frame and never reports the exit.
          const response = await del(
            arranged.harness.base,
            `/api/v1/assistants/${assistant.id}`,
            arranged.token,
          );

          expect(response.status).toBe(409);
          expect(await readErrorBody(response)).toMatchObject({
            code: "invalid_state",
            message: `the assistant's session did not stop; try again when runner ${runner.name} is reachable`,
          });
          expect(await readStatus(arranged, `/api/v1/assistants/${assistant.id}`)).toBe(200);
          expect(await readStatus(arranged, `/api/v1/conversations/${conversation.id}`)).toBe(200);
          expect(
            (await listMessages(arranged, conversation.id)).items.map((one) => one.text),
          ).toEqual(["hi"]);
          expect(await arranged.harness.audit("assistant.deleted")).toEqual([]);
        },
        { assistantStopDeadline: Duration.millis(STOP_DEADLINE_MS) },
      );
    },
    STOP_DEADLINE_MS + WAIT_DEADLINE_MS * 3 + 10_000,
  );

  it("stops every session of the conversation that has not exited, not only the current one", async () => {
    await withAgentFleet(async (arranged) => {
      const { assistant, conversation } = await readDefaultConversation(arranged);
      const session = await startBusySession(arranged, conversation.id);
      // A second session of the same conversation, still busy: an older one
      // whose stop is still under way. Only a copy of the row can arrange it,
      // because a conversation starts a new session only once its current one
      // has exited.
      const hex = (id: string) => id.replaceAll("-", "");
      await Effect.runPromise(
        Effect.orDie(
          Effect.gen(function* () {
            const sql = arranged.harness.sql;
            yield* sql`CREATE TEMP TABLE copied AS SELECT * FROM sessions
                       WHERE id = unhex(${hex(session.id)})`;
            yield* sql`UPDATE copied SET id = unhex(${hex(OLDER_SESSION)}), token_hash = NULL,
                         created_at = '2000-01-01T00:00:00.000Z'`;
            yield* sql`INSERT INTO sessions SELECT * FROM copied`;
            yield* sql`DROP TABLE copied`;
          }),
        ),
      );

      const deleting = del(
        arranged.harness.base,
        `/api/v1/assistants/${assistant.id}`,
        arranged.token,
      );
      const [first] = await waitForFrames<SessionStop>(arranged.wire, "sessionStop", 1);
      reportEvent(arranged.wire, first!.sessionId === session.id ? 3 : 1, {
        eventId: crypto.randomUUID(),
        sessionId: first!.sessionId,
        at,
        _tag: "session.exited",
        reason: "stopped",
      });
      const stops = await waitForFrames<SessionStop>(arranged.wire, "sessionStop", 2);
      const second = stops[1]!.sessionId;
      reportEvent(arranged.wire, second === session.id ? 3 : 1, {
        eventId: crypto.randomUUID(),
        sessionId: second,
        at,
        _tag: "session.exited",
        reason: "stopped",
      });
      const response = await deleting;

      expect(response.status, await response.clone().text()).toBe(200);
      expect(stops.map((one) => one.sessionId).sort()).toEqual([session.id, OLDER_SESSION].sort());
      expect(await readSession(arranged, OLDER_SESSION)).toMatchObject({ status: "exited" });
      expect(await readSession(arranged, session.id)).toMatchObject({ status: "exited" });
    });
  });

  it("cancels input still waiting on an exited session, so nothing can resume the session after the delete", async () => {
    await withAgentFleet(async (arranged) => {
      const { assistant, conversation } = await readDefaultConversation(arranged);
      const session = await startConversationSession(arranged, conversation.id, "hi");
      reportEvent(arranged.wire, 2, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "session.exited",
        reason: "idle_unload",
      });
      await waitForSession(arranged, session.id, (one) => one.status === "exited");
      // The state between an unload that kept input and the resume that
      // follows it: the session has exited and an input still waits for it.
      // A real unload cannot hold this state for the test, because the
      // unload's own delivery resumes the session as soon as it commits; so
      // the input is written directly.
      await Effect.runPromise(
        Effect.orDie(
          arranged.harness.sql`INSERT INTO session_inputs
                                 (id, session_id, source, actor, text, status, created_at)
            VALUES (unhex(${HELD_INPUT.replaceAll("-", "")}), unhex(${session.id.replaceAll("-", "")}),
                    'user', 'user',
                    'are you there?', 'queued', ${at})`,
        ),
      );

      const response = await del(
        arranged.harness.base,
        `/api/v1/assistants/${assistant.id}`,
        arranged.token,
      );

      expect(response.status, await response.clone().text()).toBe(200);
      const waiting = (await listInputs(arranged, session.id)).find(
        (one) => one.text === "are you there?",
      );
      expect(waiting).toMatchObject({ status: "cancelled", reason: "the assistant was deleted" });
      // A resume needs an input that still waits, so with none left the
      // session stays exited and its runner is never asked to start it again.
      expect(await readSession(arranged, session.id)).toMatchObject({ status: "exited" });
      expect(listFrames(arranged.wire, "sessionStart")).toHaveLength(1);
    });
  });

  it("fails with not_found for an id that names no assistant", async () => {
    await withAgentFleet(async (arranged) => {
      const response = await del(
        arranged.harness.base,
        `/api/v1/assistants/${NOBODY}`,
        arranged.token,
      );

      expect(response.status).toBe(404);
      // The same refusal `assistant.read` gives for the id, not the router's
      // refusal of a path it does not know.
      const read = await get(arranged.harness.base, `/api/v1/assistants/${NOBODY}`, arranged.token);
      const expected = await readErrorBody(read);
      expect(await readErrorBody(response)).toMatchObject({
        code: "not_found",
        message: expected.message,
      });
    });
  });
});
