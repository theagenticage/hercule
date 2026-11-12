/**
 * Records on each Task link whether the user made it by taking the thing on.
 *
 * `task_entity_links.taken_on` is 1 when the user created the Task by Take on
 * or Add to Work, and 0 for every other way a link comes to be: a hand-off, a
 * Task made from a signal or an event, a link written by hand, by an agent
 * session or by a workflow action. The Inbox uses it to decide that the user
 * has taken an ask on: an ask raised before the user took the thing on stops
 * asking.
 *
 * Existing links are backfilled: a link is marked as taken on when the user
 * wrote it with the creation of its Task and its provenance entry names no
 * run, signal, event or merged Task. That is the shape Take on gave the Task
 * until now; a hand-off's entry names its run and a Task made from a signal or
 * an event names those. The backfill reads old data once, here, so the rest of
 * the code never has to guess from timestamps.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE task_entity_links ADD COLUMN taken_on INTEGER NOT NULL DEFAULT 0`;
  yield* sql`
    UPDATE task_entity_links SET taken_on = 1
    WHERE linked_by = 'user' AND EXISTS (
      SELECT 1 FROM task_provenance p JOIN tasks t ON t.id = p.task_id
      WHERE p.task_id = task_entity_links.task_id AND p.ref = task_entity_links.ref
        AND p.at = task_entity_links.linked_at AND p.at = t.created_at AND p.actor = 'user'
        AND p.run_id IS NULL AND p.signal_id IS NULL AND p.event_id IS NULL
        AND p.merged_task_id IS NULL)`;
});
