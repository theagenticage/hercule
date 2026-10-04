/**
 * The write of the Scheduler's `cron.tick` events, which have
 * `source: "cron"`. Each tick fires one cron trigger once, at one scheduled
 * time, and its payload names that trigger.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { CronTickEventPayload } from "@hercule/contract";
import { appendEvent } from "./append";
import { CRON_TICK_EVENT_KIND } from "./kinds";
import { CRON_TICK_SOURCE } from "./sources";

/**
 * Appends one `cron.tick` event to the log, in the caller's transaction, and
 * announces it to the log's Live Topic once the transaction commits. The
 * event happened at the scheduled time, so `occurred_at` is `scheduledFor`
 * and `received_at` is `receivedAt`.
 *
 * Returns true when the event was written, and false when the log already
 * holds the tick for this trigger at this scheduled time. The dedup key is
 * built from exactly those three values, so a Scheduler that fires the same
 * time twice, for example after a crash between the write and the
 * trigger's update, writes the tick only once.
 */
export const appendCronTickEvent = (
  sql: SqlClient.SqlClient,
  payload: CronTickEventPayload,
  receivedAt: string,
): Effect.Effect<boolean, SqlError> =>
  Effect.map(
    appendEvent(sql, {
      source: CRON_TICK_SOURCE,
      connectionId: null,
      system: CRON_TICK_SOURCE,
      kind: CRON_TICK_EVENT_KIND,
      occurredAt: payload.scheduledFor,
      receivedAt,
      dedupKey: `${payload.workflowId}/${payload.triggerId}/${payload.scheduledFor}`,
      refs: [],
      url: null,
      payload,
      raw: null,
      actor: null,
    }),
    (id) => id !== undefined,
  );
