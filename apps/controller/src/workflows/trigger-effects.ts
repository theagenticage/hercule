/**
 * Reads and writes the `trigger_effects` table: one row per start trigger
 * that matched an event.
 *
 * The event router writes a row as `pending`, in the transaction that matched
 * the event, with the inputs the trigger mapped from it. The delivery that
 * starts runs later moves the row to `spawned`, with the id of the run it
 * started, or to `discarded` when the run can never start. Routing and
 * starting are two steps so that a pass of the router only writes rows, and
 * a run starts in its own transaction.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Event, TriggerKey } from "@hercule/contract";
import { nowIso, uuidFromString, uuidToString } from "../db";
import { evaluateMapping, type ExpressionError } from "../expressions";
import type { RoutableStartTrigger } from "./repository";

/** A start trigger's match on one event, waiting for its run to start. */
export interface PendingTriggerEffect extends TriggerKey {
  readonly id: number;
  readonly eventId: number;
  /** The inputs the trigger mapped from the event, not yet checked against the workflow. */
  readonly inputs: Record<string, unknown>;
}

interface PendingRow {
  readonly id: number;
  readonly workflow_id: Uint8Array;
  readonly trigger_id: string;
  readonly event_id: number;
  readonly inputs: string;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /**
     * Writes a pending row for a trigger's match on an event. A trigger that
     * already has a row for the event writes nothing, so routing one event
     * twice starts one run and not two.
     */
    insertPending: (
      match: TriggerKey & {
        readonly eventId: number;
        readonly inputs: Record<string, unknown>;
        readonly at: string;
      },
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        INSERT INTO trigger_effects (workflow_id, trigger_id, event_id, state, inputs, at)
        VALUES (${uuidFromString(match.workflowId)}, ${match.triggerId}, ${match.eventId},
                'pending', ${JSON.stringify(match.inputs)}, ${match.at})
        ON CONFLICT (workflow_id, trigger_id, event_id) DO NOTHING
      `),

    /** Returns the ids of the pending rows, in the order the rows were written. */
    listPendingIds: (): Effect.Effect<ReadonlyArray<number>, SqlError> =>
      Effect.map(
        sql<{ readonly id: number }>`
          SELECT id FROM trigger_effects WHERE state = 'pending' ORDER BY id
        `,
        (rows) => rows.map((row) => row.id),
      ),

    /** Returns a row if it is still pending, or `None` if it is gone or no longer pending. */
    readPending: (id: number): Effect.Effect<Option.Option<PendingTriggerEffect>, SqlError> =>
      Effect.map(
        sql<PendingRow>`
          SELECT id, workflow_id, trigger_id, event_id, inputs FROM trigger_effects
          WHERE id = ${id} AND state = 'pending'
        `,
        (rows) =>
          Option.map(Option.fromNullishOr(rows[0]), (row) => ({
            id: row.id,
            workflowId: uuidToString(row.workflow_id),
            triggerId: row.trigger_id,
            eventId: row.event_id,
            inputs: JSON.parse(row.inputs) as Record<string, unknown>,
          })),
      ),

    /** Moves a pending row to `spawned`, with the run it started. */
    markSpawned: (id: number, runId: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE trigger_effects SET state = 'spawned', run_id = ${uuidFromString(runId)}, at = ${at}
        WHERE id = ${id}
      `),

    /**
     * Moves a row to `discarded` if it is still pending, and returns its
     * trigger and event. Returns `None`, changing nothing, when the row is
     * gone or no longer pending. Unlike `readPending`, it does not read the
     * row's inputs, so it works on a row whose inputs cannot be parsed.
     */
    discardIfPending: (
      id: number,
      at: string,
    ): Effect.Effect<Option.Option<TriggerKey & { readonly eventId: number }>, SqlError> =>
      Effect.map(
        sql<Pick<PendingRow, "workflow_id" | "trigger_id" | "event_id">>`
          UPDATE trigger_effects SET state = 'discarded', at = ${at}
          WHERE id = ${id} AND state = 'pending'
          RETURNING workflow_id, trigger_id, event_id
        `,
        (rows) =>
          Option.map(Option.fromNullishOr(rows[0]), (row) => ({
            workflowId: uuidToString(row.workflow_id),
            triggerId: row.trigger_id,
            eventId: row.event_id,
          })),
      ),

    /** Moves a pending row to `discarded`: its run will never start. */
    markDiscarded: (id: number, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE trigger_effects SET state = 'discarded', at = ${at} WHERE id = ${id}
      `),
  };
});

/** The repository of the `trigger_effects` table. */
export const triggerEffectRepository = make;

/**
 * Records that a start trigger matched `event`: maps the event onto the
 * workflow's inputs with the trigger's input mapping, evaluated against
 * `context`, and writes a pending trigger effect for the delivery to start.
 * Fails with `ExpressionError`, writing nothing, when an input's expression
 * fails on the event. Joins the caller's transaction.
 *
 * The inputs are not checked against the workflow here: the run's start
 * checks them, and a run whose inputs do not validate fails where the user
 * can see it.
 */
export const recordTriggerMatch = (
  trigger: RoutableStartTrigger,
  event: Event,
  context: Record<string, unknown>,
): Effect.Effect<void, ExpressionError | SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const inputs = yield* evaluateMapping(trigger.inputs, context);
    const triggerEffects = yield* triggerEffectRepository;
    yield* triggerEffects.insertPending({
      workflowId: trigger.workflowId,
      triggerId: trigger.triggerId,
      eventId: event.id,
      inputs,
      at: yield* nowIso,
    });
  });
