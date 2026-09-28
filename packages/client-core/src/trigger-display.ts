/**
 * Turns a trigger into what a workflow's page shows about it: its mark and
 * status, which Connection it listens on, its schedule, when it fires next, why its filter
 * or input mapping failed, which scheduled times it missed, and whether it can
 * be paused or resumed.
 */
import { ANY_CONNECTION, type Trigger } from "@hercule/contract";
import { toIdTail } from "./id-tail";
import { formatStamp } from "./time-context";

/**
 * What a page shows about one trigger. A field is `undefined` when there is
 * nothing to show for it.
 *
 * - `connectionText`: "any connection", or "connection 1f3a9c2e" for one
 *   Connection. A trigger on a core event kind names no Connection.
 * - `scheduleText`: a cron trigger's schedule as written, with its timezone
 *   when the source names one: "0 9 * * 1-5 in Europe/Amsterdam".
 * - `nextFireText`: when a cron trigger fires next, "next 4 Sep 09:00". A
 *   paused trigger, or any trigger of a disabled workflow, does not fire, so
 *   it has none.
 * - `healthError`: why the trigger's filter or input mapping last failed, and
 *   when. The trigger matches no event until they succeed again.
 * - `skippedTicksText`: the scheduled times a cron trigger missed, such as
 *   "Missed scheduled times from 4 Sep 09:00 to 6 Sep 09:00".
 * - `mark`: the mark beside the trigger's id. `paused` while the trigger is
 *   paused, else `failed` while its filter or input mapping fails.
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
  readonly connectionText: string | undefined;
  readonly scheduleText: string | undefined;
  readonly nextFireText: string | undefined;
  readonly healthError: { readonly message: string; readonly atText: string } | undefined;
  readonly skippedTicksText: string | undefined;
  readonly toggle: "pause" | "resume" | undefined;
}

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
  const { connectionId, schedule, nextFireAt, health, skippedTicks, status } = trigger;
  return {
    mark: status === "paused" ? "paused" : health?.state === "error" ? "failed" : undefined,
    status:
      status === undefined
        ? undefined
        : { text: status, tone: status === "paused" ? "attn" : "muted" },
    connectionText:
      connectionId === undefined
        ? undefined
        : connectionId === ANY_CONNECTION
          ? "any connection"
          : `connection ${toIdTail(connectionId)}`,
    scheduleText:
      schedule === undefined
        ? undefined
        : trigger.timezone === undefined
          ? schedule
          : `${schedule} in ${trigger.timezone}`,
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
