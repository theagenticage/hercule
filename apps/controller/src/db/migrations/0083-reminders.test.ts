/**
 * Tests the `reminders` table the migration adds: the status check, the
 * cascade from a deleted conversation, and the partial index that serves the
 * Scheduler's "pending and due" read.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";

const at = "2026-10-01T00:00:00.000Z";
const CONVERSATION = "0199a000-0000-7000-8000-0000000000c1";
const REMINDER = "0199a000-0000-7000-8000-0000000000d1";

const toHex = (id: string): string => id.replaceAll("-", "");

/** Migrates a database, inserts one conversation, and runs `read` against it. */
const migrated = <A>(read: Effect.Effect<A, SqlError, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`INSERT INTO conversations (id, assistant_id, channel, container_key, created_at)
        VALUES (unhex(${toHex(CONVERSATION)}), x'00', 'web', NULL, ${at})`;
      return yield* read;
    }).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie),
  );

/** Inserts a reminder with this status and returns whether the database accepted it. */
const insertReminder = (status: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.match(
      sql`INSERT INTO reminders (id, conversation_id, at, text, status, actor, created_at)
        VALUES (unhex(${toHex(REMINDER)}), unhex(${toHex(CONVERSATION)}), ${at}, 'chase',
                ${status}, 'user', ${at})`,
      { onFailure: () => "refused", onSuccess: () => "accepted" },
    ),
  );

describe("the reminders migration", () => {
  it("accepts the three statuses and refuses any other", async () => {
    expect(await migrated(insertReminder("pending"))).toBe("accepted");
    expect(await migrated(insertReminder("snoozed"))).toBe("refused");
  });

  it("deletes a conversation's reminders with the conversation", async () => {
    const left = await migrated(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* insertReminder("pending");
        yield* sql`DELETE FROM conversations WHERE id = unhex(${toHex(CONVERSATION)})`;
        return yield* sql<{ readonly n: number }>`SELECT count(*) AS n FROM reminders`;
      }),
    );
    expect(left).toEqual([{ n: 0 }]);
  });

  it("serves the pending-and-due read from the partial index", async () => {
    const plan = await migrated(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql<{ readonly detail: string }>`
          EXPLAIN QUERY PLAN
          SELECT id FROM reminders WHERE status = 'pending' AND at <= ${at} ORDER BY at, id`,
      ),
    );
    expect(plan.map((row) => row.detail).join(" ")).toContain("reminders_due");
  });
});
