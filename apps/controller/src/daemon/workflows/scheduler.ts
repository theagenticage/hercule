/**
 * The Scheduler: the loop that fires cron triggers.
 *
 * Every interval it lists the cron triggers that have work, and schedules
 * each one: fire it, skip the times it missed, or compute its next time. The
 * rule is the workflows domain's (`CronTriggerScheduler`); this loop only
 * sets when it runs. A fired trigger appends a `cron.tick` event, and the
 * event pipeline starts the run from there, like for any other event.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { CronTriggerScheduler, FIRING_TOLERANCE } from "../../workflows";
import { PromotionState } from "../../promotion";
import { absorbFailures } from "../absorbing";

/**
 * How often the Scheduler looks for cron triggers whose time has come, which
 * is how late after its time a trigger can fire. Tests override it.
 *
 * It must be shorter than `FIRING_TOLERANCE` (60 seconds): a time the
 * Scheduler reaches later than that counts as missed, and does not fire.
 * `checkSchedulerInterval` enforces this.
 */
export const SchedulerInterval = Context.Reference<Duration.Duration>(
  "hercule/controller/daemon/SchedulerInterval",
  { defaultValue: (): Duration.Duration => Duration.seconds(1) },
);

/**
 * Checks that the Scheduler looks for due triggers more often than
 * `FIRING_TOLERANCE`. Dies otherwise, because such a Scheduler would reach
 * scheduled times too late to fire them, and every cron trigger would
 * record missed times instead of firing.
 */
export const checkSchedulerInterval: Effect.Effect<void> = Effect.gen(function* () {
  const interval = yield* SchedulerInterval;
  if (Duration.isLessThan(interval, FIRING_TOLERANCE)) return;
  return yield* Effect.die(
    new Error(
      `The Scheduler interval is ${Duration.format(interval)}, and it must be shorter than ` +
        `${Duration.format(FIRING_TOLERANCE)}, the time a cron trigger may fire late. ` +
        "Set a shorter interval.",
    ),
  );
});

/**
 * Schedules the cron triggers that have work, and repeats that every
 * interval. Never returns. Each trigger is scheduled on its own, so a trigger
 * that fails is logged and the others still fire. A pass whose listing fails
 * is logged too, and the next one runs.
 */
export const runScheduler: Effect.Effect<never, never, CronTriggerScheduler | PromotionState> =
  Effect.gen(function* () {
    const scheduler = yield* CronTriggerScheduler;
    const interval = yield* SchedulerInterval;
    const promotion = yield* PromotionState;

    /** Schedules every cron trigger that has work at `now`, each on its own. */
    const scheduleDueTriggers = (now: Date): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        for (const key of yield* scheduler.listTriggersToSchedule(now)) {
          yield* absorbFailures(
            `Scheduling the cron trigger ${key.triggerId} of the workflow ${key.workflowId} failed`,
            scheduler.scheduleTrigger(key, now),
          );
        }
      });

    while (true) {
      const millis = yield* Clock.currentTimeMillis;
      yield* absorbFailures(
        "Scheduling cron triggers failed",
        promotion.whenServing(scheduleDueTriggers(new Date(millis))),
      );
      yield* Effect.sleep(interval);
    }
  });
