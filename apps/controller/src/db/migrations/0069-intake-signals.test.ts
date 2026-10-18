/**
 * Tests the intake signals migration on temporary databases:
 *
 * - an event and a Connection written before it keep their rows, with no
 *   title, author or warning;
 * - the raise outbox refuses a decision other than `yes` or `undecided`, and
 *   holds one row per event and kind;
 * - the lookups the raise path makes on every routed event or written signal
 *   each read an index: the open signals on a thread, the pending raises on
 *   a thread, the known-work check on the inputs and the steps an event
 *   reached, the count of a kind's failed builds, and the open decisions of
 *   one kind about a subject.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../migrate";
import { inTransaction, TestDatabase, TestDatabaseWriter } from "../testing";
import { migrations } from "./index";

const BEFORE = migrations.filter(([id]) => id < 69);
const THROUGH = migrations.filter(([id]) => id <= 69);

const at = "2026-10-11T00:00:00.000Z";

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, TestDatabase));

/** Returns SQLite's plan for a statement, its steps joined with " / ". */
const explainQueryPlan = (statement: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(
      sql<{ readonly detail: string }>`${sql.literal(`EXPLAIN QUERY PLAN ${statement}`)}`,
      (rows) => rows.map((row) => row.detail).join(" / "),
    ),
  );

/**
 * Inserts one raise row and returns `accepted`, or the database's error
 * message when a constraint refuses the row.
 */
const insertRaise = (eventId: number, kind: string, decision: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* Effect.match(
      inTransaction(
        sql`
          INSERT INTO signal_raises (event_id, kind, decision, connection_id, thread_ref)
          VALUES (${eventId}, ${kind}, ${decision}, x'01', 'acme/web#1')`,
      ),
      {
        // The SQL error wraps a constraint error, which wraps SQLite's own
        // error, and only SQLite's message names the constraint.
        onFailure: (error) => String(error.cause.cause),
        onSuccess: () => "accepted",
      },
    );
  });

describe("the intake signals migration", () => {
  it("keeps an earlier event and Connection, with no title, author or warning", async () => {
    const [event, connection] = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* sql`
          INSERT INTO events (source, system, kind, occurred_at, received_at, dedup_key, payload)
          VALUES ('acme', 'acme', 'acme.thing.done', ${at}, ${at}, 'k1', '{}')`;
        yield* sql`
          INSERT INTO connections (id, plugin_id, type, label, display_name, account_id, status,
                                   labels, config, created_at, updated_at)
          VALUES (x'01', 'acme', 'acme/acme', 'Acme', 'Acme', 'acme-1', 'connected', '[]', '{}',
                  ${at}, ${at})`;
        yield* runMigrations(THROUGH);
        const events = yield* sql<{
          readonly kind: string;
          readonly title: string | null;
          readonly author: string | null;
        }>`SELECT kind, title, author FROM events`;
        const connections = yield* sql<{
          readonly label: string;
          readonly warning: string | null;
        }>`SELECT label, warning FROM connections`;
        return [events, connections] as const;
      }).pipe(Effect.provide(TestDatabaseWriter)),
    );

    expect(event).toEqual([{ kind: "acme.thing.done", title: null, author: null }]);
    expect(connection).toEqual([{ label: "Acme", warning: null }]);
  });

  it("refuses a raise decision other than yes or undecided", async () => {
    const results = await run(
      Effect.all([
        insertRaise(1, "acme/asked", "yes"),
        insertRaise(2, "acme/asked", "undecided"),
        insertRaise(3, "acme/asked", "no"),
      ]),
    );

    expect(results.slice(0, 2)).toEqual(["accepted", "accepted"]);
    expect(results[2]).toContain("CHECK constraint failed");
  });

  it("holds one raise per event and kind", async () => {
    const results = await run(
      Effect.all([
        insertRaise(1, "acme/asked", "yes"),
        insertRaise(1, "acme/mentioned", "yes"),
        insertRaise(1, "acme/asked", "undecided"),
      ]),
    );

    expect(results.slice(0, 2)).toEqual(["accepted", "accepted"]);
    expect(results[2]).toContain("UNIQUE constraint failed");
  });

  it("finds the open signals on a thread from an index", async () => {
    const plan = await run(
      explainQueryPlan(
        `SELECT id FROM signals WHERE status = 'open' AND connection_id = x'01' AND thread_ref = 'a'`,
      ),
    );

    expect(plan).toContain("signals_open_thread");
  });

  it("finds the pending raises on a thread from an index", async () => {
    const plan = await run(
      explainQueryPlan(
        `DELETE FROM signal_raises WHERE connection_id = x'01' AND thread_ref = 'a' AND kind = 'k'`,
      ),
    );

    expect(plan).toContain("signal_raises_thread");
  });

  it("counts a kind's failed builds since an event from an index", async () => {
    const plan = await run(
      explainQueryPlan(
        `SELECT COUNT(*) FROM signals WHERE kind = 'k' AND build_error IS NOT NULL AND json_extract(origin, '$.eventId') >= 7`,
      ),
    );

    expect(plan).toBe("SEARCH signals USING INDEX signals_build_failed (kind=? AND <expr>>?)");
  });

  it("finds the open decisions of one kind from an index", async () => {
    const plan = await run(
      explainQueryPlan(
        `SELECT id FROM notifications WHERE status = 'open' AND kind = 'core.signal-build-failed'
           AND EXISTS (SELECT 1 FROM json_each(notifications.subject) AS subject
                       WHERE subject.value ->> 'kind' = 'signalKind' AND subject.value ->> 'id' = 'k')
         ORDER BY created_at, id`,
      ),
    );

    expect(plan).toContain("SEARCH notifications USING INDEX notifications_open_kind (kind=?)");
    expect(plan).not.toContain("TEMP B-TREE");
  });

  it("finds the inputs and the steps an event reached from an index", async () => {
    const [inputs, steps] = await run(
      Effect.all([
        explainQueryPlan(`SELECT 1 FROM session_inputs WHERE event_id = 7`),
        explainQueryPlan(`SELECT 1 FROM run_steps WHERE event_id = 7`),
      ]),
    );

    expect(inputs).toContain("session_inputs_event");
    expect(steps).toContain("run_steps_event");
  });
});
