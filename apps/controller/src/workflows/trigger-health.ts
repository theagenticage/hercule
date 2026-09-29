/**
 * A start trigger's health: the error the trigger last failed with, the stage
 * it failed at, and when the user hears about it.
 *
 * A trigger fails at one of three stages (`TriggerFailureStage`):
 *
 * - the event router cannot evaluate its filter or input mapping on an event;
 * - the Scheduler cannot compute a cron trigger's next time, because its
 *   timezone is no longer a known one;
 * - the delivery cannot start the run of a match.
 *
 * Only the stage that recorded an error clears it: the event router when an
 * evaluation of the trigger succeeds again, the Scheduler when it computes the
 * next time of a trigger it could not schedule before, and the delivery when
 * a run starts. So a trigger whose filter is fine but whose runs cannot start
 * stays in error, instead of moving between ok and error on every event.
 *
 * The health is shown on the trigger's row, so the user sees it there at any
 * time. The notification is for the user who is not looking. It is raised
 * when the health turns to a new error, and at most once per
 * `TRIGGER_NOTIFICATION_QUIET_PERIOD` for the same trigger, so a filter that
 * fails on every other event does not raise a notification per event.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { TriggerKey } from "@hercule/contract";
import { announce, nowIso } from "../db";
import { NotificationService } from "../notifications";
import { workflowRepository, type TriggerFailureStage } from "./repository";

/**
 * How long after a notification about one trigger's trouble the next one of
 * the same kind about that trigger is held back.
 */
export const TRIGGER_NOTIFICATION_QUIET_PERIOD: Duration.Duration = Duration.hours(1);

/** The title of the notification about a new error, for each stage. */
const NOTIFICATION_TITLES: Record<TriggerFailureStage, string> = {
  evaluation: "A trigger's filter or inputs could not be evaluated",
  scheduling: "A trigger's next scheduled time could not be computed",
  start: "A trigger could not start its run",
};

const make = Effect.gen(function* () {
  const workflows = yield* workflowRepository;
  const notifications = yield* NotificationService;

  /** Tells clients watching the trigger's workflow that the trigger changed. */
  const announceTriggerChange = (key: TriggerKey): Effect.Effect<void> =>
    announce({ _tag: "record", topic: "workflow", id: key.workflowId, kind: "updated" });

  return {
    /**
     * Records that a start trigger failed at `stage` with `message`. When the
     * failure turns the health to a new error, it also raises a
     * `core.trigger-error` notification, unless one about the trigger was
     * raised within the quiet period. Joins the caller's transaction.
     */
    recordFailure: (
      key: TriggerKey,
      stage: TriggerFailureStage,
      message: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const turnedToError = yield* workflows.recordTriggerFailure(
          key,
          stage,
          message,
          yield* nowIso,
        );
        if (!turnedToError) return;
        yield* announceTriggerChange(key);
        yield* notifications.createCoreNotification(
          {
            kind: "core.trigger-error",
            title: NOTIFICATION_TITLES[stage],
            body: message,
            subject: [{ kind: "trigger", workflowId: key.workflowId, triggerId: key.triggerId }],
          },
          { unlessRaised: { within: TRIGGER_NOTIFICATION_QUIET_PERIOD } },
        );
      }),

    /**
     * Clears a start trigger's recorded error if `stage` recorded it, and
     * tells clients when it did. Joins the caller's transaction.
     */
    clearFailure: (key: TriggerKey, stage: TriggerFailureStage): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        if (yield* workflows.clearTriggerFailure(key, stage)) yield* announceTriggerChange(key);
      }),
  };
});

export class TriggerHealth extends Context.Service<TriggerHealth, Effect.Success<typeof make>>()(
  "hercule/controller/workflows/TriggerHealth",
) {}

export const TriggerHealthLayer: Layer.Layer<
  TriggerHealth,
  never,
  SqlClient.SqlClient | NotificationService
> = Layer.effect(TriggerHealth)(make);
