/**
 * Adds `mcp_servers.sign_in_generation`: a counter that goes up each time the
 * server is given a new sign-in (a pasted token, a finished OAuth sign-in, or
 * Replace). A new server starts at 0. An ordinary refresh of OAuth tokens does
 * not write it.
 *
 * An OAuth sign-in is started, the user signs in in a browser, and the sign-in
 * is finished minutes later. In between, the user may paste a token, sign in
 * again, or move the server onto a Connection, and the finished sign-in must
 * not overwrite that. Both the start and the finish of a sign-in therefore
 * check that the server still has the generation the attempt started from. (A
 * refresh that is on its way to the token endpoint does not use the
 * generation: its write compares the stored secret with the one it read.)
 *
 * `revision` cannot tell these apart, because "Check now" and switching the
 * server on raise it too, and a sign-in the user started would be voided for
 * nothing. A counter that only a new sign-in raises answers exactly what the
 * check asks: "the sign-in is the one I started from".
 *
 * The column goes after `tools`, because SQLite only appends a column. A read
 * of a column that follows a long value walks that value's overflow pages, so
 * only the reads of a sign-in (`readSignInGeneration`) select this column, and
 * the reads of many servers never do.
 *
 * No row is rewritten, so there is nothing to migrate.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE mcp_servers ADD COLUMN sign_in_generation INTEGER NOT NULL DEFAULT 0`;
});
