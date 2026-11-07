/**
 * Adds the stage of a Task (spec 09): where the Task stands, in seven fixed
 * values. `status` stays as a coarse reading of the stage, so this migration
 * only adds columns and fills them from the status each row already has.
 *
 * - `stage` is `exploring`, `planned`, `building`, `in-review`, `landed`,
 *   `done` or `dropped`;
 * - `stage_changed_at` changes only when `stage` does, as `status_changed_at`
 *   does for `status`.
 *
 * Existing rows take the earliest stage their status allows:
 *
 * | `status`      | `stage`    |
 * |---------------|------------|
 * | `open`        | `planned`  |
 * | `in-progress` | `building` |
 * | `done`        | `done`     |
 * | `cancelled`   | `dropped`  |
 *
 * `stage_changed_at` takes the row's `status_changed_at`. The fill does not
 * touch `updated_at`, and it does not reach the full-text index, whose trigger
 * fires only on an update of `title` or `description`.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // SQLite refuses to add a NOT NULL column without a default. Both defaults
  // exist only to satisfy that rule: the UPDATE below overwrites them on
  // every existing row, and the repository writes both columns on every insert.
  yield* sql`
    ALTER TABLE tasks ADD COLUMN stage TEXT NOT NULL DEFAULT 'planned'
      CHECK (stage IN ('exploring', 'planned', 'building', 'in-review', 'landed', 'done', 'dropped'))
  `;
  yield* sql`ALTER TABLE tasks ADD COLUMN stage_changed_at TEXT NOT NULL DEFAULT ''`;

  yield* sql`
    UPDATE tasks SET
      stage = CASE status
        WHEN 'open' THEN 'planned'
        WHEN 'in-progress' THEN 'building'
        WHEN 'done' THEN 'done'
        WHEN 'cancelled' THEN 'dropped'
      END,
      stage_changed_at = status_changed_at
  `;

  yield* sql`CREATE INDEX tasks_stage ON tasks (stage, id) WHERE deleted_at IS NULL`;
});
