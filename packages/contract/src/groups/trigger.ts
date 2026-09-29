/**
 * Triggers: the parts of a workflow that decide which events start a run or
 * resume one.
 *
 * A trigger is defined in its workflow's source. The controller also stores a
 * row for each trigger next to the workflow, so the triggers of all workflows
 * can be listed together. For example, a scheduled-tasks view lists the cron
 * triggers. A trigger is identified by its workflow's id plus its id in the
 * source, which is unique only within that workflow.
 *
 * The list returns every field of each trigger, so there is no operation that
 * reads one trigger. A field the trigger does not have is absent, not null.
 *
 * `trigger.pause` and `trigger.resume` change a start trigger's status. They
 * are the only writes to a trigger that do not go through its workflow's
 * source.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import {
  Forbidden,
  Internal,
  InvalidState,
  NotFound,
  Unauthenticated,
  Validation,
} from "../errors";
import { Id, Timestamp } from "../ids";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { Timezone } from "../strings";
import { EventKind } from "./event";
import { ConnectionSelection } from "./workflow-definition";

/** A start trigger starts runs. A signal trigger resumes a live run. */
export const TriggerKind = Schema.Literals(["start", "signal"]);

export type TriggerKind = Schema.Schema.Type<typeof TriggerKind>;

/**
 * Whether a start trigger starts runs. The status is stored on the trigger's
 * row, not in the source, so pausing a trigger never changes the workflow's
 * text. A signal trigger has no status, because it cannot be paused.
 */
export const TriggerStatus = Schema.Literals(["active", "paused"]);

export type TriggerStatus = Schema.Schema.Type<typeof TriggerStatus>;

/**
 * Whether a start trigger works:
 *
 * - `ok`: nothing failed since a save last changed the trigger, or what
 *   failed has worked since.
 * - `error`: the trigger failed at one of three stages:
 *   - its filter or input mapping could not be evaluated on an event, for
 *     example because the filter read a field the event does not have. The
 *     trigger matches no event while its filter fails.
 *   - a cron trigger's next scheduled time could not be computed, because its
 *     timezone is no longer a known one. The trigger does not fire until it
 *     can be computed.
 *   - the run of a match could not start. That match starts no run.
 *
 *   `message` is the latest error, and `at` is when the trigger first failed
 *   at that stage. The error is cleared when the same stage works again: an
 *   evaluation succeeds, the next time is computed, or a run starts.
 *
 * The user is notified when the health turns to a new error, not on every
 * failure after it.
 */
export const TriggerHealth = Schema.Union([
  Schema.Struct({ state: Schema.Literal("ok") }),
  Schema.Struct({ state: Schema.Literal("error"), message: Schema.String, at: Timestamp }),
]);

export type TriggerHealth = Schema.Schema.Type<typeof TriggerHealth>;

/**
 * The scheduled times a cron trigger let pass without firing, because the
 * controller was not running when they came due or was too far behind to
 * fire them on time. A missed time is never fired late: the trigger waits for
 * its next scheduled time. Only the latest stretch of missed times is kept.
 *
 * - `from`: the first scheduled time that was missed.
 * - `until`: the last scheduled time that was missed.
 */
export const SkippedTicks = Schema.Struct({ from: Timestamp, until: Timestamp });

export type SkippedTicks = Schema.Schema.Type<typeof SkippedTicks>;

export const Trigger = Schema.Struct({
  workflowId: Id,
  /** The workflow's name, included so a client can show it without reading the workflow. */
  workflowName: Schema.String,
  /** The trigger's id in the workflow's source. */
  triggerId: Schema.String,
  kind: TriggerKind,
  eventKind: EventKind,
  connectionId: Schema.optionalKey(ConnectionSelection),
  filter: Schema.optionalKey(Schema.String),
  schedule: Schema.optionalKey(Schema.String),
  /** As written in the source. A cron trigger without one uses the user's timezone setting. */
  timezone: Schema.optionalKey(Timezone),
  /** Set on start triggers only. */
  status: Schema.optionalKey(TriggerStatus),
  /** Set on start triggers only. */
  health: Schema.optionalKey(TriggerHealth),
  /**
   * When a cron trigger's schedule next comes due. Absent until the
   * Scheduler has first read the trigger, which it does within a second of
   * the trigger being saved.
   */
  nextFireAt: Schema.optionalKey(Timestamp),
  /** When a cron trigger last fired. Absent until it first fires. */
  lastFiredAt: Schema.optionalKey(Timestamp),
  /** The latest scheduled times a cron trigger missed, if it ever missed any. */
  skippedTicks: Schema.optionalKey(SkippedTicks),
  createdAt: Timestamp,
  /** When the trigger itself last changed. Saving its workflow does not always change it. */
  updatedAt: Timestamp,
});

export type Trigger = Schema.Schema.Type<typeof Trigger>;

/** Filters for the trigger list. Each field narrows the list; there is no negation. */
export const TriggerFilter = Schema.Struct({
  workflowId: Schema.optionalKey(Id),
  kind: Schema.optionalKey(TriggerKind),
  eventKind: Schema.optionalKey(EventKind),
  status: Schema.optionalKey(TriggerStatus),
});

/** The fields the trigger list can be sorted by. */
export const TRIGGER_SORT_FIELDS = ["createdAt"] as const;

/**
 * Names one trigger: its workflow's id and its id in that workflow's source.
 * Both are needed, because a trigger id is unique only within its workflow.
 */
export const TriggerKey = Schema.Struct({ workflowId: Id, triggerId: Schema.String });

export type TriggerKey = Schema.Schema.Type<typeof TriggerKey>;

/**
 * The payload of `cron.tick`, the event the Scheduler emits when a cron
 * trigger's schedule comes due. Each tick is for one trigger, and only that
 * trigger starts a run from it.
 *
 * - `scheduledFor`: the scheduled time that came due. The event's
 *   `occurredAt` is the same instant.
 * - `previousFiredAt`: when the trigger last fired before this tick, `null`
 *   for its first. A scheduled time the trigger missed does not count, so a
 *   workflow can read the whole stretch since it last ran. The field is
 *   always present, because an input mapping that reads a missing field
 *   fails.
 */
export const CronTickEventPayload = Schema.Struct({
  workflowId: Id,
  triggerId: Schema.String,
  scheduledFor: Timestamp,
  previousFiredAt: Schema.NullOr(Timestamp),
});

export type CronTickEventPayload = Schema.Schema.Type<typeof CronTickEventPayload>;

export const trigger = HttpApiGroup.make("trigger")
  .add(
    HttpApiEndpoint.get("query", "/triggers", {
      query: Schema.Struct({
        ...TriggerFilter.fields,
        ...pageParams(TRIGGER_SORT_FIELDS).fields,
      }),
      success: page(Trigger),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    /**
     * Pauses a start trigger, so it starts no run until it is resumed, and
     * returns it. Events that arrive while it is paused are not kept for
     * later. Pausing a paused trigger changes nothing. Fails with
     * `invalid_state` for a signal trigger, which cannot be paused.
     */
    HttpApiEndpoint.post("pause", "/workflows/:workflowId/triggers/:triggerId/pause", {
      params: TriggerKey.fields,
      success: Trigger,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    /**
     * Resumes a paused start trigger and returns it. Resuming an active
     * trigger changes nothing. Fails with `invalid_state` for a signal
     * trigger.
     */
    HttpApiEndpoint.post("resume", "/workflows/:workflowId/triggers/:triggerId/resume", {
      params: TriggerKey.fields,
      success: Trigger,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
  )
  .middleware(Authenticated);
