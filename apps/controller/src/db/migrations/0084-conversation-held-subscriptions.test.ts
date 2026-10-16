/**
 * Tests what the conversation-held subscriptions migration does to the
 * subscriptions of a database at the previous head: which live rows pass to
 * the conversation their session answers, and which stay with their holder.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 84);

/**
 * The migrations up to and including the one under test. A later migration
 * may change the same rows, so the test stops here.
 */
const THROUGH = migrations.filter(([id]) => id <= 84);

const at = "2026-10-16T00:00:00.000Z";
const CONVERSATION = "0199a000-0000-7000-8000-0000000000c1";
const GONE_CONVERSATION = "0199a000-0000-7000-8000-0000000000c2";
const ANSWERING_SESSION = "0199a000-0000-7000-8000-0000000000b1";
const THREAD_SESSION = "0199a000-0000-7000-8000-0000000000b2";
const ORPHANED_SESSION = "0199a000-0000-7000-8000-0000000000b3";
const RUN = "0199a000-0000-7000-8000-0000000000e1";

const toHex = (id: string): string => id.replaceAll("-", "");

/** Writes a session, in a conversation when `conversationId` is given. */
const insertSession = (sql: SqlClient.SqlClient, id: string, conversationId: string | null) =>
  sql`
    INSERT INTO sessions (id, permission_profile_id, instance_id, runner_id, requested_access_mode,
                          access_mode, spec, title, status, created_at, last_activity_at,
                          conversation_id)
    VALUES (unhex(${toHex(id)}), x'00', x'00', x'00', 'full-access', 'full-access', '{}', 'hello',
            'idle', ${at}, ${at},
            ${conversationId === null ? null : sql`unhex(${toHex(conversationId)})`})`;

/** One subscription to write: its number, who holds it, what it targets, and when it ended. */
interface Fixture {
  readonly number: number;
  readonly holderKind: "session" | "run";
  readonly holderId: string;
  readonly targetKind: "ref" | "request" | "run";
  readonly endedAt?: string;
}

/** Writes the subscription with the id `…a<number>`, as the previous head stored it. */
const insertSubscription = (sql: SqlClient.SqlClient, fixture: Fixture) =>
  sql`
    INSERT INTO subscriptions (id, holder_kind, holder_id, target, condition, created_at, actor,
                               ended_at)
    VALUES (unhex(${`0199a0000000700080000000000000a${fixture.number}`}), ${fixture.holderKind},
            unhex(${toHex(fixture.holderId)}), ${JSON.stringify({ kind: fixture.targetKind })},
            'true', ${at}, 'user', ${fixture.endedAt ?? null})`;

const FIXTURES: ReadonlyArray<Fixture> = [
  // Held by a session that answers a conversation: all three kinds of target except `request`.
  { number: 1, holderKind: "session", holderId: ANSWERING_SESSION, targetKind: "ref" },
  { number: 2, holderKind: "session", holderId: ANSWERING_SESSION, targetKind: "run" },
  { number: 3, holderKind: "session", holderId: ANSWERING_SESSION, targetKind: "request" },
  {
    number: 4,
    holderKind: "session",
    holderId: ANSWERING_SESSION,
    targetKind: "ref",
    endedAt: at,
  },
  { number: 5, holderKind: "session", holderId: THREAD_SESSION, targetKind: "ref" },
  { number: 6, holderKind: "session", holderId: ORPHANED_SESSION, targetKind: "ref" },
  { number: 7, holderKind: "run", holderId: RUN, targetKind: "ref" },
];

describe("the conversation-held subscriptions migration", () => {
  it("moves only the live subscriptions of a conversation's session to the conversation", async () => {
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* sql`INSERT INTO conversations (id, assistant_id, channel, container_key, created_at)
          VALUES (unhex(${toHex(CONVERSATION)}), x'00', 'web', NULL, ${at})`;
        yield* insertSession(sql, ANSWERING_SESSION, CONVERSATION);
        yield* insertSession(sql, THREAD_SESSION, null);
        // A session whose conversation was deleted keeps the id it answered.
        yield* insertSession(sql, ORPHANED_SESSION, GONE_CONVERSATION);
        for (const fixture of FIXTURES) yield* insertSubscription(sql, fixture);
        yield* runMigrations(THROUGH);
        return yield* sql<{
          readonly number: string;
          readonly holder_kind: string;
          readonly holder_id: string;
        }>`SELECT substr(hex(id), 32) AS number, holder_kind, lower(hex(holder_id)) AS holder_id
           FROM subscriptions ORDER BY id`;
      }).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie),
    );

    expect(rows.map((row) => [row.number, row.holder_kind, row.holder_id])).toEqual([
      ["1", "conversation", toHex(CONVERSATION)],
      ["2", "conversation", toHex(CONVERSATION)],
      ["3", "session", toHex(ANSWERING_SESSION)],
      ["4", "session", toHex(ANSWERING_SESSION)],
      ["5", "session", toHex(THREAD_SESSION)],
      ["6", "session", toHex(ORPHANED_SESSION)],
      ["7", "run", toHex(RUN)],
    ]);
  });
});
