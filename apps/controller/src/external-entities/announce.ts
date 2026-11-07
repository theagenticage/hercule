/**
 * Announces what a write to External Entities changed, so open clients read
 * again. Both the poll ingest and the service's operations use it, so a card
 * is announced the same way whoever changed it.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { announce, announceTaskCardChange, uuidToString } from "../db";

/**
 * Records, for the transaction it runs in, one `externalEntity` change for
 * each entity named in `changedRefs`, and one derived `task` change for each
 * Task in `affectedTaskIds` (the live Tasks that link a changed entity or sit
 * below one). The changes are published once the transaction commits, and are
 * dropped if it rolls back. A ref with no entity row names nothing and is
 * skipped.
 *
 * Call it inside the transaction that wrote the change: outside a
 * transaction, a change is published at once, before anything is durable.
 * Fails with `SqlError` when the entity ids cannot be read.
 */
export const announceEntityChanges = (changes: {
  readonly changedRefs: ReadonlyArray<string>;
  readonly affectedTaskIds: ReadonlyArray<string>;
}): Effect.Effect<void, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (changes.changedRefs.length > 0) {
      const rows = yield* sql<{ readonly id: Uint8Array }>`
        SELECT id FROM external_entities
        WHERE ref IN (SELECT value FROM json_each(${JSON.stringify(changes.changedRefs)}))`;
      for (const row of rows) {
        yield* announce({
          _tag: "record",
          topic: "externalEntity",
          id: uuidToString(row.id),
          kind: "updated",
        });
      }
    }
    for (const taskId of changes.affectedTaskIds) yield* announceTaskCardChange(taskId);
  });
