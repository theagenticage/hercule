/**
 * Turns a trigger into what a workflow's page shows about it: its mark and
 * status, what it fires on, when it fires next, why it failed, which
 * scheduled times it missed, and whether it can be paused or resumed.
 */
import { ANY_CONNECTION, isSchedule, type Trigger, type TriggerOn } from "@hercule/contract";
import { toIdTail } from "./id-tail";
import { formatStamp } from "./time-context";

/**
 * What a page shows about one trigger. A field is `undefined` when there is
 * nothing to show for it.
 *
 * - `firesOnText`: what the trigger fires on. See `describeTriggerOn`.
 * - `nextFireText`: when a cron trigger fires next, "next 4 Sep 09:00". A
 *   paused trigger, or any trigger of a disabled workflow, does not fire, so
 *   it has none.
 * - `healthError`: the error on the trigger's health, and when it began: its
 *   filter or input mapping could not be evaluated, its next scheduled time
 *   could not be computed, or a run could not start.
 * - `skippedTicksText`: the scheduled times a cron trigger missed, such as
 *   "Missed scheduled times from 4 Sep 09:00 to 6 Sep 09:00".
 * - `mark`: the mark beside the trigger's id. `paused` while the trigger is
 *   paused, else `failed` while its health is an error.
 * - `status`: a start trigger's status and the tone to show it in, `attn`
 *   while it is paused, because a paused trigger starts no runs until the
 *   user resumes it. A signal trigger has no status.
 * - `toggle`: what the user can do to a start trigger, `pause` while it is
 *   active and `resume` while it is paused. A signal trigger has no status,
 *   so it has no toggle.
 */
export interface TriggerReading {
  readonly mark: "paused" | "failed" | undefined;
  readonly status: { readonly text: string; readonly tone: "muted" | "attn" } | undefined;
  readonly firesOnText: string;
  readonly nextFireText: string | undefined;
  readonly healthError: { readonly message: string; readonly atText: string } | undefined;
  readonly skippedTicksText: string | undefined;
  readonly toggle: "pause" | "resume" | undefined;
}

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
 * `isWorkflowEnabled` is whether the trigger's workflow is enabled. A trigger
 * keeps its own status while its workflow is disabled, so it can still be
 * paused or resumed, but it has no next fire time.
 */
export const describeTrigger = (
  trigger: Trigger,
  timezone: string,
  isWorkflowEnabled: boolean,
): TriggerReading => {
  const formatTime = (at: string): string => formatStamp(new Date(at), timezone) ?? at;
  const { nextFireAt, health, skippedTicks, status } = trigger;
  return {
    mark: status === "paused" ? "paused" : health?.state === "error" ? "failed" : undefined,
    status:
      status === undefined
        ? undefined
        : { text: status, tone: status === "paused" ? "attn" : "muted" },
    firesOnText: describeTriggerOn(trigger.on),
    nextFireText:
      nextFireAt === undefined || status === "paused" || !isWorkflowEnabled
        ? undefined
        : `next ${formatTime(nextFireAt)}`,
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
    toggle: status === "active" ? "pause" : status === "paused" ? "resume" : undefined,
  };
};
