/**
 * Replaces the index on `events (received_at)` with one on
 * `events (received_at, connection_id)`.
 *
 * `event.countByConnection` counts the events of the last 24 hours by
 * Connection. With the Connection in the index, SQLite answers that count
 * from the index alone and never reads the event rows, which hold the
 * payloads. The new index still serves every query the old one served, such
 * as the retention prune's range on `received_at`, so the old one goes.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE INDEX events_received_at_connection ON events (received_at, connection_id)`;
  yield* sql`DROP INDEX events_received_at`;
});
