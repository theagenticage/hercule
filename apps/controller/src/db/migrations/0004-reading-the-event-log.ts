/**
 * The index the event log's reader walks.
 *
 * `events` was written for appending, so it carried only its dedup index and
 * the arrival index the retention prune uses. Reading it by kind is the query
 * the log is opened for - "show me the failed logins" - and without an index
 * every page of it scans the whole table, which gets worse the rarer the kind
 * and the longer the log is kept.
 *
 * The id is in the index because every listing orders by it: with the kind and
 * the id together SQLite answers a page from the index alone, in order, and
 * never sorts.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX events_kind_id ON events (kind, id)`;
});
