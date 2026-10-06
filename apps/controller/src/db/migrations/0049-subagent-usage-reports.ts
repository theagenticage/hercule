/**
 * Keeps the provider report behind a subagent's latest accepted usage snapshot.
 * An adapter receives it on a resume to restore its native counter baseline.
 * Existing rows have no report; the adapter must obtain a baseline itself.
 * The controller stores the report unchanged and never interprets its payload.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE session_subagents ADD COLUMN last_usage_report TEXT
    CHECK (last_usage_report IS NULL OR json_valid(last_usage_report))`;
});
