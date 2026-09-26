/**
 * Tests `assistant.delete` over HTTP, against a real controller and one fake
 * runner on the socket.
 *
 * Deleting an assistant deletes the agent, the assistant, its conversations
 * and their messages in one transaction, and sends a stop for every running
 * session once that transaction commits, without waiting for the sessions to
 * exit. The sessions and their transcripts stay, as history. Input still
 * waiting for a session is cancelled, so no session comes back for an
 * assistant that is gone, and a report that arrives from a stopped session
 * afterwards writes nothing.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { SessionStop } from "@hercule/protocol";
import type { Session } from "@hercule/contract";
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
import { readDefaultConversation, startConversationSession } from "../conversations/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

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

/** Counts the conversation's messages in the database, which the API no longer serves once it is deleted. */
const countMessages = async (arranged: Arranged, conversationId: string): Promise<number> => {
  const rows = await Effect.runPromise(
    Effect.orDie(
      arranged.harness.sql<{ readonly count: number }>`SELECT COUNT(*) AS count
        FROM conversation_messages WHERE conversation_id = unhex(${conversationId.replaceAll("-", "")})`,
    ),
  );
  return rows[0]?.count ?? 0;
};

describe("assistant.delete", () => {
  it("deletes the assistant without waiting for its busy session to exit, then stops the session and keeps it as history", async () => {
    await withAgentFleet(async (arranged) => {
      const { assistant, conversation } = await readDefaultConversation(arranged);
      const session = await startBusySession(arranged, conversation.id);

      // The runner has not reported any exit when the delete answers.
      const response = await del(
        arranged.harness.base,
        `/api/v1/assistants/${assistant.id}`,
        arranged.token,
      );

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await readStatus(arranged, `/api/v1/assistants/${assistant.id}`)).toBe(404);
      expect(await readStatus(arranged, `/api/v1/agents/${assistant.id}`)).toBe(404);
      expect(await readStatus(arranged, `/api/v1/conversations/${conversation.id}`)).toBe(404);
      expect(await readStatus(arranged, `/api/v1/conversations/${conversation.id}/messages`)).toBe(
        404,
      );
      expect(await arranged.harness.audit("assistant.deleted")).toHaveLength(1);
      const [stop] = await waitForFrames<SessionStop>(arranged.wire, "sessionStop", 1);
      expect(stop!.sessionId).toBe(session.id);
      // The stop is audited as any stop is, as the user who asked for the
      // delete, although it is sent after the delete's request has ended.
      const stops = await arranged.harness.audit("session.stopped");
      expect(stops).toHaveLength(1);
      expect(stops[0]?.actor).toBe("user");

      // The turn's last words and the exit arrive after the delete. They are
      // kept in the transcript, and nothing is written to the conversation
      // that is gone.
      const base = () => ({ eventId: crypto.randomUUID(), sessionId: session.id, at });
      const itemId = "t1-item-1";
      reportEvent(arranged.wire, 3, {
        ...base(),
        _tag: "item.started",
        turnId: "t1",
        itemId,
        kind: "assistant_message",
      });
      reportEvent(arranged.wire, 4, {
        ...base(),
        _tag: "content.delta",
        turnId: "t1",
        itemId,
        streamKind: "assistant_text",
        delta: "late",
      });
      reportEvent(arranged.wire, 5, {
        ...base(),
        _tag: "item.completed",
        turnId: "t1",
        itemId,
        kind: "assistant_message",
        status: "completed",
      });
      reportEvent(arranged.wire, 6, {
        ...base(),
        _tag: "turn.completed",
        turnId: "t1",
        state: "interrupted",
      });
      reportEvent(arranged.wire, 7, { ...base(), _tag: "session.exited", reason: "stopped" });
      const kept = await waitForSession(arranged, session.id, (one) => one.status === "exited");

      expect(kept).toMatchObject({ agentId: assistant.id, conversationId: conversation.id });
      expect(await countMessages(arranged, conversation.id)).toBe(0);
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

  it("stops every session of the conversation that has not exited, not only the newest one, without waiting for them to exit", async () => {
    await withAgentFleet(async (arranged) => {
      const { assistant, conversation } = await readDefaultConversation(arranged);
      const session = await startBusySession(arranged, conversation.id);
      // A second session of the same conversation, still busy: an older one
      // whose stop is still under way. Only a copy of the row can arrange it,
      // because a conversation starts a new session only once its newest one
      // has exited and cannot be resumed.
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

      const response = await del(
        arranged.harness.base,
        `/api/v1/assistants/${assistant.id}`,
        arranged.token,
      );
      const stops = await waitForFrames<SessionStop>(arranged.wire, "sessionStop", 2);

      expect(response.status, await response.clone().text()).toBe(200);
      expect(stops.map((one) => one.sessionId).sort()).toEqual([session.id, OLDER_SESSION].sort());
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
      // The state between an exit that kept input and the resume that
      // follows it: the session has exited and an input still waits for it.
      // A real exit cannot hold this state for the test, because the exit's
      // own delivery resumes the session as soon as it commits; so the input
      // is written directly.
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
