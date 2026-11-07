/**
 * Announces what a write to External Entities changed, so open clients read
 * again. Both the poll ingest and the service's operations use it, so a card
 * is announced the same way whoever changed it.
 */
import * as Effect from "effect/Effect";
import { announce, announceTaskCardChange } from "../db";

/**
 * Records, for the transaction it runs in, one `externalEntity` change for
 * each id in `entityIds`, and one derived `task` change for each Task in
 * `affectedTaskIds` (the live Tasks that link a changed entity or sit below
 * one). The changes are published once the transaction commits, and are
 * dropped if it rolls back.
 *
 * Call it inside the transaction that wrote the change: outside a
 * transaction, a change is published at once, before anything is durable.
 */
export const announceEntityChanges = (changes: {
  readonly entityIds: ReadonlyArray<string>;
  readonly affectedTaskIds: ReadonlyArray<string>;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const id of changes.entityIds) {
      yield* announce({ _tag: "record", topic: "externalEntity", id, kind: "updated" });
    }
    for (const taskId of changes.affectedTaskIds) yield* announceTaskCardChange(taskId);
  });
