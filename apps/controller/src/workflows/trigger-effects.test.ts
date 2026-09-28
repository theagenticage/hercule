/**
 * Tests the `trigger_effects` repository: a start trigger's match on an event
 * is written once, waits as `pending` in the order it was written, and stops
 * being pending once its run starts or it is discarded.
 */
import { describe, expect, it } from "vitest";
import { Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestDatabase } from "../db/testing";
import { workflowRepository, type DeclaredTrigger } from "./repository";
import { triggerEffectRepository } from "./trigger-effects";

const SAVED_AT = "2026-09-22T10:00:00.000Z";
const MATCHED_AT = "2026-09-22T10:05:00.000Z";
const SPAWNED_AT = "2026-09-22T10:05:01.000Z";
const RUN_ID = "0199e0e7-0000-7000-8000-00000000e001";

/** Returns a start trigger on `task.created` with no filter and no mapping. */
const declareTrigger = (triggerId: string): DeclaredTrigger => ({
  triggerId,
  kind: "start",
  eventKind: "task.created",
  connectionId: undefined,
  filter: undefined,
  schedule: undefined,
  timezone: undefined,
  inputs: undefined,
});

/** Inserts a workflow with start triggers `a` and `b`. Returns the workflow id. */
const storeWorkflow = Effect.gen(function* () {
  const workflows = yield* workflowRepository;
  const stored = yield* workflows.insert(
    { source: "name: Routed\nsteps: []\n", definition: { name: "Routed", steps: [] } },
    SAVED_AT,
  );
  yield* workflows.reconcileTriggers(
    stored.id,
    [declareTrigger("a"), declareTrigger("b")],
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
          at: MATCHED_AT,
        });
        yield* effects.insertPending({
          workflowId,
          triggerId: "a",
          eventId: 7,
          inputs: { title: "second" },
          at: MATCHED_AT,
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
            at: MATCHED_AT,
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
            at: MATCHED_AT,
          });
        }
        const written = yield* effects.listPendingIds();
        yield* effects.markSpawned(written[0]!, RUN_ID, SPAWNED_AT);
        yield* effects.markDiscarded(written[2]!, SPAWNED_AT);
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
          at: MATCHED_AT,
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
            at: MATCHED_AT,
          });
        }
        const [spawned, discarded] = yield* effects.listPendingIds();
        yield* effects.markSpawned(spawned!, RUN_ID, SPAWNED_AT);
        yield* effects.markDiscarded(discarded!, SPAWNED_AT);
        return [
          yield* effects.readPending(spawned!),
          yield* effects.readPending(discarded!),
          yield* effects.readPending(999),
        ];
      }),
    );

    for (const read of reads) expect(Option.isNone(read)).toBe(true);
  });

  it("records the run a spawned effect started, and when", async () => {
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
          at: MATCHED_AT,
        });
        const [id] = yield* effects.listPendingIds();
        yield* effects.markSpawned(id!, RUN_ID, SPAWNED_AT);
        return yield* sql<{ readonly state: string; readonly run_id: string; readonly at: string }>`
          SELECT state, lower(hex(run_id)) AS run_id, at FROM trigger_effects`;
      }),
    );

    expect(rows).toEqual([
      { state: "spawned", run_id: RUN_ID.replaceAll("-", ""), at: SPAWNED_AT },
    ]);
  });
});
