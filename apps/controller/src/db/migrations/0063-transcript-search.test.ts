/**
 * Tests what the transcript search migration does to the rows written before
 * it: every message already in the stream is searchable, and each session
 * gets the actor of the audit entry that recorded its creation.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { uuidFromString } from "../id";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 63);

const SPAWNED = "0190a000-0000-7000-8000-000000000001";
const FORKED = "0190a000-0000-7000-8000-000000000002";
const PRUNED = "0190a000-0000-7000-8000-000000000003";
const SPAWNER = "session:0190a000-0000-7000-8000-0000000000ff";
const at = "2026-10-11T10:00:00.000Z";

/** Runs a test against a fresh in-memory database. */
const runOnDatabase = <A>(test: Effect.Effect<A, unknown, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(test.pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie));

/**
 * Writes three sessions, the audit entries of two of them, and stream rows of
 * every kind to the first, then runs migration 63.
 */
const prepare = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations(BEFORE);
  for (const id of [SPAWNED, FORKED, PRUNED]) {
    yield* sql`INSERT INTO sessions (id, permission_profile_id, instance_id, runner_id,
                                     requested_access_mode, access_mode, spec, title, status,
                                     created_at, last_activity_at)
      VALUES (${uuidFromString(id)}, 'profile', 'instance', 'runner', 'auto', 'auto', '{}', 'a',
              'idle', ${at}, ${at})`;
  }
  const audit = [
    [SPAWNED, "session.spawned", SPAWNER],
    [FORKED, "session.continued", "user"],
  ] as const;
  for (const [sessionId, kind, actor] of audit) {
    yield* sql`INSERT INTO events (source, system, kind, occurred_at, received_at, dedup_key,
                                   payload, actor)
      VALUES ('platform', 'hercule', ${kind}, ${at}, ${at}, ${`${kind}:${sessionId}`},
              ${JSON.stringify({ sessionId })}, ${actor})`;
  }
  const item = {
    turnId: "t1",
    itemId: "i1",
    kind: "user_message",
    detail: { text: "migrate the database" },
  };
  const events = [
    { _tag: "item.started", ...item },
    { _tag: "item.completed", ...item, status: "completed" },
    {
      _tag: "content.delta",
      turnId: "t1",
      itemId: "i2",
      streamKind: "assistant_text",
      delta: "the database migrated",
    },
    {
      _tag: "content.delta",
      turnId: "t1",
      itemId: "i3",
      streamKind: "reasoning_text",
      delta: "think about the database",
    },
    {
      _tag: "content.delta",
      turnId: "t1",
      itemId: "i4",
      streamKind: "command_output",
      delta: "database ok",
    },
  ];
  for (const [index, event] of events.entries()) {
    yield* sql`INSERT INTO session_stream (session_id, position, runner_seq, at, event)
      VALUES (${uuidFromString(SPAWNED)}, ${index + 1}, ${index + 1}, ${at}, ${JSON.stringify(event)})`;
  }
  yield* runMigrations();
  return sql;
});

describe("the transcript search migration", () => {
  it("indexes each message already stored once, and leaves out what is not a message", async () => {
    const matches = await runOnDatabase(
      Effect.gen(function* () {
        const sql = yield* prepare;
        return yield* sql<{ position: number }>`
          SELECT ss.position FROM transcript_fts
          JOIN session_stream ss ON ss.rowid = transcript_fts.rowid
          WHERE transcript_fts MATCH 'database' ORDER BY ss.position`;
      }),
    );

    // The user message's start, then the assistant text. The completed item
    // repeats the start, and reasoning and command output are not messages.
    expect(matches).toEqual([{ position: 1 }, { position: 3 }]);
  });

  it("indexes a message stored after the migration", async () => {
    const matches = await runOnDatabase(
      Effect.gen(function* () {
        const sql = yield* prepare;
        const event = {
          _tag: "content.delta",
          turnId: "t2",
          itemId: "i5",
          streamKind: "assistant_text",
          delta: "rollback done",
        };
        yield* sql`INSERT INTO session_stream (session_id, position, runner_seq, at, event)
          VALUES (${uuidFromString(SPAWNED)}, 6, 6, ${at}, ${JSON.stringify(event)})`;
        return yield* sql<{ position: number }>`
          SELECT ss.position FROM transcript_fts
          JOIN session_stream ss ON ss.rowid = transcript_fts.rowid
          WHERE transcript_fts MATCH 'rollback'`;
      }),
    );

    expect(matches).toEqual([{ position: 6 }]);
  });

  it("gives each session the actor that created it, and null where the audit entry is gone", async () => {
    const sessions = await runOnDatabase(
      Effect.gen(function* () {
        const sql = yield* prepare;
        return yield* sql<{ id: string; created_by: string | null }>`
          SELECT lower(hex(id)) AS id, created_by FROM sessions ORDER BY id`;
      }),
    );

    const hex = (id: string) => id.replaceAll("-", "");
    expect(sessions).toEqual([
      { id: hex(SPAWNED), created_by: SPAWNER },
      { id: hex(FORKED), created_by: "user" },
      { id: hex(PRUNED), created_by: null },
    ]);
  });
});
