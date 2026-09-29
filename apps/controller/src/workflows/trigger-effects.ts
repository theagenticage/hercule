/**
 * Trigger effects: one row per start trigger that matched an event, from the
 * match to the run it started.
 *
 * The event router records a match as `pending`, in the transaction that
 * matched the event, with the inputs the trigger mapped from it. The delivery
 * later starts the match's run, each in its own transaction, and moves the
 * row to `spawned` with the id of that run, or to `discarded` when the run
 * can never start. Routing and starting are two steps so that a pass of the
 * router only writes rows and never waits on a run.
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { isSqlError, type SqlError } from "effect/unstable/sql/SqlError";
import type { Event, TriggerKey } from "@hercule/contract";
import { commitUninterruptibly, nowIso, uuidFromString, uuidToString } from "../db";
import { readPipelineEvent } from "../events";
import { evaluateMapping, type EvaluationContext, type ExpressionError } from "../expressions";
import { workflowRepository, type RoutableStartTrigger } from "./repository";
import { TriggeredRuns } from "./runs";
import { TriggerHealth } from "./trigger-health";

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

/** The repository of the `trigger_effects` table. */
export const triggerEffectRepository = Effect.gen(function* () {
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
        readonly matchedAt: string;
      },
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        INSERT INTO trigger_effects (workflow_id, trigger_id, event_id, state, inputs, matched_at)
        VALUES (${uuidFromString(match.workflowId)}, ${match.triggerId}, ${match.eventId},
                'pending', ${JSON.stringify(match.inputs)}, ${match.matchedAt})
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
    markSpawned: (id: number, runId: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE trigger_effects SET state = 'spawned', run_id = ${uuidFromString(runId)}
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
    ): Effect.Effect<Option.Option<TriggerKey & { readonly eventId: number }>, SqlError> =>
      Effect.map(
        sql<Pick<PendingRow, "workflow_id" | "trigger_id" | "event_id">>`
          UPDATE trigger_effects SET state = 'discarded'
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
  };
});

/**
 * Returns why a run could not start, for the trigger's health: the database
 * refused it, or anything else went wrong, which is a bug in the controller.
 */
const describeStartFailure = (eventId: number, failure: unknown): string => {
  const reason = isSqlError(failure)
    ? `because the database refused it: ${failure.message}`
    : `because of a bug in the controller: ${failure instanceof Error ? failure.message : String(failure)}`;
  return `The run for the event ${String(eventId)} could not start, ${reason}. The match was dropped, and the controller's log has the details.`;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const effects = yield* triggerEffectRepository;
  const workflows = yield* workflowRepository;
  const health = yield* TriggerHealth;
  const triggeredRuns = yield* TriggeredRuns;

  /**
   * Starts the run of one pending trigger effect and marks the effect
   * spawned, in one transaction, as `startRun` describes. Discards an effect
   * whose run can no longer start, and logs why.
   */
  const startPendingRun = (effectId: number): Effect.Effect<void, SqlError> =>
    commitUninterruptibly(
      sql,
      Effect.gen(function* () {
        const pending = yield* effects.readPending(effectId);
        if (Option.isNone(pending)) return;
        const effect = pending.value;
        const triggerDescription = `The trigger ${effect.triggerId} of the workflow ${effect.workflowId}`;
        if (!(yield* workflows.isRoutableStartTrigger(effect))) {
          yield* Effect.logInfo(
            `${triggerDescription} starts no run for the event ${String(effect.eventId)}, because it was paused, or its workflow disabled, after the event matched.`,
          );
          return yield* Effect.asVoid(effects.discardIfPending(effect.id));
        }
        const event = yield* readPipelineEvent(sql, effect.eventId);
        if (Option.isNone(event)) {
          // Only retention deletes an event, and only one far older than any
          // effect waits. Starting the run without its event would lose what
          // started it, so the match is dropped.
          yield* Effect.logWarning(
            `${triggerDescription} starts no run for the event ${String(effect.eventId)}, because the event is no longer in the log.`,
          );
          return yield* Effect.asVoid(effects.discardIfPending(effect.id));
        }
        const runId = yield* triggeredRuns.start(effect, event.value, yield* nowIso);
        yield* effects.markSpawned(effect.id, runId);
        yield* health.clearFailure(effect, "start");
      }),
    );

  /**
   * Discards a pending trigger effect whose start failed with `failure`, and
   * records the failure on its trigger's health, in a transaction of its own.
   * Once that commits, logs `cause` in full; the health gets a one-line
   * message. An effect that is no longer pending is left alone.
   */
  const discardAfterFailure = (
    effectId: number,
    cause: Cause.Cause<SqlError>,
    failure: unknown,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const discarded = yield* commitUninterruptibly(
        sql,
        Effect.tap(effects.discardIfPending(effectId), (found) =>
          Option.isNone(found)
            ? Effect.void
            : health.recordFailure(
                found.value,
                "start",
                describeStartFailure(found.value.eventId, failure),
              ),
        ),
      );
      if (Option.isNone(discarded)) return;
      yield* Effect.logError(
        `Starting the run of the trigger effect ${String(effectId)} failed, so it is discarded`,
        cause,
      );
    });

  return {
    /**
     * Records that a start trigger matched `event`: maps the event onto the
     * workflow's inputs with the trigger's input mapping, evaluated against
     * `context`, and writes a pending trigger effect for the delivery to
     * start. Fails with `ExpressionError`, writing nothing, when an input's
     * expression fails on the event. Joins the caller's transaction.
     *
     * The inputs are not checked against the workflow here: the run's start
     * checks them, and a run whose inputs do not validate fails where the
     * user can see it.
     */
    recordMatch: (
      trigger: RoutableStartTrigger,
      event: Event,
      context: EvaluationContext,
    ): Effect.Effect<void, ExpressionError | SqlError> =>
      Effect.gen(function* () {
        yield* effects.insertPending({
          workflowId: trigger.workflowId,
          triggerId: trigger.triggerId,
          eventId: event.id,
          inputs: yield* evaluateMapping(trigger.inputs, context),
          matchedAt: yield* nowIso,
        });
      }),

    /** Returns the ids of the trigger effects waiting for their run, oldest first. */
    listPendingIds: effects.listPendingIds,

    /**
     * Starts the run of one pending trigger effect, and marks the effect
     * spawned, in one transaction. So a run starts exactly once per match: a
     * crash before the commit leaves the effect pending and no run, and after
     * it the effect is no longer pending. A started run clears an error the
     * trigger's health recorded at the start stage.
     *
     * The effect is read again inside the transaction, because it may have
     * been started, or deleted with its trigger, since it was listed. An
     * effect whose run can no longer start is discarded, and the log says
     * why:
     *
     * - its trigger was paused, or its workflow disabled, since the match;
     * - its event is no longer in the log.
     *
     * When the start fails, what happens depends on whether a later try can
     * succeed:
     *
     * - a database that is busy or cannot be opened (an `SqlError` whose
     *   `isRetryable` is true) may work on the next try. `startRun` fails
     *   with that `SqlError`, and the effect stays pending for the next
     *   delivery.
     * - any other failure, a constraint the database refused or a bug in the
     *   controller, would fail the same way on every try. The effect is
     *   discarded, and the failure recorded on its trigger's health.
     */
    startRun: (effectId: number): Effect.Effect<void, SqlError> =>
      Effect.catchCause(startPendingRun(effectId), (cause) => {
        if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
        // A failed commit is a defect whose value is the `SqlError`, so the
        // error is read from the cause, whichever way it failed.
        const failure = Cause.squash(cause);
        return isSqlError(failure) && failure.isRetryable
          ? Effect.failCause(cause)
          : discardAfterFailure(effectId, cause, failure);
      }),
  };
});

/**
 * The lifecycle of start trigger matches: recording a match, and starting its
 * run. The event router records; the controller daemon's delivery starts.
 */
export class TriggerEffects extends Context.Service<TriggerEffects, Effect.Success<typeof make>>()(
  "hercule/controller/workflows/TriggerEffects",
) {}

export const TriggerEffectsLayer: Layer.Layer<
  TriggerEffects,
  never,
  SqlClient.SqlClient | TriggerHealth | TriggeredRuns
> = Layer.effect(TriggerEffects)(make);
