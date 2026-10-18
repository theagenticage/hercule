/**
 * Adds `skills.upstream_commit`: the GitHub commit whose tree the last update
 * check judged, or null (spec 04 "Skill rows").
 *
 * A check that finds the branch still at this commit downloads nothing. That
 * shortcut holds only while the current revision is the one the commit was
 * compared with, so the column is cleared whenever the current revision or
 * the source changes, and when a check fails before it judges a tree.
 *
 * The column is nullable and every existing row starts with null, so the next
 * check of each GitHub Skill downloads its tree once.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE skills ADD COLUMN upstream_commit TEXT`;
});
