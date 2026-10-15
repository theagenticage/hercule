/**
 * Tests the query that lists the sessions whose conversations watch a run, against a
 * database with the production migrations: which subscriptions count, and
 * which conversation wins when several watch the same run.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestDatabase } from "../db/testing";
import { uuidFromString } from "../db";
import { subscriptionRepository } from "./repository";

const RUN_ID = "0199e0e7-0000-7000-8000-00000000e001";
const OTHER_RUN_ID = "0199e0e7-0000-7000-8000-00000000e002";
const ASSISTANT_ID = "0199e0e7-0000-7000-8000-00000000a001";
const OTHER_ASSISTANT_ID = "0199e0e7-0000-7000-8000-00000000a002";
const FIRST_CONVERSATION_ID = "0199e0e7-0000-7000-8000-00000000c001";
const SECOND_CONVERSATION_ID = "0199e0e7-0000-7000-8000-00000000c002";
const FIRST_SESSION_ID = "0199e0e7-0000-7000-8000-00000000b501";
const SECOND_SESSION_ID = "0199e0e7-0000-7000-8000-00000000b502";
const THREAD_ID = "0199e0e7-0000-7000-8000-00000000b503";

/** Writes a session, in a conversation when `conversationId` is given. */
const insertSession = (sql: SqlClient.SqlClient, id: string, conversationId: string | null) =>
  sql`
    INSERT INTO sessions (id, permission_profile_id, instance_id, runner_id, requested_access_mode,
                          access_mode, spec, title, status, created_at, last_activity_at,
                          conversation_id)
    VALUES (${uuidFromString(id)}, ${uuidFromString(ASSISTANT_ID)}, ${uuidFromString(ASSISTANT_ID)},
            ${uuidFromString(ASSISTANT_ID)}, 'full-access', 'full-access', '{}', 'hello', 'idle',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
            ${conversationId === null ? null : uuidFromString(conversationId)})`;

/** Writes a web conversation. Each assistant has at most one, so each needs its own assistant. */
const insertConversation = (sql: SqlClient.SqlClient, id: string, assistantId: string) =>
  sql`
    INSERT INTO conversations (id, assistant_id, channel, container_key, created_at)
    VALUES (${uuidFromString(id)}, ${uuidFromString(assistantId)}, 'web', NULL,
            '2026-01-01T00:00:00.000Z')`;

/** Writes a subscription on a run held by a session, ended when `endedAt` is given. */
const insertRunSubscription = (
  sql: SqlClient.SqlClient,
  fields: { sessionId: string; runId: string; createdAt: string; endedAt?: string },
) =>
  sql`
    INSERT INTO subscriptions (id, holder_kind, holder_id, target, condition, created_at, actor,
                               ended_at)
    VALUES (${new Uint8Array(Bun.randomUUIDv7("buffer"))}, 'session',
            ${uuidFromString(fields.sessionId)},
            ${JSON.stringify({ kind: "run", runId: fields.runId })}, 'false', ${fields.createdAt},
            'user', ${fields.endedAt ?? null})`;

const run = <A>(
  body: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown, SqlClient.SqlClient>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertConversation(sql, FIRST_CONVERSATION_ID, ASSISTANT_ID);
      yield* insertConversation(sql, SECOND_CONVERSATION_ID, OTHER_ASSISTANT_ID);
      yield* insertSession(sql, FIRST_SESSION_ID, FIRST_CONVERSATION_ID);
      yield* insertSession(sql, SECOND_SESSION_ID, SECOND_CONVERSATION_ID);
      yield* insertSession(sql, THREAD_ID, null);
      return yield* body(sql);
    }).pipe(Effect.provide(TestDatabase), Effect.scoped),
  );

const findWatching = (runId: string) =>
  Effect.gen(function* () {
    const repository = yield* subscriptionRepository;
    const watchers = yield* repository.listSessionsWatchingRun(runId);
    return watchers[0]?.conversationId;
  });

describe("listSessionsWatchingRun", () => {
  it("returns the conversation of the session that holds a live subscription on the run", async () => {
    const found = await run((sql) =>
      Effect.gen(function* () {
        yield* insertRunSubscription(sql, {
          sessionId: SECOND_SESSION_ID,
          runId: RUN_ID,
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        return yield* findWatching(RUN_ID);
      }),
    );

    expect(found).toBe(SECOND_CONVERSATION_ID);
  });

  it("returns the conversation whose subscription is oldest when several watch the run", async () => {
    const found = await run((sql) =>
      Effect.gen(function* () {
        yield* insertRunSubscription(sql, {
          sessionId: FIRST_SESSION_ID,
          runId: RUN_ID,
          createdAt: "2026-01-01T00:00:02.000Z",
        });
        yield* insertRunSubscription(sql, {
          sessionId: SECOND_SESSION_ID,
          runId: RUN_ID,
          createdAt: "2026-01-01T00:00:01.000Z",
        });
        return yield* findWatching(RUN_ID);
      }),
    );

    expect(found).toBe(SECOND_CONVERSATION_ID);
  });

  it("ignores an ended subscription, a session in no conversation, and another run", async () => {
    const found = await run((sql) =>
      Effect.gen(function* () {
        yield* insertRunSubscription(sql, {
          sessionId: FIRST_SESSION_ID,
          runId: RUN_ID,
          createdAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:00:05.000Z",
        });
        yield* insertRunSubscription(sql, {
          sessionId: THREAD_ID,
          runId: RUN_ID,
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        yield* insertRunSubscription(sql, {
          sessionId: SECOND_SESSION_ID,
          runId: OTHER_RUN_ID,
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        return yield* findWatching(RUN_ID);
      }),
    );

    expect(found).toBeUndefined();
  });
});
