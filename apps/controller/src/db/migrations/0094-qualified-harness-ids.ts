/**
 * Rewrites stored data to the Harness names of the renamed code: a harness is
 * now identified by a qualified id (`claude-code/claude-code`, `codex/codex`,
 * `pi/pi`), where it used to be a bare name (`claude-code`, `codex`, `pi`).
 *
 * Three places hold harness names, and each is rewritten here:
 *
 * - `provider_instances.provider_id` holds the harness a Provider Instance
 *   runs. The column keeps its name; a later migration replaces the table.
 * - `runners.facts` is the JSON a runner reported about its machine. Its
 *   `providers` key (the harness binaries found on the machine) is renamed
 *   `harnesses`, and each bare id in its `adapters` list becomes qualified.
 *   Without this, the controller could not decode a stored row until its
 *   runner connected and reported again.
 * - `session_stream.event` is the JSON of each stored harness event. A
 *   top-level `providerRefs` key (the harness's own ids for an item) is renamed
 *   `harnessRefs`, so the transcript of an old session still reads its native
 *   session id.
 *
 * Only the three ids above are rewritten. Any other id, such as one that is
 * already qualified, stays as it is.
 *
 * The audit and event log payloads (`events.payload`) are not touched: they
 * record what was true when they were written.
 *
 * `session_stream` can hold millions of rows and only a few events carry
 * `providerRefs`, so the statement first filters with a plain text search for
 * the key, and only then checks that the key is top-level (a payload may hold
 * the same word deeper down, and that stays as it is).
 *
 * The rewrite fires no trigger on `session_stream` (migration 0063 only has
 * an `AFTER INSERT` one), and it leaves the text the transcript search
 * indexes (`detail.text` and `delta`) unchanged, so the index needs no rebuild.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE provider_instances
    SET provider_id = provider_id || '/' || provider_id
    WHERE provider_id IN ('claude-code', 'codex', 'pi')
  `;

  yield* sql`
    UPDATE runners
    SET facts = json_set(
      json_remove(facts, '$.providers'),
      '$.harnesses', json(json_extract(facts, '$.providers'))
    )
    WHERE json_type(facts, '$.providers') = 'array'
  `;
  // The list keeps its order only in practice: SQLite does not promise the
  // order of `json_group_array` over a subquery. That is fine here, because
  // `adapters` is read as a set (the controller only checks whether it
  // includes an id) and the runner replaces it with its own list when it
  // next connects.
  yield* sql`
    UPDATE runners
    SET facts = json_set(facts, '$.adapters', json((
      SELECT json_group_array(
        CASE WHEN value IN ('claude-code', 'codex', 'pi') THEN value || '/' || value ELSE value END
      )
      FROM (SELECT value FROM json_each(runners.facts, '$.adapters') ORDER BY key)
    )))
    WHERE json_type(facts, '$.adapters') = 'array'
  `;

  yield* sql`
    UPDATE session_stream
    SET event = json_set(
      json_remove(event, '$.providerRefs'),
      '$.harnessRefs', json(json_extract(event, '$.providerRefs'))
    )
    WHERE instr(event, '"providerRefs"') > 0 AND json_type(event, '$.providerRefs') = 'object'
  `;
});
