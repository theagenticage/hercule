/**
 * The platform event writer: the events the controller emits about its own
 * state into the event pipeline, where the event router matches them against
 * triggers and subscriptions. A workflow that starts when another one fails,
 * or a session that waits for a run to end, listens for these.
 *
 * A platform event is written like an audit entry (`platform-source-event.ts`),
 * in the transaction of the change it reports, so the event and the change
 * commit together or not at all. Unlike an audit entry, every kind here has a payload
 * schema in the contract, because triggers filter on its fields and readers
 * of the log decode it.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  PermissionDecidedEventPayload,
  RunCancelledEventPayload,
  RunCompletedEventPayload,
  RunFailedEventPayload,
  TaskCreatedEventPayload,
  TaskUpdatedEventPayload,
  type Actor,
  type EventId,
} from "@hercule/contract";
import { appendPlatformSourceEvent } from "./platform-source-event";

/** The payload schema of each platform event kind. */
const PLATFORM_EVENT_PAYLOADS = {
  "run.completed": RunCompletedEventPayload,
  "run.failed": RunFailedEventPayload,
  "run.cancelled": RunCancelledEventPayload,
  "task.created": TaskCreatedEventPayload,
  "task.updated": TaskUpdatedEventPayload,
  "permission.decided": PermissionDecidedEventPayload,
} as const;

export type PlatformEventKind = keyof typeof PLATFORM_EVENT_PAYLOADS;

/**
 * One platform event: its kind, its payload, and who caused it.
 *
 * - `actor` is the actor whose request caused the event, or `system` when no
 *   request did, as for a run that ended on its own. A payload never repeats
 *   the actor.
 * - `at` is the timestamp the change wrote on its own rows, so the event is
 *   never dated before the change it reports.
 */
export type PlatformEvent = {
  readonly [Kind in PlatformEventKind]: {
    readonly kind: Kind;
    readonly payload: Schema.Schema.Type<(typeof PLATFORM_EVENT_PAYLOADS)[Kind]>;
    readonly actor: Actor;
    readonly at: string;
  };
}[PlatformEventKind];

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /**
     * Emits one platform event, in the caller's transaction. Transactions
     * are ambient, so the event rolls back with the change it reports, and
     * the event router never sees an event about something that did not
     * happen.
     *
     * It announces a change to the log's Live Topic only. The domain the
     * event is about announces the change to its own record, as it does for
     * every other write to that record.
     *
     * Returns the event's id, so a record derived from the event, such as
     * the notification of a failed run, can point at it.
     */
    emit: (event: PlatformEvent): Effect.Effect<EventId, SqlError> =>
      Effect.gen(function* () {
        // The payload's type already matches its schema. Encoding turns it
        // into the JSON the log stores.
        const payload = yield* Effect.orDie(
          Schema.encodeUnknownEffect(PLATFORM_EVENT_PAYLOADS[event.kind])(event.payload),
        );
        return yield* appendPlatformSourceEvent(sql, {
          kind: event.kind,
          actor: event.actor,
          payload,
          at: event.at,
        });
      }),
  };
});

/** The platform event writer. */
export class PlatformEvents extends Context.Service<PlatformEvents, Effect.Success<typeof make>>()(
  "hercule/controller/events/PlatformEvents",
) {}

export const PlatformEventsLayer: Layer.Layer<PlatformEvents, never, SqlClient.SqlClient> =
  Layer.effect(PlatformEvents, make);
