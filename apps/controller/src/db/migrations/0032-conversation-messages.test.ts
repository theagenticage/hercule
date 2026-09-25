/**
 * Tests what the conversation messages migration does to a database at the
 * previous head: it adds the `conversation_messages` table with its sender
 * columns, and a `conversation_id` column on sessions that is null for every
 * session that exists already and is indexed for the sessions that have one.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 32);

const at = "2026-09-01T00:00:00.000Z";

/** The conversation every message in these tests belongs to. */
const CONVERSATION = "0199a000-0000-7000-8000-0000000000c1";

/** Two sessions that exist before the migration. */
const SESSIONS = ["0199a000-0000-7000-8000-0000000000e1", "0199a000-0000-7000-8000-0000000000e2"];

/** Converts a canonical id to the hex the database stores it as, for `unhex`. */
const toHex = (id: string): string => id.replaceAll("-", "");

/**
 * Seeds two sessions at the previous head, runs the migration, and returns
 * what `read` reads from the migrated database.
 */
const seedAndMigrate = <A>(read: Effect.Effect<A, SqlError, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations(BEFORE);

      for (const session of SESSIONS) {
        yield* sql`INSERT INTO sessions (id, permission_profile_id, instance_id, runner_id,
                                         requested_access_mode, access_mode, spec, title, status,
                                         created_at, last_activity_at)
          VALUES (unhex(${toHex(session)}), x'00', x'00', x'00', 'auto', 'auto', '{}',
                  'a session', 'exited', ${at}, ${at})`;
      }

      yield* runMigrations();

      return yield* read;
    }).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie),
  );

/**
 * Inserts one message into `CONVERSATION` and returns whether the database
 * accepted it.
 */
const insertMessage = (id: string, position: number, senderRole: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.match(
      sql`INSERT INTO conversation_messages (id, conversation_id, container_key, position,
                                             sender_role, sender_label, text, session_id,
                                             turn_id, actor, created_at)
        VALUES (unhex(${toHex(id)}), unhex(${toHex(CONVERSATION)}), NULL, ${position},
                ${senderRole}, 'rogier', 'hi', NULL, NULL, 'user', ${at})`,
      { onFailure: () => "refused", onSuccess: () => "accepted" },
    ),
  );

describe("the conversation messages migration", () => {
  it("creates conversation_messages with the sender, session and turn columns", async () => {
    const columns = await seedAndMigrate(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql<{ readonly name: string }>`
          SELECT name FROM pragma_table_info('conversation_messages')`,
      ),
    );

    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["sender_role", "sender_label", "session_id", "turn_id"]),
    );
  });

  it("accepts the owner, assistant and notice roles and refuses any other", async () => {
    const outcomes = await seedAndMigrate(
      Effect.all([
        insertMessage("0199a000-0000-7000-8000-0000000000d1", 1, "owner"),
        insertMessage("0199a000-0000-7000-8000-0000000000d2", 2, "assistant"),
        insertMessage("0199a000-0000-7000-8000-0000000000d3", 3, "notice"),
        insertMessage("0199a000-0000-7000-8000-0000000000d4", 4, "bot"),
      ]),
    );

    expect(outcomes).toEqual(["accepted", "accepted", "accepted", "refused"]);
  });

  it("refuses a second message at the same position in one conversation", async () => {
    const outcomes = await seedAndMigrate(
      Effect.all([
        insertMessage("0199a000-0000-7000-8000-0000000000d1", 1, "owner"),
        insertMessage("0199a000-0000-7000-8000-0000000000d2", 1, "assistant"),
      ]),
    );

    expect(outcomes).toEqual(["accepted", "refused"]);
  });

  it("leaves conversation_id null on every session that exists already", async () => {
    const sessions = await seedAndMigrate(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql<{ readonly conversation_id: Uint8Array | null }>`
          SELECT conversation_id FROM sessions`,
      ),
    );

    expect(sessions).toEqual([{ conversation_id: null }, { conversation_id: null }]);
  });

  it("indexes a conversation's sessions by conversation, creation time and id, for linked sessions only", async () => {
    const indexes = await seedAndMigrate(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql<{ readonly partial: number; readonly columns: string }>`
          SELECT list.partial AS partial,
                 (SELECT group_concat(info.name, ',')
                    FROM (SELECT name FROM pragma_index_info(list.name) ORDER BY seqno) AS info)
                   AS columns
          FROM pragma_index_list('sessions') AS list
          WHERE list.name = 'sessions_conversation'`,
      ),
    );

    expect(indexes).toEqual([{ partial: 1, columns: "conversation_id,created_at,id" }]);
  });
});
