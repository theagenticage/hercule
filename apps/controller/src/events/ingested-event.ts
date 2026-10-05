/**
 * The write of the events a plugin's event source ingests through a
 * Connection. The source is the plugin's id, the Connection is the one the
 * ingest handle was opened for, and the actor is null: an ingested event
 * records something that happened in an external system, not a mutation any
 * actor of this system made (spec 08 §2).
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { uuidFromString } from "../db";
import { appendEvent } from "./append";

/** One ingested event as it goes into the log, already checked against its kind. */
export interface IngestedEventToAppend {
  /** The id of the plugin whose event source emitted the event. */
  readonly source: string;
  readonly connectionId: string;
  readonly system: string;
  readonly kind: string;
  readonly occurredAt: string;
  readonly receivedAt: string;
  readonly dedupKey: string;
  readonly refs: ReadonlyArray<string>;
  readonly url: string | null;
  readonly payload: unknown;
  readonly raw: Readonly<Record<string, unknown>> | null;
}

/**
 * Appends one ingested event to the log, in the caller's transaction, and
 * announces it to the log's Live Topic once the transaction commits.
 *
 * Returns true when the event was written, and false when the log already
 * holds an event with the same source, Connection and dedup key. A source
 * that polls the same change twice therefore writes it once.
 */
export const appendIngestedEvent = (
  sql: SqlClient.SqlClient,
  event: IngestedEventToAppend,
): Effect.Effect<boolean, SqlError> =>
  Effect.map(
    appendEvent(sql, {
      ...event,
      connectionId: uuidFromString(event.connectionId),
      actor: null,
    }),
    (id) => id !== undefined,
  );
