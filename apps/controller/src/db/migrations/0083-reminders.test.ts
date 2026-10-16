/**
 * Tests the `reminders` table the migration adds: the status check, the
 * cascade from a deleted conversation, the cancel columns, and the indexes
 * that serve the Scheduler's "pending and due" read and `reminder.query`.
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

/** Inserts a reminder with these fields and returns whether the database accepted it. */
const insertReminder = (
  status: string,
  cancelledAt: string | null = null,
  cancelledBy: string | null = null,
) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.match(
      sql`INSERT INTO reminders
        (id, conversation_id, at, text, status, actor, created_at, cancelled_at, cancelled_by)
        VALUES (unhex(${toHex(REMINDER)}), unhex(${toHex(CONVERSATION)}), ${at}, 'chase',
                ${status}, 'user', ${at}, ${cancelledAt}, ${cancelledBy})`,
      { onFailure: () => "refused", onSuccess: () => "accepted" },
    ),
  );

describe("the reminders migration", () => {
  it.each([
    ["a pending reminder", "accepted", "pending", null, null],
    ["a cancelled reminder with its actor", "accepted", "cancelled", at, "user"],
    ["an unknown status", "refused", "snoozed", null, null],
    ["a cancelled reminder that records no actor", "refused", "cancelled", at, null],
    ["a pending reminder with a cancelling actor", "refused", "pending", null, "user"],
  ])("%s is %s", async (_name, expected, status, cancelledAt, cancelledBy) => {
    expect(await migrated(insertReminder(status, cancelledAt, cancelledBy))).toBe(expected);
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

  it("serves each read from an index", async () => {
    const plans = await migrated(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const plan = (query: Effect.Effect<ReadonlyArray<{ readonly detail: string }>, SqlError>) =>
          Effect.map(query, (rows) => rows.map((row) => row.detail).join(" "));
        return {
          due: yield* plan(sql`EXPLAIN QUERY PLAN
            SELECT id FROM reminders WHERE status = 'pending' AND at <= ${at} ORDER BY at, id`),
          byStatus: yield* plan(sql`EXPLAIN QUERY PLAN
            SELECT id FROM reminders WHERE status = 'fired' ORDER BY at, id LIMIT 10`),
          byConversation: yield* plan(sql`EXPLAIN QUERY PLAN
            SELECT id FROM reminders WHERE conversation_id = x'01' ORDER BY at, id LIMIT 10`),
          all: yield* plan(sql`EXPLAIN QUERY PLAN
            SELECT id FROM reminders ORDER BY at, id LIMIT 10`),
        };
      }),
    );
    expect(plans.due).toContain("reminders_by_status");
    expect(plans.byStatus).toContain("reminders_by_status");
    expect(plans.byConversation).toContain("reminders_by_conversation");
    expect(plans.all).toContain("reminders_by_time");
    for (const plan of Object.values(plans)) expect(plan).not.toContain("TEMP B-TREE");
  });
});
