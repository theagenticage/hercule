/**
 * Turns a trigger into what a workflow's page shows about it: its mark and
 * status, what it fires on, when it fires next, how much of its spawn bound
 * it used, the events it holds, why it failed, which scheduled times it
 * missed, and whether it can be paused or resumed.
 */
import {
  ANY_CONNECTION,
  isSchedule,
  type EventWithFacts,
  type Trigger,
  type TriggerFiresOn,
  type TriggerOn,
  type Workflow,
  toIdTail,
} from "@hercule/contract";
import { describeEventTitle } from "./intake";
import {
  describeBoundUse,
  describeStartTriggerStatus,
  isPausedWithHeldEvents,
  type BoundUseReading,
} from "./spawn-bounds";
import { formatStamp } from "./time-context";
import { firesTriggers } from "./workflow-firing";

/**
 * What a page shows about one trigger. A field is `undefined` when there is
 * nothing to show for it.
 *
 * - `firesOn`: whether the trigger fires on events or on a schedule. A page
 *   shows a schedule in full, because it is a cron trigger's main fact, and
 *   lets an event kind's text be cut short.
 * - `firesOnText`: what the trigger fires on. See `describeTriggerOn`.
 * - `nextFireText`: when a cron trigger fires next, "next 4 Sep 09:00". A
 *   paused trigger does not fire, and neither does any trigger of a disabled
 *   or invalid workflow, so they have none.
 * - `healthError`: the error on the trigger's health, and when it began: its
 *   filter or input mapping could not be evaluated, its next scheduled time
 *   could not be computed, or a run could not start.
 * - `skippedTicksText`: the scheduled times a cron trigger missed, such as
 *   "Missed scheduled times from 4 Sep 09:00 to 6 Sep 09:00".
 * - `mark`: the mark beside the trigger's id. `paused` while the trigger is
 *   paused, else `failed` while its health is an error.
 * - `status`: a start trigger's status and the tone to show it in. See
 *   `describeStartTriggerStatus`. The tone is `attn` while it is paused,
 *   because a paused trigger starts no runs until it is resumed. A signal
 *   trigger has no status.
 * - `bound`: how much of its spawn bound a start trigger used. See
 *   `describeBoundUse`. A signal trigger has no bound.
 * - `held`: the events a start trigger holds, waiting to start a run, when
 *   it holds any: their count, "45 held", and what happens to them next.
 *   They wait while the workflow is invalid, while it is disabled, and while
 *   the trigger is paused, so the text names the first of these that holds
 *   them back.
 * - `canDiscardHeldEvents`: whether the trigger can be resumed with its held
 *   events discarded, and the page lists the oldest of them. See
 *   `isPausedWithHeldEvents`.
 * - `toggle`: what the user can do to a start trigger, `pause` while it is
 *   active and `resume` while it is paused. A signal trigger has no status,
 *   so it has no toggle.
 * - `isPausedByBreaker`: whether the breaker paused the trigger. Resuming is
 *   then the answer the user is asked for, so the page shows Resume as the
 *   primary action.
 */
export interface TriggerReading {
  readonly mark: "paused" | "failed" | undefined;
  readonly status: { readonly text: string; readonly tone: "muted" | "attn" } | undefined;
  readonly firesOn: TriggerFiresOn;
  readonly firesOnText: string;
  readonly nextFireText: string | undefined;
  readonly bound: BoundUseReading | undefined;
  readonly held: { readonly countText: string; readonly nextText: string } | undefined;
  readonly canDiscardHeldEvents: boolean;
  readonly healthError: { readonly message: string; readonly atText: string } | undefined;
  readonly skippedTicksText: string | undefined;
  readonly toggle: "pause" | "resume" | undefined;
  readonly isPausedByBreaker: boolean;
}

/**
 * How many held events a trigger's row lists. The rest are counted in one
 * line, because the count, not the list, tells the user how many events wait,
 * and the oldest few show what the trigger matched.
 */
export const HELD_EVENT_PREVIEW_LIMIT = 3;

/**
 * The held events a trigger's row lists, and the line that counts the rest.
 * Each row holds:
 *
 * - `title`: the event's title, or its kind when its source set no title.
 * - `isKindTitle`: whether `title` is the kind, which the row draws as code.
 * - `author`: who caused the event on its own system, or `undefined`.
 * - `receivedText`: when the event was received.
 */
export interface HeldEventsReading {
  readonly rows: ReadonlyArray<{
    readonly id: number;
    readonly title: string;
    readonly isKindTitle: boolean;
    readonly author: string | undefined;
    readonly receivedText: string;
  }>;
  /** "and 42 more", or `undefined` when every held event is listed. */
  readonly moreText: string | undefined;
}

/**
 * Decides whether a trigger that fires on `on` fires on a schedule or on
 * events, which picks the clock or the bolt drawn beside it.
 */
export const decideFiresOn = (on: TriggerOn): TriggerFiresOn =>
  isSchedule(on) ? "schedule" : "event";

/**
 * Returns the text for what a trigger fires on:
 *
 * - For events, the event kind and the Connection they arrive through:
 *   "github.issue.opened · any connection", or
 *   "github.issue.opened · connection 1f3a9c2e" for one Connection. A kind
 *   the core emits arrives through no Connection, so its text is the kind
 *   alone.
 * - For a schedule, the cron expression as written, with its timezone when
 *   one is set: "0 9 * * 1-5 in Europe/Amsterdam".
 *
 * The filter is left out: it is often long, and it can be read in the
 * workflow's source.
 */
export const describeTriggerOn = (on: TriggerOn): string => {
  if (isSchedule(on)) {
    return on.timezone === undefined ? on.schedule : `${on.schedule} in ${on.timezone}`;
  }
  if (on.connectionId === undefined) return on.kind;
  const connection =
    on.connectionId === ANY_CONNECTION
      ? "any connection"
      : `connection ${toIdTail(on.connectionId)}`;
  return `${on.kind} · ${connection}`;
};

/**
 * Returns what a page shows about `trigger`, with its times formatted in
 * `timezone`, the user's display timezone. A time that cannot be formatted in
 * that timezone is shown as the timestamp the controller sent.
 *
 * `workflow` is the trigger's workflow. A trigger keeps its own status while
 * its workflow is disabled or invalid, so it can still be paused or resumed.
 * But the controller then fires none of the workflow's triggers and starts no
 * runs from their held events, so the trigger has no next fire time, and its
 * held events wait for the workflow rather than for the bound.
 */
export const describeTrigger = (
  trigger: Trigger,
  timezone: string,
  workflow: Pick<Workflow, "enabled" | "invalidSince">,
): TriggerReading => {
  const formatTime = (at: string): string => formatStamp(new Date(at), timezone) ?? at;
  const { nextFireAt, health, skippedTicks, status, spawnBound } = trigger;
  const heldCount = trigger.heldCount ?? 0;
  const isPaused = status === "paused";
  const isInvalid = workflow.invalidSince !== undefined;
  return {
    mark: isPaused ? "paused" : health?.state === "error" ? "failed" : undefined,
    status:
      status === undefined
        ? undefined
        : { text: describeStartTriggerStatus(trigger), tone: isPaused ? "attn" : "muted" },
    firesOn: decideFiresOn(trigger.on),
    firesOnText: describeTriggerOn(trigger.on),
    nextFireText:
      nextFireAt === undefined || isPaused || !firesTriggers(workflow)
        ? undefined
        : `next ${formatTime(nextFireAt)}`,
    bound:
      spawnBound === undefined
        ? undefined
        : describeBoundUse(spawnBound, trigger.runsInWindow ?? 0),
    held:
      heldCount === 0
        ? undefined
        : {
            countText: `${String(heldCount)} held`,
            nextText: isInvalid
              ? "They start runs in order once the workflow is valid again, as fast as the bound allows."
              : !workflow.enabled
                ? "They start runs in order once the workflow is enabled again, as fast as the bound allows."
                : isPaused
                  ? "They start runs in order once you resume the trigger, as fast as the bound allows."
                  : "They start runs in order, as fast as the bound allows.",
          },
    canDiscardHeldEvents: isPausedWithHeldEvents(trigger),
    healthError:
      health?.state === "error"
        ? { message: health.message, atText: formatTime(health.at) }
        : undefined,
    skippedTicksText:
      skippedTicks === undefined
        ? undefined
        : skippedTicks.from === skippedTicks.until
          ? `Missed the scheduled time ${formatTime(skippedTicks.from)}`
          : `Missed scheduled times from ${formatTime(skippedTicks.from)} to ${formatTime(skippedTicks.until)}`,
    toggle: status === "active" ? "pause" : isPaused ? "resume" : undefined,
    isPausedByBreaker: isPaused && trigger.pausedBy === "breaker",
  };
};

/**
 * Returns the held events a trigger's row lists, oldest first as `events`
 * holds them, with each received time formatted in `timezone`, and the line
 * that counts the `heldCount` held events not in `events`. A time that cannot
 * be formatted in that timezone is shown as the timestamp the controller sent.
 */
export const describeHeldEvents = (
  events: ReadonlyArray<EventWithFacts>,
  heldCount: number,
  timezone: string,
): HeldEventsReading => {
  const rest = heldCount - events.length;
  return {
    rows: events.map((event) => ({
      id: event.id,
      title: describeEventTitle(event),
      isKindTitle: event.title === null,
      author: event.author ?? undefined,
      receivedText: formatStamp(new Date(event.receivedAt), timezone) ?? event.receivedAt,
    })),
    moreText: rest > 0 ? `and ${String(rest)} more` : undefined,
  };
};
