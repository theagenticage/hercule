/**
 * Adds the typed fields of External Entities.
 *
 * - `external_entity_fields` has one row per field an entity's kind declares
 *   and the observation gave a value. `key` is the declared field's key.
 *   Exactly one of the two value columns is set: `text_value` for `text`,
 *   `person` and `enum` fields, `number_value` for `number`, `money`, `age`
 *   (epoch milliseconds) and `bool` (0 or 1). A field with no value has no
 *   row. Rows are keyed by `ref`, like the timeline, and the prune sweep
 *   deletes the rows of a ref that has no entity.
 * - `external_entity_fields_text` and `external_entity_fields_number` serve
 *   the queries that narrow by one field's value. Each holds only the rows of
 *   its own column, and a query uses it only when it writes the same
 *   `IS NOT NULL` condition.
 *
 * The migration only adds a table and indexes, so the upgrade test needs no
 * fixture for it.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE external_entity_fields (
      ref TEXT NOT NULL,
      key TEXT NOT NULL,
      text_value TEXT,
      number_value REAL,
      PRIMARY KEY (ref, key)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE INDEX external_entity_fields_text ON external_entity_fields (key, text_value)
    WHERE text_value IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX external_entity_fields_number ON external_entity_fields (key, number_value)
    WHERE number_value IS NOT NULL
  `;
});
