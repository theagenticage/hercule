/**
 * A start trigger's health: the error its filter or input mapping last failed
 * with, while the failures go on, and when the user hears about them.
 *
 * The event router records a failure on the trigger each time an evaluation
 * fails, and clears it when an evaluation of the trigger succeeds again. A
 * trigger's health is shown on its row, so the user sees it there at any
 * time. The notification is for the user who is not looking: it is raised
 * when a streak of failures starts, and at most once per
 * `TRIGGER_NOTIFICATION_QUIET_PERIOD` for the same trigger, so a filter that
 * fails on every other event does not raise a notification per event.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
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

/**
 * Returns the instant a notification must have been raised after to hold
 * back the next one about the same trigger: `TRIGGER_NOTIFICATION_QUIET_PERIOD`
 * before `now`.
 */
export const computeTriggerQuietSince = (now: string): string =>
  new Date(Date.parse(now) - Duration.toMillis(TRIGGER_NOTIFICATION_QUIET_PERIOD)).toISOString();

export const makeTriggerHealth = Effect.gen(function* () {
  const workflows = yield* workflowRepository;
  const notifications = yield* NotificationService;

  /** Tells clients watching the trigger's workflow that the trigger changed. */
  const announceTriggerChange = (key: TriggerKey): Effect.Effect<void> =>
    announce({ _tag: "record", topic: "workflow", id: key.workflowId, kind: "updated" });

  return {
    /**
     * Records that a start trigger's filter or input mapping failed with
     * `message`. When this failure starts a streak, it also raises a
     * `core.trigger-filter-error` notification, unless one about the trigger
     * was raised within the quiet period. Joins the caller's transaction.
     */
    recordTriggerEvaluationFailure: (
      key: TriggerKey,
      message: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const at = yield* nowIso;
        const startedStreak = yield* workflows.recordTriggerEvaluationFailure(key, message, at);
        if (!startedStreak) return;
        yield* announceTriggerChange(key);
        yield* notifications.createCoreNotification(
          {
            kind: "core.trigger-filter-error",
            title: "A trigger's filter or inputs could not be evaluated",
            body: message,
            subject: [{ kind: "trigger", workflowId: key.workflowId, triggerId: key.triggerId }],
          },
          { unlessRaised: { since: computeTriggerQuietSince(at) } },
        );
      }),

    /** Clears a start trigger's recorded evaluation error. Joins the caller's transaction. */
    clearTriggerEvaluationFailure: (key: TriggerKey): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        yield* workflows.clearTriggerEvaluationFailure(key);
        yield* announceTriggerChange(key);
      }),
  };
});
