/**
 * Adds the index that event log queries read.
 *
 * `events` was designed for appending, so it had only its dedup index and the
 * arrival-time index the retention prune uses. Reading it by kind is the main
 * query on the log ("show me the failed logins"), and without an index every
 * page scans the whole table. That gets worse the rarer the kind is and the
 * longer the log is kept.
 *
 * The id is in the index because every event query sorts by it. With the kind
 * and the id together, SQLite reads a page from the index alone, in order, and
 * never has to sort.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX events_kind_id ON events (kind, id)`;
});
