/**
 * Tests the `trigger_effects` repository: a start trigger's match on an event
 * is written once, waits as `pending` in the order it was written, and stops
 * being pending once its run starts or it is discarded.
 *
 * Also tests what `TriggerEffects.startRun` does when the run cannot start:
 * a failure a later try may get past leaves the match pending, and any other
 * failure discards it and records the error on the trigger's health.
 */
import { describe, expect, it } from "vitest";
import { Effect, Exit, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ConstraintError, LockTimeoutError, SqlError } from "effect/unstable/sql/SqlError";
import { TestDatabase } from "../db/testing";
import { appendCronTickEvent, AuditLogLayer } from "../events";
import { NotificationServiceLayer } from "../notifications";
import { workflowRepository } from "./repository";
import { declareStartTrigger } from "./testing";
import { TriggeredRuns } from "./runs";
import { TriggerEffects, TriggerEffectsLayer, triggerEffectRepository } from "./trigger-effects";
import { TriggerHealthLayer } from "./trigger-health";

const SAVED_AT = "2026-09-22T10:00:00.000Z";
const MATCHED_AT = "2026-09-22T10:05:00.000Z";
const RUN_ID = "0199e0e7-0000-7000-8000-00000000e001";

/** Inserts a workflow with start triggers `a` and `b`. Returns the workflow id. */
const storeWorkflow = Effect.gen(function* () {
  const workflows = yield* workflowRepository;
  const stored = yield* workflows.insert(
    { source: "name: Routed\nsteps: []\n", definition: { name: "Routed", steps: [] } },
    SAVED_AT,
  );
  yield* workflows.reconcileTriggers(
    stored.id,
    [declareStartTrigger("a"), declareStartTrigger("b")],
    SAVED_AT,
  );
  return stored.id;
});

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(TestDatabase), Effect.orDie));

describe("the trigger effect repository", () => {
  it("writes one pending effect when the same trigger matches the same event twice", async () => {
    const { pendingIds, stored } = await run(
      Effect.gen(function* () {
        const effects = yield* triggerEffectRepository;
        const workflowId = yield* storeWorkflow;
        yield* effects.insertPending({
          workflowId,
          triggerId: "a",
          eventId: 7,
          inputs: { title: "first" },
          matchedAt: MATCHED_AT,
        });
        yield* effects.insertPending({
          workflowId,
          triggerId: "a",
          eventId: 7,
          inputs: { title: "second" },
          matchedAt: MATCHED_AT,
        });
        const pendingIds = yield* effects.listPendingIds();
        return { pendingIds, stored: yield* effects.readPending(pendingIds[0]!) };
      }),
    );

    expect(pendingIds).toHaveLength(1);
    // The second match is ignored, so the inputs are those of the first.
    expect(Option.getOrThrow(stored).inputs).toEqual({ title: "first" });
  });

  it("writes a pending effect for each trigger and each event", async () => {
    const pendingIds = await run(
      Effect.gen(function* () {
        const effects = yield* triggerEffectRepository;
        const workflowId = yield* storeWorkflow;
        for (const [triggerId, eventId] of [
          ["a", 1],
          ["b", 1],
          ["a", 2],
        ] as const) {
          yield* effects.insertPending({
            workflowId,
            triggerId,
            eventId,
            inputs: {},
            matchedAt: MATCHED_AT,
          });
        }
        return yield* effects.listPendingIds();
      }),
    );

    expect(pendingIds).toHaveLength(3);
  });

  it("lists the pending ids in the order the effects were written, without the spawned and discarded ones", async () => {
    const { written, pendingIds } = await run(
      Effect.gen(function* () {
        const effects = yield* triggerEffectRepository;
        const workflowId = yield* storeWorkflow;
        for (const eventId of [1, 2, 3, 4]) {
          yield* effects.insertPending({
            workflowId,
            triggerId: "a",
            eventId,
            inputs: {},
            matchedAt: MATCHED_AT,
          });
        }
        const written = yield* effects.listPendingIds();
        yield* effects.markSpawned(written[0]!, RUN_ID);
        yield* effects.discardIfPending(written[2]!);
        return { written, pendingIds: yield* effects.listPendingIds() };
      }),
    );

    expect(written).toEqual([...written].sort((left, right) => left - right));
    expect(pendingIds).toEqual([written[1], written[3]]);
  });

  it("reads a pending effect with its trigger, its event and its inputs as they were written", async () => {
    const inputs = {
      title: "Fix the build",
      labels: ["ci", "urgent"],
      count: 3,
      nested: { a: null },
    };
    const { workflowId, stored } = await run(
      Effect.gen(function* () {
        const effects = yield* triggerEffectRepository;
        const workflowId = yield* storeWorkflow;
        yield* effects.insertPending({
          workflowId,
          triggerId: "b",
          eventId: 42,
          inputs,
          matchedAt: MATCHED_AT,
        });
        const [id] = yield* effects.listPendingIds();
        return { workflowId, stored: yield* effects.readPending(id!) };
      }),
    );

    expect(Option.getOrThrow(stored)).toMatchObject({
      workflowId,
      triggerId: "b",
      eventId: 42,
      inputs,
    });
  });

  it("reads nothing for an effect once its run is spawned or it is discarded, or for an id that was never written", async () => {
    const reads = await run(
      Effect.gen(function* () {
        const effects = yield* triggerEffectRepository;
        const workflowId = yield* storeWorkflow;
        for (const eventId of [1, 2]) {
          yield* effects.insertPending({
            workflowId,
            triggerId: "a",
            eventId,
            inputs: {},
            matchedAt: MATCHED_AT,
          });
        }
        const [spawned, discarded] = yield* effects.listPendingIds();
        yield* effects.markSpawned(spawned!, RUN_ID);
        yield* effects.discardIfPending(discarded!);
        return [
          yield* effects.readPending(spawned!),
          yield* effects.readPending(discarded!),
          yield* effects.readPending(999),
        ];
      }),
    );

    for (const read of reads) expect(Option.isNone(read)).toBe(true);
  });

  it("discards a pending effect once, and returns its trigger and event only that time", async () => {
    const { workflowId, first, second } = await run(
      Effect.gen(function* () {
        const effects = yield* triggerEffectRepository;
        const workflowId = yield* storeWorkflow;
        yield* effects.insertPending({
          workflowId,
          triggerId: "b",
          eventId: 5,
          inputs: {},
          matchedAt: MATCHED_AT,
        });
        const [id] = yield* effects.listPendingIds();
        const first = yield* effects.discardIfPending(id!);
        return { workflowId, first, second: yield* effects.discardIfPending(id!) };
      }),
    );

    expect(Option.getOrThrow(first)).toEqual({ workflowId, triggerId: "b", eventId: 5 });
    expect(Option.isNone(second)).toBe(true);
  });

  it("records the run a spawned effect started, and keeps when the trigger matched", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const effects = yield* triggerEffectRepository;
        const workflowId = yield* storeWorkflow;
        yield* effects.insertPending({
          workflowId,
          triggerId: "a",
          eventId: 1,
          inputs: {},
          matchedAt: MATCHED_AT,
        });
        const [id] = yield* effects.listPendingIds();
        yield* effects.markSpawned(id!, RUN_ID);
        return yield* sql<{
          readonly state: string;
          readonly run_id: string;
          readonly matched_at: string;
        }>`SELECT state, lower(hex(run_id)) AS run_id, matched_at FROM trigger_effects`;
      }),
    );

    expect(rows).toEqual([
      { state: "spawned", run_id: RUN_ID.replaceAll("-", ""), matched_at: MATCHED_AT },
    ]);
  });
});

describe("starting the run of a pending trigger effect", () => {
  /**
   * Runs `effect` with a `TriggerEffects` whose every run start fails with
   * `error`, so the test sees only what `startRun` does with the failure.
   */
  const runWithFailingStart = <A, E>(
    error: SqlError,
    effect: Effect.Effect<A, E, TriggerEffects | SqlClient.SqlClient>,
  ): Promise<A> =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(
          TriggerEffectsLayer.pipe(
            Layer.provide(Layer.succeed(TriggeredRuns)({ start: () => Effect.fail(error) })),
            Layer.provide(TriggerHealthLayer),
            Layer.provide(NotificationServiceLayer),
            Layer.provide(AuditLogLayer),
            Layer.provideMerge(TestDatabase),
          ),
        ),
        Effect.orDie,
      ),
    );

  /**
   * Stores an enabled workflow with start triggers `a` and `b`, appends an
   * event, and writes trigger `a`'s match on it. Then calls `startRun` on the
   * match, and returns how the call ended, the match's state, and trigger
   * `a` as the API reads it.
   */
  const startMatchedRun = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const workflows = yield* workflowRepository;
    const effects = yield* triggerEffectRepository;
    const triggerEffects = yield* TriggerEffects;
    const workflowId = yield* storeWorkflow;
    yield* workflows.update(workflowId, { enabled: true }, SAVED_AT);
    yield* appendCronTickEvent(
      sql,
      { workflowId, triggerId: "a", scheduledFor: MATCHED_AT, previousFiredAt: null },
      MATCHED_AT,
    );
    const [event] = yield* sql<{ readonly id: number }>`SELECT id FROM events`;
    yield* effects.insertPending({
      workflowId,
      triggerId: "a",
      eventId: event!.id,
      inputs: {},
      matchedAt: MATCHED_AT,
    });
    const [id] = yield* effects.listPendingIds();

    const exit = yield* Effect.exit(triggerEffects.startRun(id!));
    const [row] = yield* sql<{ readonly state: string }>`SELECT state FROM trigger_effects`;
    const trigger = yield* workflows.readTrigger({ workflowId, triggerId: "a" });
    return { exit, state: row!.state, trigger: Option.getOrThrow(trigger) };
  });

  it("fails and leaves the effect pending, with the trigger healthy, when the database is busy", async () => {
    const busy = new SqlError({
      reason: new LockTimeoutError({ cause: undefined, message: "database is locked" }),
    });
    const { exit, state, trigger } = await runWithFailingStart(busy, startMatchedRun);

    expect(exit).toEqual(Exit.fail(busy));
    expect(state).toBe("pending");
    expect(trigger.health).toEqual({ state: "ok" });
  });

  it("discards the effect, and records on the trigger's health that the database refused it, when the database refuses the run", async () => {
    const refused = new SqlError({
      reason: new ConstraintError({ cause: undefined, message: "CHECK constraint failed" }),
    });
    const { exit, state, trigger } = await runWithFailingStart(refused, startMatchedRun);

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(state).toBe("discarded");
    if (trigger.health?.state !== "error") {
      expect.fail(`the trigger's health is not error: ${JSON.stringify(trigger)}`);
    }
    expect(trigger.health.message).toContain(
      "could not start, because the database refused it: CHECK constraint failed",
    );
  });
});
