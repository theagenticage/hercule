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
 *
 * Every start trigger runs under a spawn bound: at most `maxRuns` runs in any
 * `windowSeconds` (spec 10 section 5). The runs a trigger used in its window
 * are its rows spawned within the window, plus its pending rows, which will
 * each start one. A match that would go over the bound trips the breaker:
 *
 * - the trigger is paused by the breaker, and the match is written `held`;
 * - one `core.breaker-tripped` decision asks the user to resume it;
 * - the event router still matches events against the trigger, and writes
 *   each match `held`, so no event it matched is lost.
 *
 * A trigger paused manually keeps the events it matched as held events too,
 * but matches no new ones until it is resumed.
 *
 * The delivery checks the bound once more as it starts each run, and sends a
 * pending row back to `held` when the window has no room, because a save may
 * have lowered the bound since the row was written.
 *
 * Once the trigger is resumed, its held events become `pending`, oldest
 * first, as the window has room. New matches queue behind them as `held`, so
 * the events still start runs in the order they arrived. Moving held events
 * to `pending` never trips the breaker: the user already decided to let them
 * run. But when the held events grow by more than `maxRuns` beyond their
 * count at the resume, a new match trips the breaker again, because the
 * trigger matches events faster than its bound lets it start runs.
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { isSqlError, type SqlError } from "effect/unstable/sql/SqlError";
import {
  describeSpawnBound,
  type Event,
  type SpawnBound,
  type TriggerKey,
  type TriggerPausedBy,
} from "@hercule/contract";
import { SYSTEM_ACTOR } from "../actor";
import { announce, nowIso, uuidFromString, uuidToString, withTransaction } from "../db";
import { AuditLog, readPipelineEvent } from "../events";
import { evaluateMapping, type EvaluationContext, type ExpressionError } from "../expressions";
import { formatInlineCode, Notifier } from "../notifications";
import { Settings } from "../settings";
import {
  IS_PROMOTABLE_START_TRIGGER,
  workflowRepository,
  type RoutableStartTrigger,
} from "./repository";
import { TriggeredRuns } from "./runs";
import {
  buildMaxRuns,
  buildRunsInWindow,
  buildRunsStartedInWindow,
  HELD_COUNT,
  HOLDS_EVENTS,
  readDefaultSpawnBound,
} from "./spawn-bounds";
import { TriggerHealth } from "./trigger-health";

/** The id of the breaker decision's answer that resumes the trigger and keeps its held events. */
export const RESUME_ACTION_ID = "resume";

/** The id of the breaker decision's answer that resumes the trigger and discards its held events. */
export const RESUME_AND_DISCARD_ACTION_ID = "resume-discard";

/** A start trigger's match on one event, waiting for its run to start. */
export interface PendingTriggerEffect extends TriggerKey {
  readonly id: number;
  readonly eventId: number;
  /** The inputs the trigger mapped from the event, not yet checked against the workflow. */
  readonly inputs: Record<string, unknown>;
}

/** A start trigger's match on one event, as the event router writes it. */
interface TriggerMatch extends TriggerKey {
  readonly eventId: number;
  readonly inputs: Record<string, unknown>;
  readonly matchedAt: string;
}

/**
 * What decides how a start trigger's next match is written: who paused the
 * trigger, if anyone, and two answers read only while the trigger is
 * active, each `undefined` when it does not apply:
 *
 * - `hasRoom`, for a trigger that holds no events: whether its window has
 *   room for one more run. Only such a trigger writes a match `pending`; the
 *   match of a trigger that holds events queues behind them;
 * - `heldReachedLimit`, for a trigger that holds events: whether it holds
 *   `maxRuns` more than it did when it was last resumed, so one more trips
 *   the breaker. `undefined` too for a trigger never resumed.
 */
interface SpawnState {
  readonly pausedBy: TriggerPausedBy | undefined;
  readonly hasRoom: boolean | undefined;
  readonly heldReachedLimit: boolean | undefined;
}

interface PendingRow {
  readonly id: number;
  readonly workflow_id: Uint8Array;
  readonly trigger_id: string;
  readonly event_id: number;
  readonly inputs: string;
}

/** Converts an SQLite truth value, which may be NULL, to a boolean or `undefined`. */
const readTruth = (value: number | null): boolean | undefined =>
  value === null ? undefined : value === 1;

/**
 * The condition a trigger effect meets while the delivery may read it: it is
 * pending, and its workflow is valid. The pending rows of an invalid workflow
 * wait, still pending, until the workflow validates again or is saved. Reads
 * `trigger_effects` as `effect`, and `workflows`.
 */
const IS_DELIVERABLE_EFFECT = "effect.state = 'pending' AND workflows.invalid_since IS NULL";

/** The repository of the `trigger_effects` table. */
export const triggerEffectRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /** Matches the rows of `trigger_effects` that belong to `key`. */
  const ofTrigger = (key: TriggerKey) =>
    sql`workflow_id = ${uuidFromString(key.workflowId)} AND trigger_id = ${key.triggerId}`;

  return {
    /**
     * Writes a row in `state` for a trigger's match on an event, and returns
     * whether it wrote one. A trigger that already has a row for the event
     * writes nothing, so routing one event twice starts one run and not two.
     */
    insertMatch: (
      match: TriggerMatch,
      state: "pending" | "held",
    ): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly id: number }>`
          INSERT INTO trigger_effects (workflow_id, trigger_id, event_id, state, inputs, matched_at)
          VALUES (${uuidFromString(match.workflowId)}, ${match.triggerId}, ${match.eventId},
                  ${state}, ${JSON.stringify(match.inputs)}, ${match.matchedAt})
          ON CONFLICT (workflow_id, trigger_id, event_id) DO NOTHING
          RETURNING id
        `,
        (rows) => rows.length > 0,
      ),

    /**
     * Reads what decides how `trigger`'s next match is written, in one
     * query, at `now`. Returns `None` when the trigger no longer exists.
     *
     * The trigger's spawn bound comes from its row, so a save since the
     * router listed the trigger counts. `trigger.spawnBound` stands in for
     * the default: when the row sets no bound, the listing resolved it to
     * the default.
     */
    readSpawnState: (
      trigger: RoutableStartTrigger,
      now: string,
    ): Effect.Effect<Option.Option<SpawnState>, SqlError> => {
      const maxRuns = buildMaxRuns(sql, trigger.spawnBound);
      return Effect.map(
        sql<{
          readonly paused_by: TriggerPausedBy | null;
          readonly has_room: number | null;
          readonly held_reached_limit: number | null;
        }>`
          SELECT triggers.paused_by,
            CASE WHEN triggers.status = 'active' AND NOT ${sql.literal(HOLDS_EVENTS)}
              THEN ${buildRunsInWindow(sql, trigger.spawnBound, now)} < ${maxRuns} END
              AS has_room,
            CASE WHEN triggers.status = 'active' AND ${sql.literal(HOLDS_EVENTS)}
              THEN ${sql.literal(HELD_COUNT)} >= triggers.held_at_resume + ${maxRuns} END
              AS held_reached_limit
          FROM triggers
          WHERE triggers.workflow_id = ${uuidFromString(trigger.workflowId)}
            AND triggers.trigger_id = ${trigger.triggerId}
        `,
        (rows) =>
          Option.map(Option.fromNullishOr(rows[0]), (row) => ({
            pausedBy: row.paused_by ?? undefined,
            hasRoom: readTruth(row.has_room),
            heldReachedLimit: readTruth(row.held_reached_limit),
          })),
      );
    },

    /**
     * Returns how many more runs a start trigger may start in the window that
     * ends at `now`: its `maxRuns` less the runs it used, and never less than
     * 0. Returns 0 when the trigger no longer exists.
     */
    readRoomInWindow: (
      key: TriggerKey,
      defaultBound: SpawnBound,
      now: string,
    ): Effect.Effect<number, SqlError> =>
      Effect.map(
        sql<{ readonly room: number }>`
          SELECT max(0, ${buildMaxRuns(sql, defaultBound)}
                        - ${buildRunsInWindow(sql, defaultBound, now)}) AS room
          FROM triggers
          WHERE triggers.workflow_id = ${uuidFromString(key.workflowId)}
            AND triggers.trigger_id = ${key.triggerId}
        `,
        (rows) => rows[0]?.room ?? 0,
      ),

    /**
     * Checks whether a start trigger may start one more run now: whether it
     * started fewer than its `maxRuns` runs in the window that ends at `now`.
     * Pending rows do not count, because the row about to start is one of
     * them. Returns false when the trigger no longer exists.
     */
    hasRoomToStart: (
      key: TriggerKey,
      defaultBound: SpawnBound,
      now: string,
    ): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly has_room: number }>`
          SELECT ${buildRunsStartedInWindow(sql, defaultBound, now)}
                   < ${buildMaxRuns(sql, defaultBound)} AS has_room
          FROM triggers
          WHERE triggers.workflow_id = ${uuidFromString(key.workflowId)}
            AND triggers.trigger_id = ${key.triggerId}
        `,
        (rows) => rows[0]?.has_room === 1,
      ),

    /**
     * Moves a pending row back to `held`, to wait until its trigger's window
     * has room. Also raises the trigger's `held_at_resume` by one, so the
     * row does not count toward tripping the breaker again: it matched
     * within the bound in force at the time. A trigger never resumed held
     * nothing before, so it counts from 0.
     */
    holdAgain: (effect: PendingTriggerEffect): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        yield* sql`UPDATE trigger_effects SET state = 'held' WHERE id = ${effect.id}`;
        yield* sql`
          UPDATE triggers SET held_at_resume = COALESCE(held_at_resume, 0) + 1
          WHERE ${ofTrigger(effect)}
        `;
      }),

    /**
     * Moves up to `count` of a trigger's held rows to `pending`, the oldest
     * first, and returns how many it moved. Moves none unless the trigger
     * meets `IS_PROMOTABLE_START_TRIGGER`, so a trigger paused, or a workflow
     * disabled or marked invalid, since it was listed keeps its held rows.
     */
    promoteHeld: (key: TriggerKey, count: number): Effect.Effect<number, SqlError> =>
      Effect.map(
        sql<{ readonly id: number }>`
          UPDATE trigger_effects SET state = 'pending'
          WHERE id IN (
            SELECT effect.id FROM trigger_effects AS effect
            JOIN triggers ON triggers.workflow_id = effect.workflow_id
                         AND triggers.trigger_id = effect.trigger_id
            JOIN workflows ON workflows.id = triggers.workflow_id
            WHERE effect.workflow_id = ${uuidFromString(key.workflowId)}
              AND effect.trigger_id = ${key.triggerId}
              AND effect.state = 'held' AND ${sql.literal(IS_PROMOTABLE_START_TRIGGER)}
            ORDER BY effect.id LIMIT ${count}
          )
          RETURNING id
        `,
        (rows) => rows.length,
      ),

    /**
     * Moves every pending row of a trigger to `held`, and returns how many it
     * moved. A manual pause calls it, so the events the trigger matched wait
     * for the resume instead of starting runs.
     */
    holdPending: (key: TriggerKey): Effect.Effect<number, SqlError> =>
      Effect.map(
        sql<{ readonly id: number }>`
          UPDATE trigger_effects SET state = 'held'
          WHERE ${ofTrigger(key)} AND state = 'pending'
          RETURNING id
        `,
        (rows) => rows.length,
      ),

    /** Moves every held row of a trigger to `discarded`, and returns how many it moved. */
    discardHeld: (key: TriggerKey): Effect.Effect<number, SqlError> =>
      Effect.map(
        sql<{ readonly id: number }>`
          UPDATE trigger_effects SET state = 'discarded'
          WHERE ${ofTrigger(key)} AND state = 'held'
          RETURNING id
        `,
        (rows) => rows.length,
      ),

    /**
     * Records how many events a trigger holds as it is resumed. A later
     * match compares the trigger's held events to it, to trip the breaker
     * again when they keep growing.
     */
    recordHeldAtResume: (key: TriggerKey): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE triggers SET held_at_resume = ${sql.literal(HELD_COUNT)}
        WHERE triggers.workflow_id = ${uuidFromString(key.workflowId)}
          AND triggers.trigger_id = ${key.triggerId}
      `),

    /**
     * Returns the ids of the pending rows the delivery may start, in the
     * order the rows were written. Leaves out the rows of an invalid
     * workflow, as `IS_DELIVERABLE_EFFECT` describes.
     */
    listPendingIds: (): Effect.Effect<ReadonlyArray<number>, SqlError> =>
      Effect.map(
        sql<{ readonly id: number }>`
          SELECT effect.id FROM trigger_effects AS effect
          JOIN workflows ON workflows.id = effect.workflow_id
          WHERE ${sql.literal(IS_DELIVERABLE_EFFECT)}
          ORDER BY effect.id
        `,
        (rows) => rows.map((row) => row.id),
      ),

    /**
     * Returns a row if the delivery may still start it, as
     * `IS_DELIVERABLE_EFFECT` describes, or `None` if it is gone, no longer
     * pending, or its workflow is invalid.
     */
    readPending: (id: number): Effect.Effect<Option.Option<PendingTriggerEffect>, SqlError> =>
      Effect.map(
        sql<PendingRow>`
          SELECT effect.id, effect.workflow_id, effect.trigger_id, effect.event_id, effect.inputs
          FROM trigger_effects AS effect
          JOIN workflows ON workflows.id = effect.workflow_id
          WHERE effect.id = ${id} AND ${sql.literal(IS_DELIVERABLE_EFFECT)}
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

    /**
     * Moves a pending row to `spawned`, with the run it started and when it
     * started. The spawn bound's window counts runs by when they started.
     */
    markSpawned: (id: number, runId: string, spawnedAt: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE trigger_effects
        SET state = 'spawned', run_id = ${uuidFromString(runId)}, spawned_at = ${spawnedAt}
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

/**
 * Tells clients watching a trigger's workflow that the trigger's counts
 * changed: the runs it used in its window, or the events it holds.
 */
const announceTriggerCounts = (key: TriggerKey): Effect.Effect<void> =>
  announce({
    _tag: "record",
    topic: "workflow",
    id: key.workflowId,
    kind: "updated",
    countsOnly: true,
  });

/**
 * Builds the decision the breaker raises when it pauses a trigger. Its two
 * answers resume the trigger: one keeps the held events, the other discards
 * them first. The body carries no count of held events, because the count
 * keeps changing while the decision is open; the trigger list shows it.
 */
export const buildBreakerDecision = (
  key: TriggerKey,
  workflowName: string,
  spawnBound: SpawnBound,
) => ({
  kind: "core.breaker-tripped" as const,
  title: `Trigger ${key.triggerId} of ${workflowName} paused at its spawn bound`,
  body:
    `The trigger ${formatInlineCode(key.triggerId)} of the workflow ${formatInlineCode(workflowName)} ` +
    `matched more events than its spawn bound of ${describeSpawnBound(spawnBound)} allows, so it was paused. ` +
    "It holds every event it matches until you resume it. Check the trigger's filter, then resume it.",
  subject: [
    { kind: "trigger" as const, ...key },
    { kind: "workflow" as const, id: key.workflowId },
  ],
  actions: [
    {
      id: RESUME_ACTION_ID,
      label: "Resume",
      description:
        "The held events start runs in the order they arrived, as fast as the spawn bound allows.",
      operation: { op: "trigger.resume" as const, input: key },
      primary: true,
    },
    {
      id: RESUME_AND_DISCARD_ACTION_ID,
      label: "Resume and discard held events",
      description: "The held events start no run. They stay in the event log.",
      operation: { op: "trigger.resume" as const, input: { ...key, discardHeld: true } },
    },
  ],
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const effects = yield* triggerEffectRepository;
  const workflows = yield* workflowRepository;
  const health = yield* TriggerHealth;
  const triggeredRuns = yield* TriggeredRuns;
  const audit = yield* AuditLog;
  const notifier = yield* Notifier;
  const settings = yield* Settings;

  /**
   * Trips the breaker on `trigger`, whose match was just written `held`:
   * pauses it as paused by the breaker, writes the audit entry, and raises
   * the breaker decision, unless one about the trigger is still open. The
   * audit entry tells clients watching the workflow that the trigger
   * changed.
   */
  const tripBreaker = (trigger: RoutableStartTrigger, at: string): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const key = { workflowId: trigger.workflowId, triggerId: trigger.triggerId };
      yield* workflows.setTriggerStatus(key, { status: "paused", pausedBy: "breaker" }, at);
      yield* audit.append({
        kind: "trigger.paused",
        actor: SYSTEM_ACTOR,
        record: { topic: "workflow", id: key.workflowId },
        payload: { ...key, pausedBy: "breaker" },
        at,
      });
      // The trigger was just read in this transaction, so its workflow exists.
      const workflowName = Option.getOrElse(
        yield* workflows.readName(key.workflowId),
        () => key.workflowId,
      );
      yield* notifier.createCoreNotification(
        buildBreakerDecision(key, workflowName, trigger.spawnBound),
        { unlessOpenAbout: [{ kind: "trigger", ...key }] },
      );
    });

  /**
   * Starts the run of one pending trigger effect and marks the effect
   * spawned, in one transaction, as `startRun` describes. Discards an effect
   * whose run can no longer start, and logs why.
   */
  const startPendingRun = (effectId: number): Effect.Effect<void, SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const pending = yield* effects.readPending(effectId);
        if (Option.isNone(pending)) return;
        const effect = pending.value;
        const triggerDescription = `The trigger ${effect.triggerId} of the workflow ${effect.workflowId}`;
        if (!(yield* workflows.acceptsPendingEffects(effect))) {
          yield* Effect.logInfo(
            `${triggerDescription} starts no run for the event ${String(effect.eventId)}, because its workflow was disabled after the event matched.`,
          );
          return yield* Effect.asVoid(effects.discardIfPending(effect.id));
        }
        const event = yield* readPipelineEvent(sql, effect.eventId);
        if (Option.isNone(event)) {
          // Nothing deletes events yet. Event retention, once it is built,
          // must keep every event that has a pending or held trigger effect.
          // Should an event still be missing, starting the run without it
          // would lose what started the run, so the match is dropped.
          yield* Effect.logWarning(
            `${triggerDescription} starts no run for the event ${String(effect.eventId)}, because the event is no longer in the log.`,
          );
          return yield* Effect.asVoid(effects.discardIfPending(effect.id));
        }
        const startedAt = yield* nowIso;
        // A pending row was within the bound when it was written, but a save
        // may have lowered the bound since. The bound in force now decides.
        const defaultBound = yield* readDefaultSpawnBound(settings);
        if (!(yield* effects.hasRoomToStart(effect, defaultBound, startedAt))) {
          yield* effects.holdAgain(effect);
          return yield* announceTriggerCounts(effect);
        }
        const runId = yield* triggeredRuns.start(effect, event.value, startedAt);
        yield* effects.markSpawned(effect.id, runId, startedAt);
        yield* health.clearFailure(effect, "start");
        yield* announceTriggerCounts(effect);
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
      const discarded = yield* withTransaction(
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
     * Returns every start trigger the event router matches events against,
     * each with its spawn bound: its own, or the `spawnBound.default`
     * setting when its source sets none. The event router reads them once
     * per pass.
     */
    listRoutableStartTriggers: (): Effect.Effect<ReadonlyArray<RoutableStartTrigger>, SqlError> =>
      Effect.flatMap(readDefaultSpawnBound(settings), workflows.listRoutableStartTriggers),

    /**
     * Records that a start trigger matched `event`: maps the event onto the
     * workflow's inputs with the trigger's input mapping, evaluated against
     * `context`, and writes the match. Fails with `ExpressionError`, writing
     * nothing, when an input's expression fails on the event. Joins the
     * caller's transaction. The match is written:
     *
     * - `held`, when the breaker paused the trigger;
     * - `held`, when the trigger holds events, so this one queues behind
     *   them. When the held events grew by more than `maxRuns` since the
     *   trigger was resumed, the breaker trips again (see `tripBreaker`);
     * - `pending`, for the delivery to start, when the trigger's window has
     *   room for one more run;
     * - otherwise `held`, and the breaker trips.
     *
     * A trigger paused manually since the pass began writes nothing, as if
     * the router had not matched it.
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
        const match: TriggerMatch = {
          workflowId: trigger.workflowId,
          triggerId: trigger.triggerId,
          eventId: event.id,
          inputs: yield* evaluateMapping(trigger.inputs, context, "input"),
          matchedAt: yield* nowIso,
        };
        // The trigger is read again, because an earlier match of this pass
        // may have tripped its breaker.
        const found = yield* effects.readSpawnState(trigger, match.matchedAt);
        if (Option.isNone(found)) return;
        const state = found.value;
        if (state.pausedBy === "manual") return;
        // An event routed a second time has its row already. Writing nothing
        // then announces nothing, and trips no breaker for a match already
        // counted.
        if (!(yield* effects.insertMatch(match, state.hasRoom === true ? "pending" : "held"))) {
          return;
        }
        yield* announceTriggerCounts(trigger);
        if (state.hasRoom === false || state.heldReachedLimit === true) {
          yield* tripBreaker(trigger, match.matchedAt);
        }
      }),

    /**
     * Moves held events to `pending`, so the delivery starts their runs. For
     * each trigger that holds events and meets `IS_PROMOTABLE_START_TRIGGER`,
     * moves its oldest held events, as many as its window has room for. Each
     * trigger is done in its own transaction, which reads the trigger's spawn
     * bound and its room afresh. Never trips the breaker: what does not fit
     * stays held for a later delivery.
     */
    promoteHeldEvents: (): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        for (const key of yield* workflows.listTriggersWithHeldEvents()) {
          yield* withTransaction(
            sql,
            Effect.gen(function* () {
              const defaultBound = yield* readDefaultSpawnBound(settings);
              const room = yield* effects.readRoomInWindow(key, defaultBound, yield* nowIso);
              if (room === 0) return;
              if ((yield* effects.promoteHeld(key, room)) > 0) yield* announceTriggerCounts(key);
            }),
          );
        }
      }),

    /** Returns the ids of the trigger effects the delivery may start, oldest first. */
    listPendingIds: effects.listPendingIds,

    /**
     * Starts the run of one pending trigger effect, and marks the effect
     * spawned, in one transaction. So a run starts exactly once per match: a
     * crash before the commit leaves the effect pending and no run, and after
     * it the effect is no longer pending. A started run clears an error the
     * trigger's health recorded at the start stage.
     *
     * The effect is read again inside the transaction, because it may have
     * been started, held by a manual pause, or deleted with its trigger,
     * since it was listed. An effect of an invalid workflow is left pending,
     * to start once the workflow validates again. An effect whose trigger
     * already started `maxRuns` runs in its window goes back to `held`: a
     * save may have lowered the bound since the effect was written, and the
     * bound in force when the run would start decides. An effect whose run can no
     * longer start is discarded, and the log says why:
     *
     * - its workflow was disabled since the match. A trigger the breaker
     *   paused still starts the runs of its pending effects, which were
     *   within its bound;
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
 * The lifecycle of start trigger matches: recording a match under the
 * trigger's spawn bound, moving held events on as the window frees up, and
 * starting a match's run. The event router records; the controller daemon's
 * delivery moves held events on and starts runs.
 */
export class TriggerEffects extends Context.Service<TriggerEffects, Effect.Success<typeof make>>()(
  "hercule/controller/workflows/TriggerEffects",
) {}

export const TriggerEffectsLayer: Layer.Layer<
  TriggerEffects,
  never,
  SqlClient.SqlClient | TriggerHealth | TriggeredRuns | AuditLog | Notifier | Settings
> = Layer.effect(TriggerEffects)(make);
