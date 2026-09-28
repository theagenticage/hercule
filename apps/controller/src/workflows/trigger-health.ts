/**
 * A start trigger's health: the error the trigger last failed with, while the
 * failures go on, and when the user hears about them.
 *
 * A trigger fails in one of three places:
 *
 * - the event router cannot evaluate its filter or input mapping on an event;
 * - the Scheduler cannot compute a cron trigger's next time, because its
 *   timezone is no longer a known one;
 * - the delivery cannot start the run of a match, because of a bug.
 *
 * Each failure is recorded on the trigger. The event router clears it when an
 * evaluation of the trigger succeeds again, and the Scheduler clears it when
 * it computes the next time of a trigger it could not schedule before. A
 * trigger's health is shown on its row, so
 * the user sees it there at any time. The notification is for the user who is
 * not looking: it is raised when a streak of failures starts, and at most once
 * per `TRIGGER_NOTIFICATION_QUIET_PERIOD` for the same trigger, so a filter
 * that fails on every other event does not raise a notification per event.
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
import { workflowRepository } from "./repository";

/**
 * How long after a notification about one trigger's trouble the next one of
 * the same kind is held back. The runs domain uses it too, for the runs a
 * trigger starts that fail validation.
 */
export const TRIGGER_NOTIFICATION_QUIET_PERIOD: Duration.Duration = Duration.hours(1);

/** Where a start trigger failed, as the module comment lists. */
export type TriggerFailureStage = "evaluation" | "scheduling" | "start";

/** The title of the notification that starts a streak of failures, for each stage. */
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
     * Records that a start trigger failed at `stage` with `message`. When this
     * failure starts a streak, it also raises a `core.trigger-filter-error`
     * notification, unless one about the trigger was raised within the quiet
     * period. Joins the caller's transaction.
     */
    recordFailure: (
      key: TriggerKey,
      stage: TriggerFailureStage,
      message: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const startedStreak = yield* workflows.recordTriggerFailure(key, message, yield* nowIso);
        if (!startedStreak) return;
        yield* announceTriggerChange(key);
        yield* notifications.createCoreNotification(
          {
            kind: "core.trigger-filter-error",
            title: NOTIFICATION_TITLES[stage],
            body: message,
            subject: [{ kind: "trigger", workflowId: key.workflowId, triggerId: key.triggerId }],
          },
          { unlessRaised: { within: TRIGGER_NOTIFICATION_QUIET_PERIOD } },
        );
      }),

    /** Clears a start trigger's recorded error. Joins the caller's transaction. */
    clearFailure: (key: TriggerKey): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        yield* workflows.clearTriggerFailure(key);
        yield* announceTriggerChange(key);
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
