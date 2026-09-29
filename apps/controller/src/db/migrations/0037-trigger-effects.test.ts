/**
 * Tests the rules the trigger effects migration puts in the tables
 * themselves, on a migrated in-memory database:
 *
 * - a trigger effect has one of three states, has a run id exactly when it is
 *   `spawned`, is unique per workflow, trigger and event, and is deleted with
 *   its trigger;
 * - a trigger's three health columns, and its two skipped-ticks columns, are
 *   set together or not at all;
 * - a start trigger saved before the migration gets the input mapping its
 *   workflow declares;
 * - a run's triggering event is valid JSON;
 * - the dedup key of an event is unique per source and connection, so a
 *   manual event cannot take the key of a `cron.tick`.
 *
 * The rows are written in plain SQL, so the tables' checks are tested on their
 * own rather than behind the repositories that already follow them.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { TestDatabase } from "../testing";
import { migrations } from "./index";

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, TestDatabase));

const at = "2026-09-01T00:00:00.000Z";
const later = "2026-09-01T01:00:00.000Z";

/** The id of the one workflow each test stores. Any 16 bytes will do. */
const WORKFLOW_ID = new Uint8Array(16).fill(1);
const RUN_ID = new Uint8Array(16).fill(2);
const CONNECTION_ID = new Uint8Array(16).fill(3);

/**
 * Runs a statement and returns `accepted`, or the database's error message
 * when a constraint refuses it.
 */
const attemptStatement = <A>(statement: Effect.Effect<A, SqlError>) =>
  Effect.match(statement, {
    // The SQL error wraps a constraint error, which wraps SQLite's own
    // error, and only SQLite's message names the constraint.
    onFailure: (error) => String(error.cause.cause),
    onSuccess: () => "accepted",
  });

/** Inserts a workflow with one start trigger `t1` and one start trigger `t2`. */
const storeWorkflowWithTriggers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO workflows (id, source, definition, enabled, created_at, updated_at)
    VALUES (${WORKFLOW_ID}, 'name: w', '{"name":"w","steps":[]}', 1, ${at}, ${at})`;
  yield* sql`
    INSERT INTO triggers (workflow_id, trigger_id, kind, event_kind, status, created_at, updated_at)
    VALUES (${WORKFLOW_ID}, 't1', 'start', 'task.created', 'active', ${at}, ${at}),
           (${WORKFLOW_ID}, 't2', 'start', 'task.created', 'active', ${at}, ${at})`;
});

/** The columns a test sets on a trigger effect; every other column gets a valid value. */
interface EffectRow {
  readonly state: string;
  readonly runId: Uint8Array | null;
  readonly triggerId?: string;
  readonly eventId?: number;
  readonly inputs?: string;
}

/**
 * Inserts one trigger effect row and returns `accepted`, or the database's
 * error message when a constraint refuses the row.
 */
const insertEffect = (row: EffectRow) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    attemptStatement(sql`
      INSERT INTO trigger_effects (workflow_id, trigger_id, event_id, state, inputs, run_id, matched_at)
      VALUES (${WORKFLOW_ID}, ${row.triggerId ?? "t1"}, ${row.eventId ?? 1}, ${row.state},
              ${row.inputs ?? "{}"}, ${row.runId}, ${at})`),
  );

/**
 * Sets the given columns on trigger `t1` and returns `accepted`, or the
 * database's error message when a constraint refuses the update.
 */
const updateTriggerColumns = (columns: Readonly<Record<string, string | null>>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    attemptStatement(sql`
      UPDATE triggers SET ${sql.csv(Object.entries(columns).map(([name, value]) => sql`${sql(name)} = ${value}`))}
      WHERE trigger_id = 't1'`),
  );

/**
 * Inserts one event row with the given source, connection and dedup key.
 * Returns `accepted`, or the database's error message when the dedup index
 * refuses it.
 */
const insertEvent = (source: string, connectionId: Uint8Array | null, dedupKey: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    attemptStatement(sql`
      INSERT INTO events (source, connection_id, system, kind, occurred_at, received_at, dedup_key, payload)
      VALUES (${source}, ${connectionId}, ${source}, 'cron.tick', ${at}, ${at}, ${dedupKey}, '{}')`),
  );

describe("the trigger_effects table", () => {
  it("accepts a pending and a discarded effect without a run, and a spawned effect with one", async () => {
    const results = await run(
      Effect.andThen(
        storeWorkflowWithTriggers,
        Effect.all([
          insertEffect({ state: "pending", runId: null, eventId: 1 }),
          insertEffect({ state: "discarded", runId: null, eventId: 2 }),
          insertEffect({ state: "spawned", runId: RUN_ID, eventId: 3 }),
        ]),
      ),
    );

    expect(results).toEqual(["accepted", "accepted", "accepted"]);
  });

  it("refuses a state other than pending, spawned and discarded", async () => {
    const results = await run(
      Effect.andThen(
        storeWorkflowWithTriggers,
        Effect.all([
          insertEffect({ state: "failed", runId: null, eventId: 1 }),
          insertEffect({ state: "held", runId: null, eventId: 2 }),
        ]),
      ),
    );

    for (const result of results) expect(result).toContain("CHECK constraint failed");
  });

  it("refuses a spawned effect without a run, and a run on an effect that is not spawned", async () => {
    const results = await run(
      Effect.andThen(
        storeWorkflowWithTriggers,
        Effect.all([
          insertEffect({ state: "spawned", runId: null, eventId: 1 }),
          insertEffect({ state: "pending", runId: RUN_ID, eventId: 2 }),
          insertEffect({ state: "discarded", runId: RUN_ID, eventId: 3 }),
        ]),
      ),
    );

    for (const result of results) expect(result).toContain("CHECK constraint failed");
  });

  it("refuses inputs that are not JSON", async () => {
    expect(
      await run(
        Effect.andThen(
          storeWorkflowWithTriggers,
          insertEffect({ state: "pending", runId: null, inputs: "{" }),
        ),
      ),
    ).toContain("CHECK constraint failed");
  });

  it("refuses a second effect of one trigger on one event, and accepts other triggers and other events", async () => {
    const results = await run(
      Effect.andThen(
        storeWorkflowWithTriggers,
        Effect.all([
          insertEffect({ state: "pending", runId: null, triggerId: "t1", eventId: 1 }),
          insertEffect({ state: "pending", runId: null, triggerId: "t2", eventId: 1 }),
          insertEffect({ state: "pending", runId: null, triggerId: "t1", eventId: 2 }),
          insertEffect({ state: "pending", runId: null, triggerId: "t1", eventId: 1 }),
        ]),
      ),
    );

    expect(results.slice(0, 3)).toEqual(["accepted", "accepted", "accepted"]);
    expect(results[3]).toContain("UNIQUE constraint failed");
  });

  it("refuses an effect of a trigger that does not exist", async () => {
    expect(
      await run(
        Effect.andThen(
          storeWorkflowWithTriggers,
          insertEffect({ state: "pending", runId: null, triggerId: "absent" }),
        ),
      ),
    ).toContain("FOREIGN KEY constraint failed");
  });

  it("deletes a trigger's effects with the trigger, and keeps the effects of its other triggers", async () => {
    const remaining = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* storeWorkflowWithTriggers;
        yield* insertEffect({ state: "pending", runId: null, triggerId: "t1" });
        yield* insertEffect({ state: "spawned", runId: RUN_ID, triggerId: "t2" });
        yield* sql`DELETE FROM triggers WHERE trigger_id = 't1'`;
        return yield* sql<{ readonly trigger_id: string }>`SELECT trigger_id FROM trigger_effects`;
      }),
    );

    expect(remaining).toEqual([{ trigger_id: "t2" }]);
  });
});

describe("the new columns of the triggers table", () => {
  it("accepts a health error with its message, stage and time, and clearing all three", async () => {
    const results = await run(
      Effect.andThen(
        storeWorkflowWithTriggers,
        Effect.all([
          updateTriggerColumns({
            health_error_message: "boom",
            health_error_stage: "start",
            health_error_at: at,
          }),
          updateTriggerColumns({
            health_error_message: null,
            health_error_stage: null,
            health_error_at: null,
          }),
        ]),
      ),
    );

    expect(results).toEqual(["accepted", "accepted"]);
  });

  it("refuses a health error with only some of its message, stage and time", async () => {
    const results = await run(
      Effect.andThen(
        storeWorkflowWithTriggers,
        Effect.all([
          updateTriggerColumns({ health_error_message: "boom" }),
          updateTriggerColumns({ health_error_at: at }),
          updateTriggerColumns({ health_error_stage: "start" }),
          updateTriggerColumns({ health_error_message: "boom", health_error_at: at }),
        ]),
      ),
    );

    for (const result of results) expect(result).toContain("CHECK constraint failed");
  });

  it("refuses a health error stage that is not evaluation, scheduling or start", async () => {
    expect(
      await run(
        Effect.andThen(
          storeWorkflowWithTriggers,
          updateTriggerColumns({
            health_error_message: "boom",
            health_error_stage: "routing",
            health_error_at: at,
          }),
        ),
      ),
    ).toContain("CHECK constraint failed");
  });

  it("accepts a stretch of skipped ticks with both ends, and clearing both", async () => {
    const results = await run(
      Effect.andThen(
        storeWorkflowWithTriggers,
        Effect.all([
          updateTriggerColumns({ skipped_from: at, skipped_until: later }),
          updateTriggerColumns({ skipped_from: null, skipped_until: null }),
        ]),
      ),
    );

    expect(results).toEqual(["accepted", "accepted"]);
  });

  it("refuses a stretch of skipped ticks with only one end", async () => {
    const results = await run(
      Effect.andThen(
        storeWorkflowWithTriggers,
        Effect.all([
          updateTriggerColumns({ skipped_from: at }),
          updateTriggerColumns({ skipped_until: later }),
        ]),
      ),
    );

    for (const result of results) expect(result).toContain("CHECK constraint failed");
  });

  it("refuses an input mapping that is not JSON", async () => {
    expect(
      await run(Effect.andThen(storeWorkflowWithTriggers, updateTriggerColumns({ inputs: "{" }))),
    ).toContain("CHECK constraint failed");
  });
});

describe("the trigger_event column of the runs table", () => {
  /** Inserts a finished run with the given triggering event, and returns the outcome. */
  const insertRun = (triggerEvent: string | null) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      attemptStatement(sql`
        INSERT INTO runs (id, plan, inputs, origin, status, created_at, started_at, finished_at, trigger_event)
        VALUES (randomblob(16), '{}', '{}', '{}', 'completed', ${at}, ${at}, ${at}, ${triggerEvent})`),
    );

  it("accepts no triggering event, and a triggering event that is JSON", async () => {
    expect(await run(Effect.all([insertRun(null), insertRun('{"id":1}')]))).toEqual([
      "accepted",
      "accepted",
    ]);
  });

  it("refuses a triggering event that is not JSON", async () => {
    expect(await run(insertRun("an event"))).toContain("CHECK constraint failed");
  });
});

describe("the dedup index of the events table", () => {
  it("accepts one dedup key from two sources, on the same connection and on no connection", async () => {
    const results = await run(
      Effect.all([
        insertEvent("cron", null, "key"),
        insertEvent("manual", null, "key"),
        insertEvent("github", CONNECTION_ID, "key"),
        insertEvent("gmail", CONNECTION_ID, "key"),
      ]),
    );

    expect(results).toEqual(["accepted", "accepted", "accepted", "accepted"]);
  });

  it("refuses one dedup key twice from the same source and connection", async () => {
    const results = await run(
      Effect.all([
        insertEvent("manual", null, "key"),
        insertEvent("manual", null, "key"),
        insertEvent("github", CONNECTION_ID, "key"),
        insertEvent("github", CONNECTION_ID, "key"),
      ]),
    );

    expect(results[0]).toBe("accepted");
    expect(results[1]).toContain("UNIQUE constraint failed");
    expect(results[2]).toBe("accepted");
    expect(results[3]).toContain("UNIQUE constraint failed");
  });
});

describe("the input mapping of a start trigger saved before the migration", () => {
  /**
   * Stores a workflow whose definition declares a start trigger with an input
   * mapping, one without, and a signal trigger, on the migrations before this
   * one. Runs this migration, and returns each trigger's `inputs` column.
   */
  const seedAndMigrate = (): Promise<Readonly<Record<string, string | null>>> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(migrations.filter(([id]) => id < 37));
        const source = { kind: "task.created" };
        const definition = {
          name: "w",
          steps: [],
          triggers: [
            { id: "mapped", kind: "start", source, inputs: { title: "event.payload.title" } },
            { id: "unmapped", kind: "start", source },
            {
              id: "signal",
              kind: "signal",
              source,
              correlation: { event: "event.id", run: "inputs.id" },
            },
          ],
        };
        yield* sql`
          INSERT INTO workflows (id, source, definition, enabled, created_at, updated_at)
          VALUES (${WORKFLOW_ID}, 'name: w', ${JSON.stringify(definition)}, 1, ${at}, ${at})`;
        yield* sql`
          INSERT INTO triggers (workflow_id, trigger_id, kind, event_kind, status, created_at, updated_at)
          VALUES (${WORKFLOW_ID}, 'mapped', 'start', 'task.created', 'active', ${at}, ${at}),
                 (${WORKFLOW_ID}, 'unmapped', 'start', 'task.created', 'active', ${at}, ${at}),
                 (${WORKFLOW_ID}, 'signal', 'signal', 'task.created', NULL, ${at}, ${at})`;
        yield* runMigrations();
        const rows = yield* sql<{
          readonly trigger_id: string;
          readonly inputs: string | null;
        }>`SELECT trigger_id, inputs FROM triggers`;
        return Object.fromEntries(rows.map((row) => [row.trigger_id, row.inputs]));
      }).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie),
    );

  it("is copied from the workflow's definition, and stays empty where none is declared", async () => {
    const inputs = await seedAndMigrate();

    expect(JSON.parse(inputs["mapped"]!)).toEqual({ title: "event.payload.title" });
    expect(inputs["unmapped"]).toBeNull();
    expect(inputs["signal"]).toBeNull();
  });
});
