/**
 * Tests the `trigger_effects` repository: a start trigger's match on an event
 * is written once, waits as `pending` in the order it was written, and stops
 * being pending once its run starts or it is discarded.
 *
 * Also tests what `TriggerEffects.startRun` does when the run cannot start:
 * a failure a later try may get past leaves the match pending, and any other
 * failure discards it and records the error on the trigger's health.
 *
 * And tests the spawn bound: a match over the bound trips the breaker and is
 * held, and held events start oldest first, as the window has room, once the
 * trigger is resumed.
 */
import { describe, expect, it } from "vitest";
import { Clock, Duration, Effect, Exit, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import { ConstraintError, LockTimeoutError, SqlError } from "effect/sql/SqlError";
import { DEFAULT_SPAWN_BOUND, type TriggerKey } from "@hercule/contract";
import { mintUuid, uuidFromString, uuidToString, withTransaction } from "../db";
import { buildAnnouncementRecorder, inTransaction, TestDatabase } from "../db/testing";
import { appendCronTickEvent, AuditLogLayer, readPipelineEvent } from "../events";
import { readEventsOfKind } from "../events/testing";
import { NotifierLayer } from "../notifications";
import { SettingsLayer } from "../settings";
import { workflowRepository } from "./repository";
import { buildWindowStart } from "./spawn-bounds";
import { declareStartTrigger } from "./testing";
import { TriggeredRuns } from "./runs";
import { TriggerEffects, TriggerEffectsLayer, triggerEffectRepository } from "./trigger-effects";
import { TriggerHealthLayer } from "./trigger-health";

const SAVED_AT = "2026-09-22T10:00:00.000Z";
const MATCHED_AT = "2026-09-22T10:05:00.000Z";
const SPAWNED_AT = "2026-09-22T10:05:01.000Z";
const RUN_ID = "0199e0e7-0000-7000-8000-00000000e001";

/** Inserts a workflow with start triggers `a` and `b`. Returns the workflow id. */
const storeWorkflow = inTransaction(
  Effect.gen(function* () {
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
  }),
);

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(effect.pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie));

describe("the trigger effect repository", () => {
  it("writes one effect when the same trigger matches the same event twice, and says whether it wrote one", async () => {
    const { wrote, pendingIds, stored } = await run(
      Effect.gen(function* () {
        const effects = yield* triggerEffectRepository;
        const workflowId = yield* storeWorkflow;
        const first = yield* effects.insertMatch(
          {
            workflowId,
            triggerId: "a",
            eventId: 7,
            inputs: { title: "first" },
            matchedAt: MATCHED_AT,
          },
          "pending",
        );
        const second = yield* effects.insertMatch(
          {
            workflowId,
            triggerId: "a",
            eventId: 7,
            inputs: { title: "second" },
            matchedAt: MATCHED_AT,
          },
          "held",
        );
        const pendingIds = yield* effects.listPendingIds();
        return {
          wrote: [first, second],
          pendingIds,
          stored: yield* effects.readPending(pendingIds[0]!),
        };
      }),
    );

    expect(wrote).toEqual([true, false]);
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
          yield* effects.insertMatch(
            {
              workflowId,
              triggerId,
              eventId,
              inputs: {},
              matchedAt: MATCHED_AT,
            },
            "pending",
          );
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
          yield* effects.insertMatch(
            {
              workflowId,
              triggerId: "a",
              eventId,
              inputs: {},
              matchedAt: MATCHED_AT,
            },
            "pending",
          );
        }
        const written = yield* effects.listPendingIds();
        yield* effects.markSpawned(written[0]!, RUN_ID, SPAWNED_AT);
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
        yield* effects.insertMatch(
          {
            workflowId,
            triggerId: "b",
            eventId: 42,
            inputs,
            matchedAt: MATCHED_AT,
          },
          "pending",
        );
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
          yield* effects.insertMatch(
            {
              workflowId,
              triggerId: "a",
              eventId,
              inputs: {},
              matchedAt: MATCHED_AT,
            },
            "pending",
          );
        }
        const [spawned, discarded] = yield* effects.listPendingIds();
        yield* effects.markSpawned(spawned!, RUN_ID, SPAWNED_AT);
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
        yield* effects.insertMatch(
          {
            workflowId,
            triggerId: "b",
            eventId: 5,
            inputs: {},
            matchedAt: MATCHED_AT,
          },
          "pending",
        );
        const [id] = yield* effects.listPendingIds();
        const first = yield* effects.discardIfPending(id!);
        return { workflowId, first, second: yield* effects.discardIfPending(id!) };
      }),
    );

    expect(Option.getOrThrow(first)).toEqual({ workflowId, triggerId: "b", eventId: 5 });
    expect(Option.isNone(second)).toBe(true);
  });

  it("records the run a spawned effect started and when it started, and keeps when the trigger matched", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const effects = yield* triggerEffectRepository;
        const workflowId = yield* storeWorkflow;
        yield* effects.insertMatch(
          {
            workflowId,
            triggerId: "a",
            eventId: 1,
            inputs: {},
            matchedAt: MATCHED_AT,
          },
          "pending",
        );
        const [id] = yield* effects.listPendingIds();
        yield* effects.markSpawned(id!, RUN_ID, SPAWNED_AT);
        return yield* sql<{
          readonly state: string;
          readonly run_id: string;
          readonly matched_at: string;
          readonly spawned_at: string;
        }>`SELECT state, lower(hex(run_id)) AS run_id, matched_at, spawned_at FROM trigger_effects`;
      }),
    );

    expect(rows).toEqual([
      {
        state: "spawned",
        run_id: RUN_ID.replaceAll("-", ""),
        matched_at: MATCHED_AT,
        spawned_at: SPAWNED_AT,
      },
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
            Layer.provide(NotifierLayer),
            Layer.provide(SettingsLayer),
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
    yield* inTransaction(workflows.update(workflowId, { enabled: true }, SAVED_AT));
    yield* inTransaction(
      appendCronTickEvent(
        sql,
        { workflowId, triggerId: "a", scheduledFor: MATCHED_AT, previousFiredAt: null },
        MATCHED_AT,
      ),
    );
    const [event] = yield* sql<{ readonly id: number }>`SELECT id FROM events`;
    yield* inTransaction(
      effects.insertMatch(
        {
          workflowId,
          triggerId: "a",
          eventId: event!.id,
          inputs: {},
          matchedAt: MATCHED_AT,
        },
        "pending",
      ),
    );
    const [id] = yield* effects.listPendingIds();

    const exit = yield* Effect.exit(triggerEffects.startRun(id!));
    const [row] = yield* sql<{ readonly state: string }>`SELECT state FROM trigger_effects`;
    const trigger = yield* workflows.readTrigger(
      { workflowId, triggerId: "a" },
      DEFAULT_SPAWN_BOUND,
      MATCHED_AT,
    );
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

describe("the spawn bound", () => {
  /** When the tests start. Every time below is this plus some seconds. */
  const START = Date.parse("2026-09-22T10:00:00.000Z");

  /** The bound of trigger `a`: two runs in any hour. */
  const BOUND = { maxRuns: 2, windowSeconds: 3600 };

  const layer = TriggerEffectsLayer.pipe(
    Layer.provide(
      Layer.succeed(TriggeredRuns)({ start: () => Effect.sync(() => uuidToString(mintUuid())) }),
    ),
    Layer.provide(TriggerHealthLayer),
    Layer.provideMerge(NotifierLayer),
    Layer.provideMerge(SettingsLayer),
    Layer.provideMerge(AuditLogLayer),
    Layer.provideMerge(TestDatabase),
  );

  /** Runs `effect` on a `TestClock` set to `START`. */
  const runBounded = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>): Promise<A> =>
    Effect.runPromise(
      Effect.andThen(TestClock.setTime(START), effect).pipe(
        Effect.provide(layer),
        Effect.provide(TestClock.layer()),
        Effect.orDie,
      ),
    );

  /** Stores an enabled workflow whose start trigger `a` runs under `BOUND`. Returns the key of `a`. */
  const storeBoundedTrigger = inTransaction(
    Effect.gen(function* () {
      const workflows = yield* workflowRepository;
      const stored = yield* workflows.insert(
        { source: "name: Bounded\nsteps: []\n", definition: { name: "Bounded", steps: [] } },
        SAVED_AT,
      );
      yield* workflows.reconcileTriggers(
        stored.id,
        [declareStartTrigger("a", { spawnBound: BOUND })],
        SAVED_AT,
      );
      yield* workflows.update(stored.id, { enabled: true }, SAVED_AT);
      return { workflowId: stored.id, triggerId: "a" };
    }),
  );

  /** Resumes a trigger as `trigger.resume` does, keeping the events it holds. */
  const resume = (key: TriggerKey) =>
    inTransaction(
      Effect.gen(function* () {
        const workflows = yield* workflowRepository;
        const effects = yield* triggerEffectRepository;
        yield* workflows.setTriggerStatus(key, { status: "active" }, SAVED_AT);
        yield* effects.recordHeldAtResume(key);
      }),
    );

  /** Pauses a trigger manually, as `trigger.pause` does. */
  const pauseManually = (key: TriggerKey) =>
    inTransaction(
      Effect.gen(function* () {
        const workflows = yield* workflowRepository;
        const effects = yield* triggerEffectRepository;
        yield* workflows.setTriggerStatus(key, { status: "paused", pausedBy: "manual" }, SAVED_AT);
        yield* effects.holdPending(key);
      }),
    );

  /**
   * Appends a new event and records trigger `a`'s match on it, as the event
   * router does. Returns the event's id.
   */
  const matchNewEvent = (key: TriggerKey) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = new Date(yield* Clock.currentTimeMillis).toISOString();
      const [{ count } = { count: 0 }] = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count FROM events`;
      yield* inTransaction(
        appendCronTickEvent(
          sql,
          {
            ...key,
            scheduledFor: `2026-01-01T00:00:${String(count).padStart(2, "0")}.000Z`,
            previousFiredAt: null,
          },
          now,
        ),
      );
      const [row] = yield* sql<{ readonly id: number }>`SELECT max(id) AS id FROM events`;
      return yield* matchEvent(key, row!.id);
    });

  /** Records trigger `a`'s match on the event `eventId`. Returns the event's id. */
  const matchEvent = (key: TriggerKey, eventId: number) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const triggerEffects = yield* TriggerEffects;
      const routable = yield* triggerEffects.listRoutableStartTriggers();
      const trigger = routable.find((candidate) => candidate.triggerId === key.triggerId)!;
      const event = Option.getOrThrow(yield* readPipelineEvent(sql, eventId));
      yield* withTransaction(sql, triggerEffects.recordMatch(trigger, event, {}));
      return eventId;
    });

  /** Does what the delivery does on one tick: moves held events to pending, then starts every pending run. */
  const deliver = Effect.gen(function* () {
    const triggerEffects = yield* TriggerEffects;
    yield* triggerEffects.promoteHeldEvents();
    for (const id of yield* triggerEffects.listPendingIds()) yield* triggerEffects.startRun(id);
  });

  /** Returns the state of every trigger effect, in the order they were written. */
  const readStates = Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(
      sql<{ readonly state: string }>`SELECT state FROM trigger_effects ORDER BY id`,
      (rows) => rows.map((row) => row.state),
    ),
  );

  /** Returns the event id and start time of every spawned effect, in the order they started. */
  const readSpawned = Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql<{ readonly event_id: number; readonly spawned_at: string }>`
      SELECT event_id, spawned_at FROM trigger_effects WHERE state = 'spawned'
      ORDER BY spawned_at, id`,
  );

  /** Reads trigger `a` as the API does. */
  const readBoundedTrigger = (key: TriggerKey) =>
    Effect.gen(function* () {
      const workflows = yield* workflowRepository;
      const now = new Date(yield* Clock.currentTimeMillis).toISOString();
      return Option.getOrThrow(yield* workflows.readTrigger(key, DEFAULT_SPAWN_BOUND, now));
    });

  /** Returns the kind and status of every notification. */
  const readNotifications = Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql<{ readonly kind: string; readonly status: string }>`
      SELECT kind, status FROM notifications ORDER BY created_at, id`,
  );

  /** Moves the clock on by `seconds`. */
  const wait = (seconds: number) => TestClock.adjust(Duration.seconds(seconds));

  /**
   * Trips the breaker of a new bounded trigger with four matches, starts the
   * two runs the window has room for, and resumes the trigger with the other
   * two still held. Returns the trigger's key.
   */
  const tripAndResume = Effect.gen(function* () {
    const key = yield* storeBoundedTrigger;
    for (let index = 0; index < 4; index++) yield* matchNewEvent(key);
    yield* deliver;
    yield* resume(key);
    return key;
  });

  /** Sets or clears the invalid mark of the workflow, as the validity check does. */
  const markInvalid = (workflowId: string, invalid: boolean) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      withTransaction(
        sql,
        sql`
        UPDATE workflows SET invalid_since = ${invalid ? SAVED_AT : null}
        WHERE id = ${uuidFromString(workflowId)}`,
      ),
    );

  it("writes matches pending while the window has room, counting the pending ones", async () => {
    const { states, trigger } = await runBounded(
      Effect.gen(function* () {
        const key = yield* storeBoundedTrigger;
        yield* matchNewEvent(key);
        yield* matchNewEvent(key);
        return { states: yield* readStates, trigger: yield* readBoundedTrigger(key) };
      }),
    );

    expect(states).toEqual(["pending", "pending"]);
    expect(trigger).toMatchObject({
      status: "active",
      spawnBound: { ...BOUND, isDefault: false },
      runsInWindow: 2,
      heldCount: 0,
    });
  });

  it("trips the breaker on the match over the bound: holds it, pauses the trigger, and raises one decision", async () => {
    const { states, trigger, notifications, paused } = await runBounded(
      Effect.gen(function* () {
        const key = yield* storeBoundedTrigger;
        for (let index = 0; index < 4; index++) yield* matchNewEvent(key);
        return {
          states: yield* readStates,
          trigger: yield* readBoundedTrigger(key),
          notifications: yield* readNotifications,
          paused: yield* readEventsOfKind("trigger.paused"),
        };
      }),
    );

    expect(states).toEqual(["pending", "pending", "held", "held"]);
    expect(trigger).toMatchObject({
      status: "paused",
      pausedBy: "breaker",
      runsInWindow: 2,
      heldCount: 2,
    });
    // The second held match finds the trigger paused, and raises nothing.
    expect(notifications).toEqual([{ kind: "core.breaker-tripped", status: "open" }]);
    expect(paused).toHaveLength(1);
    expect(paused[0]).toMatchObject({
      actor: "system",
      payload: { workflowId: trigger.workflowId, triggerId: "a", pausedBy: "breaker" },
    });
  });

  it("does not trip the breaker when an event that already has its match is routed again", async () => {
    const { states, trigger, notifications } = await runBounded(
      Effect.gen(function* () {
        const key = yield* storeBoundedTrigger;
        yield* matchNewEvent(key);
        const second = yield* matchNewEvent(key);
        yield* matchEvent(key, second);
        return {
          states: yield* readStates,
          trigger: yield* readBoundedTrigger(key),
          notifications: yield* readNotifications,
        };
      }),
    );

    expect(states).toEqual(["pending", "pending"]);
    expect(trigger.status).toBe("active");
    expect(notifications).toEqual([]);
  });

  it("writes nothing for a trigger paused manually after the event router listed it", async () => {
    const states = await runBounded(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const workflows = yield* workflowRepository;
        const triggerEffects = yield* TriggerEffects;
        const key = yield* storeBoundedTrigger;
        const [trigger] = yield* triggerEffects.listRoutableStartTriggers();
        yield* inTransaction(
          workflows.setTriggerStatus(key, { status: "paused", pausedBy: "manual" }, SAVED_AT),
        );
        yield* inTransaction(
          appendCronTickEvent(
            sql,
            { ...key, scheduledFor: MATCHED_AT, previousFiredAt: null },
            MATCHED_AT,
          ),
        );
        const [row] = yield* sql<{ readonly id: number }>`SELECT max(id) AS id FROM events`;
        const event = Option.getOrThrow(yield* readPipelineEvent(sql, row!.id));
        yield* inTransaction(triggerEffects.recordMatch(trigger!, event, {}));
        return yield* readStates;
      }),
    );

    expect(states).toEqual([]);
  });

  it("counts a run by when it started, so the window frees up as the runs in it age", async () => {
    const { before, after } = await runBounded(
      Effect.gen(function* () {
        const key = yield* storeBoundedTrigger;
        yield* matchNewEvent(key);
        yield* matchNewEvent(key);
        yield* deliver;
        const before = yield* readBoundedTrigger(key);
        yield* wait(3601);
        yield* matchNewEvent(key);
        return { before, after: yield* readBoundedTrigger(key) };
      }),
    );

    expect(before).toMatchObject({ runsInWindow: 2, heldCount: 0 });
    // The two runs started over an hour ago, so the new match was pending
    // and is the only run in the window.
    expect(after).toMatchObject({ status: "active", runsInWindow: 1, heldCount: 0 });
  });

  it("starts the held events oldest first as the window has room once resumed, queueing new matches behind them", async () => {
    const result = await runBounded(
      Effect.gen(function* () {
        const key = yield* storeBoundedTrigger;
        const events: Array<number> = [];
        for (let index = 0; index < 4; index++) events.push(yield* matchNewEvent(key));
        yield* deliver;
        // A breaker-paused trigger still starts the runs of its pending
        // matches, and starts none of its held ones.
        const whilePaused = yield* readStates;

        yield* resume(key);
        // The trigger still holds events, so a new match queues behind them.
        events.push(yield* matchNewEvent(key));
        yield* deliver;
        const resumedInFullWindow = yield* readStates;

        yield* wait(3601);
        yield* deliver;
        const afterOneWindow = yield* readStates;
        const midway = yield* readBoundedTrigger(key);

        yield* wait(3601);
        yield* deliver;
        return {
          events,
          whilePaused,
          resumedInFullWindow,
          afterOneWindow,
          midway,
          trigger: yield* readBoundedTrigger(key),
          spawned: yield* readSpawned,
          notifications: yield* readNotifications,
        };
      }),
    );

    expect(result.whilePaused).toEqual(["spawned", "spawned", "held", "held"]);
    expect(result.resumedInFullWindow).toEqual(["spawned", "spawned", "held", "held", "held"]);
    expect(result.afterOneWindow).toEqual(["spawned", "spawned", "spawned", "spawned", "held"]);
    // The runs of the first two matches left the window. The two that just
    // started count, though they matched over an hour ago.
    expect(result.midway).toMatchObject({ status: "active", runsInWindow: 2, heldCount: 1 });
    expect(result.trigger).toMatchObject({ status: "active", heldCount: 0 });
    expect(result.spawned.map((row) => row.event_id)).toEqual(result.events);
    expect(result.notifications).toEqual([{ kind: "core.breaker-tripped", status: "open" }]);
  });

  it("holds the pending matches too when the trigger the breaker paused is paused manually", async () => {
    const states = await runBounded(
      Effect.gen(function* () {
        const key = yield* storeBoundedTrigger;
        for (let index = 0; index < 3; index++) yield* matchNewEvent(key);
        yield* pauseManually(key);
        yield* wait(3601);
        yield* deliver;
        return yield* readStates;
      }),
    );

    // Every matched event waits for the resume, the ones that were about to
    // start a run included.
    expect(states).toEqual(["held", "held", "held"]);
  });

  it("discards the held events of a trigger whose kind a save changed", async () => {
    const states = await runBounded(
      Effect.gen(function* () {
        const workflows = yield* workflowRepository;
        const key = yield* storeBoundedTrigger;
        for (let index = 0; index < 3; index++) yield* matchNewEvent(key);
        yield* inTransaction(
          workflows.reconcileTriggers(
            key.workflowId,
            [declareStartTrigger("a", { kind: "signal" })],
            SAVED_AT,
          ),
        );
        return yield* readStates;
      }),
    );

    expect(states).toEqual(["pending", "pending", "discarded"]);
  });
  it("announces the trigger's counts when it writes a match", async () => {
    const { listener, announced } = buildAnnouncementRecorder();
    const workflowId = await runBounded(
      Effect.gen(function* () {
        const key = yield* storeBoundedTrigger;
        yield* matchNewEvent(key);
        return key.workflowId;
      }).pipe(Effect.provide(listener)),
    );

    expect(announced).toContainEqual({
      _tag: "record",
      topic: "workflow",
      id: workflowId,
      kind: "updated",
      countsOnly: true,
    });
  });

  it("starts the window just after now less its length, written as the stored times are", async () => {
    const result = await runBounded(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const effects = yield* triggerEffectRepository;
        const key = yield* storeBoundedTrigger;
        const now = new Date(START).toISOString();
        const [row] = yield* sql<{ readonly start: string }>`
          SELECT ${buildWindowStart(sql, DEFAULT_SPAWN_BOUND, now)} AS start
          FROM triggers WHERE trigger_id = 'a'`;
        yield* matchNewEvent(key);
        yield* matchNewEvent(key);
        const [atStart, justAfter] = yield* effects.listPendingIds();
        yield* inTransaction(
          effects.markSpawned(atStart!, RUN_ID, new Date(START - 3_600_000).toISOString()),
        );
        yield* inTransaction(
          effects.markSpawned(
            justAfter!,
            "0199e0e7-0000-7000-8000-00000000e002",
            new Date(START - 3_599_999).toISOString(),
          ),
        );
        return { start: row!.start, trigger: yield* readBoundedTrigger(key) };
      }),
    );

    expect(result.start).toBe(new Date(START - 3_600_000).toISOString());
    // A run started exactly one window ago has left it; one a millisecond later has not.
    expect(result.trigger).toMatchObject({ runsInWindow: 1 });
  });

  it("starts no run for the pending matches of an invalid workflow, until the workflow is valid again", async () => {
    const result = await runBounded(
      Effect.gen(function* () {
        const triggerEffects = yield* TriggerEffects;
        const key = yield* storeBoundedTrigger;
        yield* matchNewEvent(key);
        yield* matchNewEvent(key);
        yield* markInvalid(key.workflowId, true);
        const listedWhileInvalid = yield* triggerEffects.listPendingIds();
        yield* deliver;
        const whileInvalid = yield* readStates;
        yield* markInvalid(key.workflowId, false);
        yield* deliver;
        return { listedWhileInvalid, whileInvalid, afterFix: yield* readStates };
      }),
    );

    expect(result.listedWhileInvalid).toEqual([]);
    // The matches wait, rather than being discarded, so fixing the workflow starts them.
    expect(result.whileInvalid).toEqual(["pending", "pending"]);
    expect(result.afterFix).toEqual(["spawned", "spawned"]);
  });

  it("holds the matches moved to pending when the trigger is paused manually before their runs start", async () => {
    const result = await runBounded(
      Effect.gen(function* () {
        const triggerEffects = yield* TriggerEffects;
        const key = yield* tripAndResume;
        yield* wait(3601);
        yield* triggerEffects.promoteHeldEvents();
        const promoted = yield* readStates;
        yield* pauseManually(key);
        yield* deliver;
        return { promoted, afterPause: yield* readStates };
      }),
    );

    expect(result.promoted).toEqual(["spawned", "spawned", "pending", "pending"]);
    expect(result.afterPause).toEqual(["spawned", "spawned", "held", "held"]);
  });

  it("keeps the held events of a resumed trigger while its workflow is disabled, and starts them once it is enabled", async () => {
    const result = await runBounded(
      Effect.gen(function* () {
        const workflows = yield* workflowRepository;
        const key = yield* storeBoundedTrigger;
        for (let index = 0; index < 4; index++) yield* matchNewEvent(key);
        yield* deliver;
        yield* inTransaction(workflows.update(key.workflowId, { enabled: false }, SAVED_AT));
        yield* resume(key);
        yield* wait(3601);
        yield* deliver;
        const whileDisabled = yield* readStates;
        yield* inTransaction(workflows.update(key.workflowId, { enabled: true }, SAVED_AT));
        yield* deliver;
        return { whileDisabled, afterEnable: yield* readStates };
      }),
    );

    expect(result.whileDisabled).toEqual(["spawned", "spawned", "held", "held"]);
    expect(result.afterEnable).toEqual(["spawned", "spawned", "spawned", "spawned"]);
  });

  it("does not trip the breaker again while new matches arrive no faster than the bound", async () => {
    const { trigger, paused } = await runBounded(
      Effect.gen(function* () {
        const key = yield* tripAndResume;
        for (let window = 0; window < 3; window++) {
          yield* wait(3601);
          yield* matchNewEvent(key);
          yield* matchNewEvent(key);
          yield* deliver;
        }
        return {
          trigger: yield* readBoundedTrigger(key),
          paused: yield* readEventsOfKind("trigger.paused"),
        };
      }),
    );

    // The trigger keeps holding two events, never more, so it stays active.
    expect(trigger).toMatchObject({ status: "active", heldCount: 2 });
    expect(paused).toHaveLength(1);
  });

  it("holds the pending matches again when a save lowers the bound before their runs start", async () => {
    const result = await runBounded(
      Effect.gen(function* () {
        const workflows = yield* workflowRepository;
        const key = yield* storeBoundedTrigger;
        yield* matchNewEvent(key);
        yield* matchNewEvent(key);
        yield* inTransaction(
          workflows.reconcileTriggers(
            key.workflowId,
            [declareStartTrigger("a", { spawnBound: { maxRuns: 1, windowSeconds: 3600 } })],
            SAVED_AT,
          ),
        );
        yield* deliver;
        const afterSave = { states: yield* readStates, trigger: yield* readBoundedTrigger(key) };
        // The held event was matched within the bound, so it does not count
        // toward tripping the breaker: one new match does not trip it.
        yield* matchNewEvent(key);
        const afterMatch = yield* readBoundedTrigger(key);
        yield* wait(3601);
        yield* deliver;
        return { afterSave, afterMatch, afterWindow: yield* readStates };
      }),
    );

    expect(result.afterSave.states).toEqual(["spawned", "held"]);
    expect(result.afterSave.trigger).toMatchObject({
      status: "active",
      runsInWindow: 1,
      heldCount: 1,
    });
    expect(result.afterMatch).toMatchObject({ status: "active", heldCount: 2 });
    expect(result.afterWindow).toEqual(["spawned", "spawned", "held"]);
  });

  it("trips the breaker again once the events it holds grow by the bound since the resume", async () => {
    const { states, trigger, paused } = await runBounded(
      Effect.gen(function* () {
        const key = yield* tripAndResume;
        yield* wait(3601);
        // Each run of a workflow that triggers itself matches twice, so the
        // inflow is twice the bound.
        for (let index = 0; index < 4; index++) yield* matchNewEvent(key);
        return {
          states: yield* readStates,
          trigger: yield* readBoundedTrigger(key),
          paused: yield* readEventsOfKind("trigger.paused"),
        };
      }),
    );

    // The trigger held two events when it was resumed. The third new match
    // brings it to four, two more than at the resume, and trips the breaker.
    expect(states).toEqual(["spawned", "spawned", "held", "held", "held", "held", "held", "held"]);
    expect(trigger).toMatchObject({ status: "paused", pausedBy: "breaker", heldCount: 6 });
    expect(paused).toHaveLength(2);
  });
});
