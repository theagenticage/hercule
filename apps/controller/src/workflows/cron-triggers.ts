/**
 * Firing cron triggers: the rule the Scheduler applies to every start
 * trigger on `cron.tick` (spec 07 section 2, spec 08 section 3).
 *
 * Each cron trigger row holds the next time it is scheduled to fire, and the
 * timezone that time was computed in. The Scheduler lists the triggers it has
 * work for, and schedules each one on its own:
 *
 * - A trigger with no next time yet, or whose next time lies ahead but was
 *   computed in a timezone that no longer applies, gets its next time
 *   computed. It does not fire.
 * - A trigger whose next time has come fires once, for the latest scheduled
 *   time that has come: one `cron.tick` event is appended to the log, and the
 *   event pipeline routes it to the trigger like any other event. Its next
 *   time moves on.
 * - A time that is more than `FIRING_TOLERANCE` late, because the controller
 *   was down, does not fire. The stretch of times the trigger missed is
 *   recorded on it, so the user sees it. There are no catch-up runs: after a
 *   downtime, only the latest time fires, if it is recent enough.
 * - A trigger that is paused, or whose workflow is disabled, does not fire
 *   either. Its next time moves on without a note, because nothing was missed.
 */
import * as Cron from "effect/Cron";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { TriggerKey } from "@hercule/contract";
import { announce, withTransaction } from "../db";
import { appendCronTickEvent } from "../events";
import { Settings } from "../settings";
import { workflowRepository, type CronAdvance } from "./repository";

/**
 * How late a scheduled time may be and still fire. The Scheduler looks every
 * second (`SchedulerInterval` in the controller daemon), so a live controller
 * is never this late. A later time means the controller was not running at
 * that time.
 */
const FIRING_TOLERANCE: Duration.Duration = Duration.seconds(60);

/** The timezone a schedule is read in when neither the trigger nor the user sets one. */
const DEFAULT_TIMEZONE = "UTC";

/**
 * Decides what a trigger that is due and can fire writes at `now`: the
 * scheduled time it fires for, and the stretch of times it missed. Both are
 * absent when nothing applies.
 *
 * `scheduledFor` is the earliest time that has come and has not fired. The
 * trigger fires for the latest time that has come, if that time is within
 * `FIRING_TOLERANCE`, and the times between the two are missed. When even the
 * latest time is too late, every time up to it is missed and nothing fires.
 */
export const decideFiring = (
  cron: Cron.Cron,
  scheduledFor: string,
  now: Date,
): Pick<CronAdvance, "firedAt" | "skipped"> => {
  const latest = Cron.prev(cron, Cron.next(cron, now)).toISOString();
  // The latest time is earlier than `scheduledFor` only when `scheduledFor`
  // was computed in a timezone that no longer applies. That time is still
  // owed, so it is the one to fire for.
  const fireFor = latest > scheduledFor ? latest : scheduledFor;
  if (now.getTime() - Date.parse(fireFor) > Duration.toMillis(FIRING_TOLERANCE)) {
    return { skipped: { from: scheduledFor, until: fireFor } };
  }
  if (fireFor === scheduledFor) return { firedAt: fireFor };
  const lastMissed = Cron.prev(cron, new Date(fireFor)).toISOString();
  return {
    firedAt: fireFor,
    skipped: { from: scheduledFor, until: lastMissed > scheduledFor ? lastMissed : scheduledFor },
  };
};

export const makeCronTriggerScheduler = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const workflows = yield* workflowRepository;
  const settings = yield* Settings;

  /** Returns the timezone a cron trigger without one of its own is read in. */
  const readUserZone = (): Effect.Effect<string, SqlError> =>
    Effect.map(
      settings.readUserTimezone(),
      Option.getOrElse(() => DEFAULT_TIMEZONE),
    );

  return {
    /**
     * Returns the cron triggers the Scheduler has work for at `now`, as the
     * workflow repository's `listCronTriggersToSchedule` describes. Paused
     * triggers and triggers of disabled workflows are included, so their
     * schedule keeps moving.
     */
    listCronTriggersToSchedule: (now: Date): Effect.Effect<ReadonlyArray<TriggerKey>, SqlError> =>
      Effect.flatMap(readUserZone(), (userZone) =>
        workflows.listCronTriggersToSchedule(now.toISOString(), userZone),
      ),

    /**
     * Applies the rule in the module comment to one cron trigger at `now`,
     * and writes the result in one transaction: the tick, if the trigger
     * fires, and the trigger's next time. So a crash never leaves a tick
     * written for a trigger that still waits for that time, and if it did,
     * the tick's dedup key would stop the second write.
     *
     * The trigger is read again inside the transaction, because it may have
     * been saved, paused or deleted since it was listed. A trigger that is
     * gone, or has no work any more, writes nothing.
     */
    scheduleCronTrigger: (key: TriggerKey, now: Date): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const found = yield* workflows.readCronTrigger(key);
          if (Option.isNone(found)) return;
          const trigger = found.value;
          const zone = trigger.timezone ?? (yield* readUserZone());
          // A save refuses a schedule or a timezone that does not parse, and a
          // schedule that never comes due. The user's timezone setting is
          // checked when it is written.
          const cron = Cron.parseUnsafe(trigger.schedule, zone);
          const advance: CronAdvance = { nextFireAt: Cron.next(cron, now).toISOString(), zone };
          const scheduledFor = trigger.nextFireAt;
          if (scheduledFor === undefined || Date.parse(scheduledFor) > now.getTime()) {
            if (scheduledFor !== undefined && trigger.nextFireZone === zone) return;
            yield* workflows.advanceCronTrigger(key, advance);
          } else if (!trigger.canFire) {
            yield* workflows.advanceCronTrigger(key, advance);
          } else {
            const firing = decideFiring(cron, scheduledFor, now);
            if (firing.firedAt !== undefined) {
              yield* appendCronTickEvent(
                sql,
                {
                  workflowId: key.workflowId,
                  triggerId: key.triggerId,
                  scheduledFor: firing.firedAt,
                  previousFiredAt: trigger.lastFiredAt ?? null,
                },
                now.toISOString(),
              );
            }
            yield* workflows.advanceCronTrigger(key, { ...advance, ...firing });
          }
          yield* announce({
            _tag: "record",
            topic: "workflow",
            id: key.workflowId,
            kind: "updated",
          });
        }),
      ),
  };
});
