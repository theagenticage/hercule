/**
 * The one write of a row into the event log. Every writer in this domain -
 * `event.emit`, the platform-source writer, the Scheduler's ticks and the
 * ingested-event writer - builds its row and appends it here, so the column
 * list and the dedup rule live in one place.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { EventId } from "@hercule/contract";
import { announce } from "../db";

/** One event as it goes into the log. */
export interface EventToAppend {
  readonly source: string;
  readonly connectionId: Uint8Array | null;
  readonly system: string;
  readonly kind: string;
  readonly occurredAt: string;
  readonly receivedAt: string;
  readonly dedupKey: string;
  readonly refs: ReadonlyArray<string>;
  /** Where a person opens the event in its own system, or null when there is no such page. */
  readonly url: string | null;
  readonly payload: unknown;
  /** The external system's own body, kept for debugging, or null. */
  readonly raw: Readonly<Record<string, unknown>> | null;
  /** The actor stamp of the mutation behind the event, or null when there is none. */
  readonly actor: string | null;
}

/**
 * Appends one event to the log, in the caller's transaction, and announces it
 * to the log's Live Topic once the transaction commits.
 *
 * Returns the new event's id, its position in the log. Returns `undefined`
 * and writes nothing when the log already holds an event with the same
 * source, Connection and dedup key, because the unique index over those three
 * columns blocks the insert.
 */
export const appendEvent = (
  sql: SqlClient.SqlClient,
  event: EventToAppend,
): Effect.Effect<EventId | undefined, SqlError> =>
  Effect.gen(function* () {
    const written = yield* sql<{ readonly id: number }>`
      INSERT INTO events
        (source, connection_id, system, kind, occurred_at, received_at,
         dedup_key, refs, url, payload, raw, actor)
      VALUES
        (${event.source}, ${event.connectionId}, ${event.system}, ${event.kind},
         ${event.occurredAt}, ${event.receivedAt}, ${event.dedupKey},
         ${JSON.stringify(event.refs)}, ${event.url}, ${JSON.stringify(event.payload)},
         ${event.raw === null ? null : JSON.stringify(event.raw)}, ${event.actor})
      ON CONFLICT (source, ifnull(connection_id, x''), dedup_key) DO NOTHING
      RETURNING id
    `;
    const appended = written[0];
    if (appended === undefined) return undefined;
    yield* announce({ _tag: "event" });
    return appended.id;
  });
