/**
 * Tests how a save updates the trigger rows of a workflow, how the trigger
 * list is paged, and the reads and writes the event router and the Scheduler
 * make on trigger rows: health, status, the routable and schedulable lists,
 * and a cron trigger's schedule state.
 *
 * One save writes all of a workflow's triggers with the same `created_at`, so
 * `created_at` alone does not give a stable order. The list query also sorts by
 * workflow id and trigger id, and the cursor holds all three values. Without
 * them, a page that ends among rows with the same `created_at` would skip or
 * repeat rows on the next page.
 */
import { describe, expect, it } from "vitest";
import { Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ANY_CONNECTION, type Trigger, type TriggerKey } from "@hercule/contract";
import { uuidFromString } from "../db";
import { TestDatabase } from "../db/testing";
import { workflowRepository, type DeclaredTrigger } from "./repository";
import { declareCronTrigger, declareStartTrigger } from "./testing";

const FIRST_SAVE = "2026-09-22T10:00:00.000Z";
const SECOND_SAVE = "2026-09-22T11:00:00.000Z";

/** Inserts a workflow and its triggers, all saved at `savedAt`. Returns the workflow id. */
const storeWorkflow = (name: string, triggers: ReadonlyArray<DeclaredTrigger>, savedAt: string) =>
  Effect.gen(function* () {
    const workflows = yield* workflowRepository;
    const stored = yield* workflows.insert(
      { source: `name: ${name}\nsteps: []\n`, definition: { name, steps: [] } },
      savedAt,
    );
    yield* workflows.reconcileTriggers(stored.id, triggers, savedAt);
    return stored.id;
  });

/** Lists every trigger row in one page. Returns a map from trigger id to row. */
const readTriggers = Effect.gen(function* () {
  const workflows = yield* workflowRepository;
  const page = yield* workflows.listTriggers({
    limit: 100,
    cursor: undefined,
    direction: "desc",
    workflowId: undefined,
    kind: undefined,
    on: undefined,
    eventKind: undefined,
    status: undefined,
  });
  return new Map(page.items.map((item) => [item.triggerId, item]));
});

/**
 * Saves a workflow with the triggers in `before`, then saves it again an hour
 * later with the triggers in `after`. The triggers listed in `pausedIds` are
 * paused between the two saves. Returns the trigger rows after the second
 * save, keyed by trigger id.
 */
const saveTwice = (
  before: ReadonlyArray<DeclaredTrigger>,
  after: ReadonlyArray<DeclaredTrigger>,
  pausedIds: ReadonlyArray<string> = [],
): Promise<ReadonlyMap<string, Trigger>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const workflows = yield* workflowRepository;
      const sql = yield* SqlClient.SqlClient;
      const workflowId = yield* storeWorkflow("Twice saved", before, FIRST_SAVE);
      for (const triggerId of pausedIds) {
        yield* sql`UPDATE triggers SET status = 'paused' WHERE trigger_id = ${triggerId}`;
      }
      yield* workflows.reconcileTriggers(workflowId, after, SECOND_SAVE);
      return yield* readTriggers;
    }).pipe(Effect.provide(TestDatabase), Effect.orDie),
  );

describe("saving a workflow's triggers a second time", () => {
  it("leaves the row of an unchanged trigger untouched", async () => {
    const triggers = await saveTwice([declareStartTrigger("a")], [declareStartTrigger("a")]);
    expect(triggers.get("a")).toMatchObject({ createdAt: FIRST_SAVE, updatedAt: FIRST_SAVE });
  });

  it("updates the fields and updated_at of a changed trigger, and keeps its created_at and status", async () => {
    const triggers = await saveTwice(
      [declareStartTrigger("a")],
      [declareStartTrigger("a", { on: { kind: "task.created", filter: "event.payload.id > 3" } })],
      ["a"],
    );
    expect(triggers.get("a")).toMatchObject({
      on: { kind: "task.created", filter: "event.payload.id > 3" },
      status: "paused",
      createdAt: FIRST_SAVE,
      updatedAt: SECOND_SAVE,
    });
  });

  it("gives a start trigger a status and a signal trigger no status", async () => {
    const triggers = await saveTwice(
      [],
      [
        declareStartTrigger("a"),
        declareStartTrigger("s", { kind: "signal", on: { kind: "task.updated" } }),
      ],
    );
    expect(triggers.get("a")?.status).toBe("active");
    expect(Object.keys(triggers.get("s") ?? {})).not.toContain("status");
  });

  it("replaces a trigger whose kind changed with a new row, even when its id is the same", async () => {
    const triggers = await saveTwice(
      [declareStartTrigger("a"), declareStartTrigger("s", { kind: "signal" })],
      [declareStartTrigger("a", { kind: "signal" }), declareStartTrigger("s")],
      ["a"],
    );
    // The paused start trigger became a signal trigger, which has no status.
    expect(triggers.get("a")).toMatchObject({ kind: "signal", createdAt: SECOND_SAVE });
    expect(Object.keys(triggers.get("a") ?? {})).not.toContain("status");
    // The signal trigger became a start trigger, which starts out active.
    expect(triggers.get("s")).toMatchObject({
      kind: "start",
      status: "active",
      createdAt: SECOND_SAVE,
    });
  });
});

describe("the trigger ids a second save returns", () => {
  it("are those it deleted and those whose kind changed, not those it kept or added", async () => {
    const ended = await Effect.runPromise(
      Effect.gen(function* () {
        const workflows = yield* workflowRepository;
        const workflowId = yield* storeWorkflow(
          "Twice saved",
          [
            declareStartTrigger("kept"),
            declareStartTrigger("dropped"),
            declareStartTrigger("flipped"),
          ],
          FIRST_SAVE,
        );
        return yield* workflows.reconcileTriggers(
          workflowId,
          [
            declareStartTrigger("kept", {
              on: { kind: "task.created", filter: "event.payload.id > 3" },
            }),
            declareStartTrigger("flipped", { kind: "signal" }),
            declareStartTrigger("added"),
          ],
          SECOND_SAVE,
        );
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );
    expect([...ended].sort()).toEqual(["dropped", "flipped"]);
  });
});

describe("listing triggers page by page", () => {
  it("returns each trigger once, in order, when a page ends among triggers with the same created_at", async () => {
    const { listed, workflowIds } = await Effect.runPromise(
      Effect.gen(function* () {
        const triggers = ["a", "b", "c"].map((triggerId) => declareStartTrigger(triggerId));
        const workflowIds = [
          yield* storeWorkflow("First", triggers, FIRST_SAVE),
          yield* storeWorkflow("Second", triggers, FIRST_SAVE),
        ];
        const workflows = yield* workflowRepository;
        const listed: Array<readonly [string, string]> = [];
        let cursor: string | undefined;
        do {
          const page = yield* workflows.listTriggers({
            limit: 2,
            cursor,
            direction: "desc",
            workflowId: undefined,
            kind: undefined,
            on: undefined,
            eventKind: undefined,
            status: undefined,
          });
          listed.push(...page.items.map((item) => [item.workflowId, item.triggerId] as const));
          cursor = page.nextCursor;
        } while (cursor !== undefined);
        return { listed, workflowIds };
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );

    // Workflow ids are canonical UUIDs of the same length, so comparing them as
    // strings gives the same order as the database. Joining each workflow id
    // and trigger id into one string then sorts the pairs like the list query.
    const expected = workflowIds
      .flatMap((workflowId) => ["a", "b", "c"].map((triggerId) => [workflowId, triggerId] as const))
      .sort((left, right) => (left.join(" ") < right.join(" ") ? 1 : -1));
    expect(listed).toEqual(expected);
  });
});

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(TestDatabase), Effect.orDie));

/** Enables a workflow, so its active start triggers can start runs. */
const enableWorkflow = (workflowId: string) =>
  Effect.flatMap(workflowRepository, (workflows) =>
    workflows.update(workflowId, { enabled: true }, FIRST_SAVE),
  );

/** Reads one trigger through the repository. Fails the test when the trigger is missing. */
const readStoredTrigger = (key: TriggerKey) =>
  Effect.map(
    Effect.flatMap(workflowRepository, (workflows) => workflows.readTrigger(key)),
    Option.getOrThrow,
  );

/** The columns of a trigger row that the Trigger read does not show, or shows reshaped. */
interface StoredTriggerColumns {
  readonly inputs: string | null;
  readonly next_fire_at: string | null;
  readonly next_fire_zone: string | null;
  readonly last_fired_at: string | null;
  readonly skipped_from: string | null;
  readonly skipped_until: string | null;
}

/** Reads the raw columns of one trigger row. */
const readTriggerColumns = (key: TriggerKey) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(
      sql<StoredTriggerColumns>`
        SELECT inputs, next_fire_at, next_fire_zone, last_fired_at, skipped_from, skipped_until
        FROM triggers
        WHERE workflow_id = ${uuidFromString(key.workflowId)}
          AND trigger_id = ${key.triggerId}`,
      (rows) => rows[0]!,
    ),
  );

describe("saving a start trigger's input mapping", () => {
  it("stores the mapping as JSON, and no mapping as NULL", async () => {
    const mapping = { title: "event.payload.title", number: "event.payload.number" };
    const columns = await run(
      Effect.gen(function* () {
        const workflowId = yield* storeWorkflow(
          "Mapped",
          [declareStartTrigger("mapped", { inputs: mapping }), declareStartTrigger("unmapped")],
          FIRST_SAVE,
        );
        return [
          yield* readTriggerColumns({ workflowId, triggerId: "mapped" }),
          yield* readTriggerColumns({ workflowId, triggerId: "unmapped" }),
        ];
      }),
    );

    expect(JSON.parse(columns[0]!.inputs!)).toEqual(mapping);
    expect(columns[1]!.inputs).toBeNull();
  });

  it("updates the mapping on a second save that changes it", async () => {
    const columns = await run(
      Effect.gen(function* () {
        const workflows = yield* workflowRepository;
        const workflowId = yield* storeWorkflow(
          "Mapped",
          [declareStartTrigger("a", { inputs: { title: "event.payload.title" } })],
          FIRST_SAVE,
        );
        yield* workflows.reconcileTriggers(
          workflowId,
          [declareStartTrigger("a", { inputs: { title: "event.payload.name" } })],
          SECOND_SAVE,
        );
        return yield* readTriggerColumns({ workflowId, triggerId: "a" });
      }),
    );

    expect(JSON.parse(columns.inputs!)).toEqual({ title: "event.payload.name" });
  });
});

describe("a start trigger's health across a second save", () => {
  /**
   * Saves a workflow with trigger `a`, records an evaluation failure on it,
   * saves the workflow again with `after`, and returns the trigger's health.
   */
  const readHealthAfterResave = (after: DeclaredTrigger) =>
    run(
      Effect.gen(function* () {
        const workflows = yield* workflowRepository;
        const workflowId = yield* storeWorkflow("Healthy", [declareStartTrigger("a")], FIRST_SAVE);
        yield* workflows.recordTriggerFailure(
          { workflowId, triggerId: "a" },
          "evaluation",
          "payload has no field title",
          FIRST_SAVE,
        );
        yield* workflows.reconcileTriggers(workflowId, [after], SECOND_SAVE);
        return (yield* readStoredTrigger({ workflowId, triggerId: "a" })).health;
      }),
    );

  it("is ok again after a save that changes the trigger, because the error was about the old trigger", async () => {
    expect(
      await readHealthAfterResave(
        declareStartTrigger("a", { on: { kind: "task.created", filter: "event.payload.id > 3" } }),
      ),
    ).toEqual({ state: "ok" });
  });

  it("keeps its error after a save that leaves the trigger as it was", async () => {
    expect(await readHealthAfterResave(declareStartTrigger("a"))).toEqual({
      state: "error",
      message: "payload has no field title",
      at: FIRST_SAVE,
    });
  });
});

describe("a cron trigger's schedule state across a second save", () => {
  const NEXT_FIRE = "2026-09-23T07:00:00.000Z";
  const FIRED = "2026-09-22T07:00:00.000Z";
  const SKIPPED = { from: "2026-09-20T07:00:00.000Z", until: "2026-09-21T07:00:00.000Z" };

  /**
   * Saves a workflow with the cron trigger `nightly`, records that it fired,
   * missed a stretch and has its next time computed, saves the workflow again
   * with `after`, and returns the trigger's raw columns.
   */
  const readScheduleStateAfterResave = (after: DeclaredTrigger) =>
    run(
      Effect.gen(function* () {
        const workflows = yield* workflowRepository;
        const workflowId = yield* storeWorkflow(
          "Nightly",
          [declareCronTrigger("nightly")],
          FIRST_SAVE,
        );
        yield* workflows.advanceCronTrigger(
          { workflowId, triggerId: "nightly" },
          { nextFireAt: NEXT_FIRE, zone: "Europe/Amsterdam", firedAt: FIRED, skipped: SKIPPED },
        );
        yield* workflows.reconcileTriggers(workflowId, [after], SECOND_SAVE);
        return yield* readTriggerColumns({ workflowId, triggerId: "nightly" });
      }),
    );

  const UNTOUCHED: StoredTriggerColumns = {
    inputs: null,
    next_fire_at: NEXT_FIRE,
    next_fire_zone: "Europe/Amsterdam",
    last_fired_at: FIRED,
    skipped_from: SKIPPED.from,
    skipped_until: SKIPPED.until,
  };

  it("keeps everything after a save that leaves the trigger as it was", async () => {
    expect(await readScheduleStateAfterResave(declareCronTrigger("nightly"))).toEqual(UNTOUCHED);
  });

  it("clears the next time, and keeps when it last fired and what it missed, after a save that changes the schedule", async () => {
    expect(
      await readScheduleStateAfterResave(
        declareCronTrigger("nightly", { schedule: "0 10 * * *", timezone: "Europe/Amsterdam" }),
      ),
    ).toEqual({ ...UNTOUCHED, next_fire_at: null, next_fire_zone: null });
  });

  it("clears the next time after a save that changes the timezone, or removes it", async () => {
    for (const on of [
      { schedule: "0 9 * * *", timezone: "Europe/London" },
      { schedule: "0 9 * * *" },
    ]) {
      expect(await readScheduleStateAfterResave(declareCronTrigger("nightly", on))).toEqual({
        ...UNTOUCHED,
        next_fire_at: null,
        next_fire_zone: null,
      });
    }
  });

  it("clears every part of the schedule state after a save that replaces the schedule with an event selector", async () => {
    expect(await readScheduleStateAfterResave(declareStartTrigger("nightly"))).toEqual({
      inputs: null,
      next_fire_at: null,
      next_fire_zone: null,
      last_fired_at: null,
      skipped_from: null,
      skipped_until: null,
    });
  });

  it("clears every part of the schedule state after a save that makes it a signal trigger", async () => {
    expect(
      await readScheduleStateAfterResave(declareStartTrigger("nightly", { kind: "signal" })),
    ).toEqual({
      inputs: null,
      next_fire_at: null,
      next_fire_zone: null,
      last_fired_at: null,
      skipped_from: null,
      skipped_until: null,
    });
  });
});

describe("recording a start trigger's failures", () => {
  it("turns the health to an error on the first failure at a stage and not on the next, and keeps the time the error began", async () => {
    const { first, second, health } = await run(
      Effect.gen(function* () {
        const workflows = yield* workflowRepository;
        const workflowId = yield* storeWorkflow("Failing", [declareStartTrigger("a")], FIRST_SAVE);
        const key = { workflowId, triggerId: "a" };
        const first = yield* workflows.recordTriggerFailure(
          key,
          "evaluation",
          "first error",
          FIRST_SAVE,
        );
        const second = yield* workflows.recordTriggerFailure(
          key,
          "evaluation",
          "second error",
          SECOND_SAVE,
        );
        return { first, second, health: (yield* readStoredTrigger(key)).health };
      }),
    );

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(health).toEqual({ state: "error", message: "second error", at: FIRST_SAVE });
  });

  it("turns the health to a new error when another stage fails, with the time of that failure", async () => {
    const { reported, health } = await run(
      Effect.gen(function* () {
        const workflows = yield* workflowRepository;
        const workflowId = yield* storeWorkflow("Failing", [declareStartTrigger("a")], FIRST_SAVE);
        const key = { workflowId, triggerId: "a" };
        yield* workflows.recordTriggerFailure(key, "evaluation", "bad filter", FIRST_SAVE);
        const reported = yield* workflows.recordTriggerFailure(key, "start", "no run", SECOND_SAVE);
        return { reported, health: (yield* readStoredTrigger(key)).health };
      }),
    );

    expect(reported).toBe(true);
    expect(health).toEqual({ state: "error", message: "no run", at: SECOND_SAVE });
  });

  it("clears an error only for the stage that recorded it", async () => {
    const { clearedByOther, healthAfterOther, clearedBySame, healthAfterSame } = await run(
      Effect.gen(function* () {
        const workflows = yield* workflowRepository;
        const workflowId = yield* storeWorkflow("Failing", [declareStartTrigger("a")], FIRST_SAVE);
        const key = { workflowId, triggerId: "a" };
        yield* workflows.recordTriggerFailure(key, "start", "no run", FIRST_SAVE);
        const clearedByOther = yield* workflows.clearTriggerFailure(key, "evaluation");
        const healthAfterOther = (yield* readStoredTrigger(key)).health;
        const clearedBySame = yield* workflows.clearTriggerFailure(key, "start");
        const healthAfterSame = (yield* readStoredTrigger(key)).health;
        return { clearedByOther, healthAfterOther, clearedBySame, healthAfterSame };
      }),
    );

    expect(clearedByOther).toBe(false);
    expect(healthAfterOther).toEqual({ state: "error", message: "no run", at: FIRST_SAVE });
    expect(clearedBySame).toBe(true);
    expect(healthAfterSame).toEqual({ state: "ok" });
  });

  it("turns the health to an error again after the error is cleared", async () => {
    const { reported, health } = await run(
      Effect.gen(function* () {
        const workflows = yield* workflowRepository;
        const workflowId = yield* storeWorkflow("Failing", [declareStartTrigger("a")], FIRST_SAVE);
        const key = { workflowId, triggerId: "a" };
        yield* workflows.recordTriggerFailure(key, "evaluation", "first error", FIRST_SAVE);
        yield* workflows.clearTriggerFailure(key, "evaluation");
        const reported = yield* workflows.recordTriggerFailure(
          key,
          "evaluation",
          "again",
          SECOND_SAVE,
        );
        return { reported, health: (yield* readStoredTrigger(key)).health };
      }),
    );

    expect(reported).toBe(true);
    expect(health).toEqual({ state: "error", message: "again", at: SECOND_SAVE });
  });
});

describe("listing the routable start triggers", () => {
  it("lists only the active start triggers of enabled workflows, with their selection and mapping", async () => {
    const { routable, enabledId } = await run(
      Effect.gen(function* () {
        const workflows = yield* workflowRepository;
        const enabledId = yield* storeWorkflow(
          "Enabled",
          [
            declareStartTrigger("active", {
              on: {
                kind: "task.created",
                connectionId: ANY_CONNECTION,
                filter: "event.payload.id > 3",
              },
              inputs: { id: "event.payload.id" },
            }),
            declareStartTrigger("unmapped"),
            declareStartTrigger("paused"),
            declareStartTrigger("signal", { kind: "signal" }),
          ],
          FIRST_SAVE,
        );
        yield* enableWorkflow(enabledId);
        yield* workflows.setTriggerStatus(
          { workflowId: enabledId, triggerId: "paused" },
          "paused",
          SECOND_SAVE,
        );
        yield* workflows.recordTriggerFailure(
          { workflowId: enabledId, triggerId: "unmapped" },
          "evaluation",
          "boom",
          SECOND_SAVE,
        );
        // A workflow is stored disabled, so this one's active trigger cannot start a run.
        yield* storeWorkflow("Disabled", [declareStartTrigger("of-disabled")], FIRST_SAVE);
        const routable = yield* workflows.listRoutableStartTriggers();
        return { routable, enabledId };
      }),
    );

    expect(
      [...routable].sort((left, right) => left.triggerId.localeCompare(right.triggerId)),
    ).toEqual([
      {
        workflowId: enabledId,
        triggerId: "active",
        eventKind: "task.created",
        connectionId: ANY_CONNECTION,
        filter: "event.payload.id > 3",
        inputs: { id: "event.payload.id" },
        hasEvaluationError: false,
      },
      {
        workflowId: enabledId,
        triggerId: "unmapped",
        eventKind: "task.created",
        connectionId: undefined,
        filter: undefined,
        inputs: {},
        hasEvaluationError: true,
      },
    ]);
  });
});

describe("checking that a start trigger is routable", () => {
  it("is true only for an active start trigger of an enabled workflow", async () => {
    const routable = await run(
      Effect.gen(function* () {
        const workflows = yield* workflowRepository;
        const enabledId = yield* storeWorkflow(
          "Enabled",
          [
            declareStartTrigger("active"),
            declareStartTrigger("paused"),
            declareStartTrigger("signal", { kind: "signal" }),
          ],
          FIRST_SAVE,
        );
        yield* enableWorkflow(enabledId);
        yield* workflows.setTriggerStatus(
          { workflowId: enabledId, triggerId: "paused" },
          "paused",
          SECOND_SAVE,
        );
        const disabledId = yield* storeWorkflow(
          "Disabled",
          [declareStartTrigger("of-disabled")],
          FIRST_SAVE,
        );
        const check = (workflowId: string, triggerId: string) =>
          workflows.isRoutableStartTrigger({ workflowId, triggerId });
        return {
          active: yield* check(enabledId, "active"),
          paused: yield* check(enabledId, "paused"),
          signal: yield* check(enabledId, "signal"),
          missing: yield* check(enabledId, "missing"),
          "of-disabled": yield* check(disabledId, "of-disabled"),
        };
      }),
    );

    expect(routable).toEqual({
      active: true,
      paused: false,
      signal: false,
      missing: false,
      "of-disabled": false,
    });
  });
});

describe("setting a trigger's status", () => {
  it("reports a change and moves updated_at, and reports no change when the status is already that value", async () => {
    const { paused, pausedAgain, trigger } = await run(
      Effect.gen(function* () {
        const workflows = yield* workflowRepository;
        const workflowId = yield* storeWorkflow("Toggled", [declareStartTrigger("a")], FIRST_SAVE);
        const key = { workflowId, triggerId: "a" };
        const paused = yield* workflows.setTriggerStatus(key, "paused", SECOND_SAVE);
        const pausedAgain = yield* workflows.setTriggerStatus(
          key,
          "paused",
          "2026-09-22T12:00:00.000Z",
        );
        return { paused, pausedAgain, trigger: yield* readStoredTrigger(key) };
      }),
    );

    expect(paused).toBe(true);
    expect(pausedAgain).toBe(false);
    expect(trigger).toMatchObject({ status: "paused", updatedAt: SECOND_SAVE });
  });

  it("never gives a signal trigger a status", async () => {
    const { changed, trigger } = await run(
      Effect.gen(function* () {
        const workflows = yield* workflowRepository;
        const workflowId = yield* storeWorkflow(
          "Signalled",
          [declareStartTrigger("s", { kind: "signal" })],
          FIRST_SAVE,
        );
        const key = { workflowId, triggerId: "s" };
        const changed = yield* workflows.setTriggerStatus(key, "paused", SECOND_SAVE);
        return { changed, trigger: yield* readStoredTrigger(key) };
      }),
    );

    expect(changed).toBe(false);
    expect(Object.keys(trigger)).not.toContain("status");
    expect(trigger.updatedAt).toBe(FIRST_SAVE);
  });
});

describe("listing the triggers that name a Connection", () => {
  const CONNECTION_ID = "0199e0e7-0000-7000-8000-00000000c001";
  const OTHER_CONNECTION_ID = "0199e0e7-0000-7000-8000-00000000c002";

  it("lists every trigger naming it, of any kind or status, by workflow name then trigger id", async () => {
    const { named, alphaId, betaId } = await run(
      Effect.gen(function* () {
        const workflows = yield* workflowRepository;
        // Stored first so that the order cannot come from insertion.
        const betaId = yield* storeWorkflow(
          "Beta",
          [
            declareStartTrigger("z", { on: { kind: "task.created", connectionId: CONNECTION_ID } }),
            declareStartTrigger("a", {
              kind: "signal",
              on: { kind: "task.created", connectionId: CONNECTION_ID },
            }),
            declareStartTrigger("any", {
              on: { kind: "task.created", connectionId: ANY_CONNECTION },
            }),
          ],
          FIRST_SAVE,
        );
        const alphaId = yield* storeWorkflow(
          "Alpha",
          [
            declareStartTrigger("m", { on: { kind: "task.created", connectionId: CONNECTION_ID } }),
            declareStartTrigger("other", {
              on: { kind: "task.created", connectionId: OTHER_CONNECTION_ID },
            }),
            declareStartTrigger("none"),
          ],
          FIRST_SAVE,
        );
        yield* workflows.setTriggerStatus(
          { workflowId: alphaId, triggerId: "m" },
          "paused",
          SECOND_SAVE,
        );
        const named = yield* workflows.listTriggersNamingConnection(CONNECTION_ID);
        return { named, alphaId, betaId };
      }),
    );

    expect(named).toEqual([
      { workflowId: alphaId, workflowName: "Alpha", triggerId: "m" },
      { workflowId: betaId, workflowName: "Beta", triggerId: "a" },
      { workflowId: betaId, workflowName: "Beta", triggerId: "z" },
    ]);
  });
});

describe("listing the cron triggers to schedule", () => {
  const NOW = "2026-09-22T12:00:00.000Z";
  const PAST = "2026-09-22T11:59:00.000Z";
  const FUTURE = "2026-09-23T07:00:00.000Z";

  /**
   * Stores one workflow with a cron trigger per case, gives each the next
   * time and zone its case needs, and returns the ids listed at `NOW` for a
   * user in Amsterdam.
   */
  const listScheduledIds = () =>
    run(
      Effect.gen(function* () {
        const workflows = yield* workflowRepository;
        const workflowId = yield* storeWorkflow(
          "Scheduled",
          [
            declareCronTrigger("fresh"),
            declareCronTrigger("due"),
            declareCronTrigger("due-now"),
            declareCronTrigger("future-own-zone"),
            declareCronTrigger("future-user-zone", { schedule: "0 9 * * *" }),
            declareCronTrigger("future-stale-user-zone", { schedule: "0 9 * * *" }),
            // Not cron triggers: they have event selectors.
            declareStartTrigger("not-cron"),
            declareStartTrigger("signal", { kind: "signal" }),
          ],
          FIRST_SAVE,
        );
        const advance = (triggerId: string, nextFireAt: string, zone: string) =>
          workflows.advanceCronTrigger({ workflowId, triggerId }, { nextFireAt, zone });
        yield* advance("due", PAST, "Europe/Amsterdam");
        yield* advance("due-now", NOW, "Europe/Amsterdam");
        // An own timezone other than the user's does not make it stale.
        yield* advance("future-own-zone", FUTURE, "Europe/Amsterdam");
        yield* advance("future-user-zone", FUTURE, "America/New_York");
        yield* advance("future-stale-user-zone", FUTURE, "Europe/Amsterdam");
        const listed = yield* workflows.listCronTriggersToSchedule(NOW, "America/New_York");
        return listed.map((key) => key.triggerId).sort();
      }),
    );

  it("lists the triggers with no next time, the due ones, and the ones computed in a timezone the user no longer has", async () => {
    expect(await listScheduledIds()).toEqual(["due", "due-now", "fresh", "future-stale-user-zone"]);
  });

  it("says a cron trigger can fire only when it is active and its workflow is enabled", async () => {
    const canFire = await run(
      Effect.gen(function* () {
        const workflows = yield* workflowRepository;
        const enabledId = yield* storeWorkflow(
          "Enabled",
          [declareCronTrigger("active"), declareCronTrigger("paused")],
          FIRST_SAVE,
        );
        yield* enableWorkflow(enabledId);
        yield* workflows.setTriggerStatus(
          { workflowId: enabledId, triggerId: "paused" },
          "paused",
          SECOND_SAVE,
        );
        const disabledId = yield* storeWorkflow(
          "Disabled",
          [declareCronTrigger("of-disabled")],
          FIRST_SAVE,
        );
        const readCanFire = (workflowId: string, triggerId: string) =>
          Effect.map(workflows.readCronTrigger({ workflowId, triggerId }), (trigger) =>
            Option.map(trigger, (found) => found.canFire),
          );
        return {
          active: yield* readCanFire(enabledId, "active"),
          paused: yield* readCanFire(enabledId, "paused"),
          "of-disabled": yield* readCanFire(disabledId, "of-disabled"),
        };
      }),
    );

    expect(canFire).toEqual({
      active: Option.some(true),
      paused: Option.some(false),
      "of-disabled": Option.some(false),
    });
  });

  it("reads a cron trigger's schedule, its own timezone, and the Scheduler's state for it", async () => {
    const { read, workflowId } = await run(
      Effect.gen(function* () {
        const workflows = yield* workflowRepository;
        const workflowId = yield* storeWorkflow(
          "Scheduled",
          [declareCronTrigger("due")],
          FIRST_SAVE,
        );
        yield* workflows.advanceCronTrigger(
          { workflowId, triggerId: "due" },
          { nextFireAt: PAST, zone: "Europe/Amsterdam", firedAt: "2026-09-21T07:00:00.000Z" },
        );
        return {
          read: yield* workflows.readCronTrigger({ workflowId, triggerId: "due" }),
          workflowId,
        };
      }),
    );

    expect(read).toEqual(
      Option.some({
        workflowId,
        triggerId: "due",
        schedule: "0 9 * * *",
        timezone: "Europe/Amsterdam",
        canFire: false,
        nextFireAt: PAST,
        nextFireZone: "Europe/Amsterdam",
        lastFiredAt: "2026-09-21T07:00:00.000Z",
      }),
    );
  });

  it("reads nothing for a trigger that is not a cron trigger, or does not exist", async () => {
    const { notCron, missing } = await run(
      Effect.gen(function* () {
        const workflows = yield* workflowRepository;
        const workflowId = yield* storeWorkflow(
          "Scheduled",
          [declareStartTrigger("not-cron")],
          FIRST_SAVE,
        );
        return {
          notCron: yield* workflows.readCronTrigger({ workflowId, triggerId: "not-cron" }),
          missing: yield* workflows.readCronTrigger({ workflowId, triggerId: "missing" }),
        };
      }),
    );

    expect(notCron).toEqual(Option.none());
    expect(missing).toEqual(Option.none());
  });
});

describe("moving a cron trigger on to its next scheduled time", () => {
  it("always writes the next time and zone, when it fired only when it fired, and a skipped stretch only when one is given", async () => {
    const { computed, fired, skipped, movedOn, columns, listed } = await run(
      Effect.gen(function* () {
        const workflows = yield* workflowRepository;
        const workflowId = yield* storeWorkflow(
          "Nightly",
          [declareCronTrigger("nightly")],
          FIRST_SAVE,
        );
        const key = { workflowId, triggerId: "nightly" };
        yield* workflows.advanceCronTrigger(key, {
          nextFireAt: "2026-09-23T07:00:00.000Z",
          zone: "Europe/Amsterdam",
        });
        const computed = yield* readStoredTrigger(key);
        yield* workflows.advanceCronTrigger(key, {
          nextFireAt: "2026-09-24T07:00:00.000Z",
          zone: "Europe/Amsterdam",
          firedAt: "2026-09-23T07:00:00.000Z",
        });
        const fired = yield* readStoredTrigger(key);
        yield* workflows.advanceCronTrigger(key, {
          nextFireAt: "2026-09-27T07:00:00.000Z",
          zone: "Europe/Amsterdam",
          skipped: { from: "2026-09-24T07:00:00.000Z", until: "2026-09-26T07:00:00.000Z" },
        });
        const skipped = yield* readStoredTrigger(key);
        yield* workflows.advanceCronTrigger(key, {
          nextFireAt: "2026-09-28T07:00:00.000Z",
          zone: "Europe/London",
        });
        const movedOn = yield* readStoredTrigger(key);
        const columns = yield* readTriggerColumns(key);
        const page = yield* workflows.listTriggers({
          limit: 10,
          cursor: undefined,
          direction: "desc",
          workflowId,
          kind: undefined,
          on: undefined,
          eventKind: undefined,
          status: undefined,
        });
        return { computed, fired, skipped, movedOn, columns, listed: page.items[0] };
      }),
    );

    expect(computed).toMatchObject({ nextFireAt: "2026-09-23T07:00:00.000Z" });
    expect(Object.keys(computed)).not.toContain("lastFiredAt");
    expect(Object.keys(computed)).not.toContain("skippedTicks");

    expect(fired).toMatchObject({
      nextFireAt: "2026-09-24T07:00:00.000Z",
      lastFiredAt: "2026-09-23T07:00:00.000Z",
    });
    expect(Object.keys(fired)).not.toContain("skippedTicks");

    expect(skipped).toMatchObject({
      nextFireAt: "2026-09-27T07:00:00.000Z",
      lastFiredAt: "2026-09-23T07:00:00.000Z",
      skippedTicks: { from: "2026-09-24T07:00:00.000Z", until: "2026-09-26T07:00:00.000Z" },
    });

    // A move with neither leaves both as they were.
    expect(movedOn).toMatchObject({
      nextFireAt: "2026-09-28T07:00:00.000Z",
      lastFiredAt: "2026-09-23T07:00:00.000Z",
      skippedTicks: { from: "2026-09-24T07:00:00.000Z", until: "2026-09-26T07:00:00.000Z" },
      health: { state: "ok" },
    });
    expect(columns.next_fire_zone).toBe("Europe/London");
    // The list and the single read show the same trigger.
    expect(listed).toEqual(movedOn);
  });
});

describe("reading a trigger", () => {
  it("gives a start trigger a health and a signal trigger none, and leaves out the schedule state it does not have", async () => {
    const { start, signal } = await run(
      Effect.gen(function* () {
        const workflowId = yield* storeWorkflow(
          "Read",
          [declareStartTrigger("start"), declareStartTrigger("signal", { kind: "signal" })],
          FIRST_SAVE,
        );
        return {
          start: yield* readStoredTrigger({ workflowId, triggerId: "start" }),
          signal: yield* readStoredTrigger({ workflowId, triggerId: "signal" }),
        };
      }),
    );

    expect(start.health).toEqual({ state: "ok" });
    expect(Object.keys(signal)).not.toContain("health");
    for (const trigger of [start, signal]) {
      for (const field of ["nextFireAt", "lastFiredAt", "skippedTicks"]) {
        expect(Object.keys(trigger)).not.toContain(field);
      }
    }
  });

  it("reads a cron trigger's on as its schedule, and any other trigger's as its event selector", async () => {
    const triggers = await saveTwice(
      [],
      [
        declareCronTrigger("nightly"),
        declareCronTrigger("user-zone", { schedule: "0 9 * * *" }),
        declareStartTrigger("events", {
          on: {
            kind: "task.created",
            connectionId: ANY_CONNECTION,
            filter: "event.payload.id > 3",
          },
        }),
        declareStartTrigger("signal", { kind: "signal", on: { kind: "task.updated" } }),
      ],
    );

    expect(triggers.get("nightly")?.on).toEqual({
      schedule: "0 9 * * *",
      timezone: "Europe/Amsterdam",
    });
    expect(triggers.get("user-zone")?.on).toEqual({ schedule: "0 9 * * *" });
    expect(triggers.get("events")?.on).toEqual({
      kind: "task.created",
      connectionId: ANY_CONNECTION,
      filter: "event.payload.id > 3",
    });
    expect(triggers.get("signal")?.on).toEqual({ kind: "task.updated" });
  });

  it("reads nothing for a trigger id its workflow does not declare", async () => {
    const found = await run(
      Effect.gen(function* () {
        const workflows = yield* workflowRepository;
        const workflowId = yield* storeWorkflow("Read", [declareStartTrigger("a")], FIRST_SAVE);
        return yield* workflows.readTrigger({ workflowId, triggerId: "absent" });
      }),
    );

    expect(Option.isNone(found)).toBe(true);
  });
});

describe("listing triggers by what they fire on", () => {
  /** Lists the ids of the triggers that pass `filter`, sorted. */
  const listTriggerIds = (filter: {
    readonly on?: "event" | "schedule";
    readonly eventKind?: string;
  }) =>
    Effect.gen(function* () {
      const workflows = yield* workflowRepository;
      const page = yield* workflows.listTriggers({
        limit: 100,
        cursor: undefined,
        direction: "desc",
        workflowId: undefined,
        kind: undefined,
        on: filter.on,
        eventKind: filter.eventKind,
        status: undefined,
      });
      return page.items.map((item) => item.triggerId).sort();
    });

  it("lists the cron triggers for on schedule, the others for on event, and no cron trigger for an event kind", async () => {
    const listed = await run(
      Effect.gen(function* () {
        yield* storeWorkflow(
          "Mixed",
          [
            declareCronTrigger("nightly"),
            declareStartTrigger("created"),
            declareStartTrigger("signal", { kind: "signal", on: { kind: "task.updated" } }),
          ],
          FIRST_SAVE,
        );
        return {
          schedule: yield* listTriggerIds({ on: "schedule" }),
          event: yield* listTriggerIds({ on: "event" }),
          cronTick: yield* listTriggerIds({ eventKind: "cron.tick" }),
          created: yield* listTriggerIds({ eventKind: "task.created" }),
        };
      }),
    );

    expect(listed).toEqual({
      schedule: ["nightly"],
      event: ["created", "signal"],
      cronTick: [],
      created: ["created"],
    });
  });
});
