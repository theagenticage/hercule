/**
 * Which events a start trigger wants, before its filter is evaluated.
 */
import { ANY_CONNECTION, type Event } from "@hercule/contract";
import { CRON_TICK_EVENT_KIND, CRON_TICK_SOURCE } from "../events";
import type { RoutableStartTrigger } from "./repository";

/**
 * Returns whether a start trigger wants an event, judged by the event's kind
 * and the Connection it arrived through:
 *
 * - the event's kind must be the trigger's event kind;
 * - a trigger that names a Connection wants only events from that Connection,
 *   and `any` wants events from every Connection;
 * - a `cron.tick` is wanted only by the one trigger its payload names, and
 *   only when the Scheduler wrote it. Every cron trigger listens for the same
 *   kind, so without this check each tick would start a run of every cron
 *   trigger.
 */
export const admitsEvent = (trigger: RoutableStartTrigger, event: Event): boolean => {
  if (event.kind !== trigger.eventKind) return false;
  if (event.kind === CRON_TICK_EVENT_KIND) {
    return (
      event.source === CRON_TICK_SOURCE &&
      event.payload["workflowId"] === trigger.workflowId &&
      event.payload["triggerId"] === trigger.triggerId
    );
  }
  if (trigger.connectionId === undefined || trigger.connectionId === ANY_CONNECTION) return true;
  return event.connectionId === trigger.connectionId;
};
