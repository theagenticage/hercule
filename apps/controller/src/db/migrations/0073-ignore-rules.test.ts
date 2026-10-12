/**
 * Tests what the Ignore Rules migration adds to a database at the previous
 * head:
 *
 * - a signal's `match` written before the migration is rewritten with its
 *   fields sorted by name;
 * - the reads of the core's offers and of a new rule each use an index,
 *   with no sort;
 * - a rule's `match` must be valid JSON;
 * - a catch must name an event in the log, and is deleted with its event;
 * - a catch stays when its rule is deleted.
 *
 * The tests stop at this migration, so a later migration cannot change what
 * they check.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations up to and including the one under test. */
const UP_TO_IGNORE_RULES = migrations.filter(([id]) => id <= 73);

/** The migrations before the one under test. */
const BEFORE_IGNORE_RULES = migrations.filter(([id]) => id < 73);

const AT = "2026-10-12T00:00:00.000Z";

/** A rule id, as the 16 bytes the database stores. */
const RULE_ID = new Uint8Array(16).fill(7);

/** Runs `effect` on a fresh in-memory database migrated up to this migration. */
const runMigrated = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(
    Effect.andThen(runMigrations(UP_TO_IGNORE_RULES), effect).pipe(
      Effect.provide(openDatabase(MEMORY)),
    ),
  );

/** Writes one event with a dedup key unique to it, and returns its id. */
const insertEvent = (dedupKey: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(
      sql<{ readonly id: number }>`
        INSERT INTO events (source, system, kind, occurred_at, received_at, dedup_key, payload)
        VALUES ('acme', 'acme', 'acme.thing.done', ${AT}, ${AT}, ${dedupKey}, '{}')
        RETURNING id`,
      (rows) => rows[0]!.id,
    ),
  );

/** Writes one rule with `RULE_ID` and that stored `match`. */
const insertRule = (match: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      INSERT INTO ignore_rules (id, kind, match, text, actor, created_at)
      VALUES (${RULE_ID}, 'acme/asked', ${match}, 'Asked · Repository acme/webshop', 'user', ${AT})`,
  );

/** Writes one catch of `RULE_ID` for the event with that id. */
const insertCatch = (eventId: number) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      INSERT INTO ignore_rule_catches (event_id, rule_id, kind, rule_text, at)
      VALUES (${eventId}, ${RULE_ID}, 'acme/asked', 'Asked · Repository acme/webshop', ${AT})`,
  );

/**
 * Returns SQLite's plan for a statement, its steps joined with " / ". The
 * statements are copies of the signal repository's, because SQLite uses a
 * partial or an expression index only for a query that repeats it exactly.
 */
const explainQueryPlan = (statement: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(
      sql<{ readonly detail: string }>`${sql.literal(`EXPLAIN QUERY PLAN ${statement}`)}`,
      (rows) => rows.map((row) => row.detail).join(" / "),
    ),
  );

/** Returns the event ids of every catch, in id order. */
const listCaughtEventIds = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.map(
    sql<{ readonly event_id: number }>`SELECT event_id FROM ignore_rule_catches ORDER BY event_id`,
    (rows) => rows.map((row) => row.event_id),
  ),
);

describe("the Ignore Rules migration", () => {
  it("sorts the fields of each signal's match by name, and leaves sorted and empty ones as they are", async () => {
    const stored = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE_IGNORE_RULES);
        for (const [byte, match] of [
          [1, '{"repo":"acme/web","author":"octocat"}'],
          [2, '{"author":"octocat","repo":"acme/web"}'],
          [3, "{}"],
        ] as const) {
          yield* sql`
            INSERT INTO signals
              (id, kind, origin, title, priority, blocks, actions, match, status, created_at)
            VALUES
              (${new Uint8Array(16).fill(byte)}, 'acme/asked', '{}', 'a title', 'normal', '[]',
               '[]', ${match}, 'open', ${AT})`;
        }
        yield* runMigrations(UP_TO_IGNORE_RULES);
        return yield* sql<{ readonly match: string }>`SELECT match FROM signals ORDER BY id`;
      }).pipe(Effect.provide(openDatabase(MEMORY))),
    );

    expect(stored.map((row) => row.match)).toEqual([
      '{"author":"octocat","repo":"acme/web"}',
      '{"author":"octocat","repo":"acme/web"}',
      "{}",
    ]);
  });

  it("serves each read of the signal repository's rules and offers from an index, with no sort", async () => {
    const plans = await runMigrated(
      Effect.all({
        offers: explainQueryPlan(
          `SELECT id, status, ignore_rule FROM signals
           WHERE ignore_rule IS NOT NULL AND json_extract(ignore_rule, '$.kind') = 'acme/asked'`,
        ),
        openMatches: explainQueryPlan(
          `SELECT id, match FROM signals WHERE kind = 'acme/asked' AND status = 'open'`,
        ),
        streakEnd: explainQueryPlan(
          `SELECT created_at, id FROM signals
           WHERE kind = 'acme/asked' AND match = '{"repo":"acme/web"}' AND match <> '{}'
             AND NOT (status = 'resolved' AND (
               json_extract(resolution, '$.kind') = 'withdrawn'
               OR (json_extract(resolution, '$.kind') = 'decided'
                   AND json_extract(resolution, '$.actionId') IS 'done')
             ))
           ORDER BY created_at DESC, id DESC
           LIMIT 1`,
        ),
        streakCount: explainQueryPlan(
          `SELECT COUNT(*) AS count FROM signals
           WHERE kind = 'acme/asked' AND match = '{"repo":"acme/web"}' AND match <> '{}'
             AND (created_at, id) > ('${AT}', x'01')
             AND NOT (status = 'resolved' AND json_extract(resolution, '$.kind') = 'withdrawn')`,
        ),
      }),
    );

    expect(plans).toEqual({
      offers: "SEARCH signals USING INDEX signals_ignore_rule_offer (<expr>=?)",
      openMatches: "SEARCH signals USING INDEX signals_open_kind (kind=?)",
      streakEnd: "SEARCH signals USING INDEX signals_group (kind=? AND match=?)",
      streakCount:
        "SEARCH signals USING INDEX signals_group (kind=? AND match=? AND (created_at,id)>(?,?))",
    });
  });

  it("refuses a rule whose match is not valid JSON", async () => {
    const outcome = await runMigrated(Effect.exit(insertRule("{repo")));

    expect(outcome._tag).toBe("Failure");
  });

  it("deletes a catch with its event, refuses a catch of an unknown event, and keeps a catch when its rule goes", async () => {
    const checked = await runMigrated(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const foreignKeys = yield* sql<{ readonly foreign_keys: number }>`PRAGMA foreign_keys`;
        yield* insertRule('{"repo":"acme/webshop"}');
        const kept = yield* insertEvent("k1");
        const pruned = yield* insertEvent("k2");
        yield* insertCatch(kept);
        yield* insertCatch(pruned);
        const unknownEvent = yield* Effect.exit(insertCatch(pruned + 100));
        yield* sql`DELETE FROM events WHERE id = ${pruned}`;
        const afterEventDelete = yield* listCaughtEventIds;
        yield* sql`DELETE FROM ignore_rules WHERE id = ${RULE_ID}`;
        const afterRuleDelete = yield* listCaughtEventIds;
        return {
          foreignKeys,
          unknownEvent: unknownEvent._tag,
          kept,
          afterEventDelete,
          afterRuleDelete,
        };
      }),
    );

    // The cascade only runs with foreign keys on, which the connection sets.
    expect(checked.foreignKeys).toEqual([{ foreign_keys: 1 }]);
    expect(checked.unknownEvent).toBe("Failure");
    expect(checked.afterEventDelete).toEqual([checked.kept]);
    expect(checked.afterRuleDelete).toEqual([checked.kept]);
  });
});
