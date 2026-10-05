/**
 * Tests what the input sent status migration does to a database at the
 * previous head:
 *
 * - an agent step's prompt that was cancelled because the runner never
 *   answered it becomes `sent`;
 * - every other input keeps its status and its fields;
 * - the table still has its three indexes, each unchanged, and accepts `sent`.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 47);

const at = "2026-10-05T00:00:00.000Z";

const SENT_AT = "2026-10-05T00:01:00.000Z";

/** An index of a table, as `sqlite_schema` stores it: its name and its `CREATE INDEX` statement. */
interface StoredIndex {
  readonly name: string;
  readonly sql: string;
}

/**
 * Returns the index with every run of whitespace in its statement made one
 * space, so that two migrations that wrote the same index with different
 * line breaks or indentation compare equal.
 */
const normalizeIndex = (index: StoredIndex): StoredIndex => ({
  name: index.name,
  sql: index.sql.replace(/\s+/g, " ").trim(),
});

/** Runs a test against a fresh in-memory database. */
const runOnDatabase = <A>(test: Effect.Effect<A, unknown, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(test.pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie));

describe("the input sent status migration", () => {
  it("turns a step prompt cancelled without an answer into sent, and keeps every other input", async () => {
    const rows = await runOnDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* sql`INSERT INTO session_inputs
            (id, session_id, source, actor, text, status, delivery, created_at, delivered_at,
             sent_at, reason, subscription_id, event_id, step_iteration)
          VALUES
            ('unanswered prompt', 's', 'user', 'run', 'go', 'cancelled', NULL, ${at}, NULL,
             ${SENT_AT}, 'the runner did not answer this step prompt', NULL, NULL, 1),
            ('cancelled prompt', 's', 'user', 'run', 'go', 'cancelled', NULL, ${at}, NULL,
             NULL, 'the step''s run ended before this prompt was sent', NULL, NULL, 2),
            ('delivered prompt', 's', 'user', 'run', 'go', 'delivered', 'opened', ${at}, ${at},
             NULL, NULL, NULL, NULL, 3),
            ('waiting input', 's', 'user', 'user', 'hi', 'queued', NULL, ${at}, NULL,
             NULL, 'the harness is not ready', NULL, NULL, NULL),
            ('matched input', 's', 'subscription', 'user', 'hi', 'cancelled', NULL, ${at}, NULL,
             NULL, 'the controller restarted', 'sub', 7, NULL)`;
        yield* runMigrations();
        return yield* sql`SELECT id, status, delivery, delivered_at, sent_at, reason,
                                 subscription_id, event_id, step_iteration
                          FROM session_inputs ORDER BY id`;
      }),
    );

    expect(rows).toEqual([
      {
        id: "cancelled prompt",
        status: "cancelled",
        delivery: null,
        delivered_at: null,
        sent_at: null,
        reason: "the step's run ended before this prompt was sent",
        subscription_id: null,
        event_id: null,
        step_iteration: 2,
      },
      {
        id: "delivered prompt",
        status: "delivered",
        delivery: "opened",
        delivered_at: at,
        sent_at: null,
        reason: null,
        subscription_id: null,
        event_id: null,
        step_iteration: 3,
      },
      {
        id: "matched input",
        status: "cancelled",
        delivery: null,
        delivered_at: null,
        sent_at: null,
        reason: "the controller restarted",
        subscription_id: "sub",
        event_id: 7,
        step_iteration: null,
      },
      {
        id: "unanswered prompt",
        status: "sent",
        delivery: null,
        delivered_at: null,
        sent_at: SENT_AT,
        reason: null,
        subscription_id: null,
        event_id: null,
        step_iteration: 1,
      },
      {
        id: "waiting input",
        status: "queued",
        delivery: null,
        delivered_at: null,
        sent_at: null,
        reason: "the harness is not ready",
        subscription_id: null,
        event_id: null,
        step_iteration: null,
      },
    ]);
  });

  it("keeps the three indexes of the table as they were", async () => {
    const { before, after } = await runOnDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const listIndexes = sql<StoredIndex>`
          SELECT name, sql FROM sqlite_schema
          WHERE type = 'index' AND tbl_name = 'session_inputs' AND sql IS NOT NULL
          ORDER BY name`;
        yield* runMigrations(BEFORE);
        const before = yield* listIndexes;
        yield* runMigrations();
        return { before, after: yield* listIndexes };
      }),
    );

    expect(before.map((index) => index.name)).toEqual([
      "session_inputs_awaiting",
      "session_inputs_match",
      "session_inputs_session",
    ]);
    // The whole statement is compared, not only the name, so an index the
    // migration made again without its UNIQUE or its WHERE fails the test.
    expect(after.map(normalizeIndex)).toEqual(before.map(normalizeIndex));
  });

  it("accepts a sent input that records when it was sent, and refuses one that does not", async () => {
    const written = await runOnDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        const insertSent = (id: string, sentAt: string | null) =>
          Effect.exit(sql`INSERT INTO session_inputs
              (id, session_id, source, actor, text, status, created_at, sent_at)
            VALUES (${id}, 's', 'user', 'run', 'go', 'sent', ${at}, ${sentAt})`);
        return {
          recorded: (yield* insertSent("recorded", SENT_AT))._tag,
          unrecorded: (yield* insertSent("unrecorded", null))._tag,
        };
      }),
    );

    expect(written).toEqual({ recorded: "Success", unrecorded: "Failure" });
  });
});
