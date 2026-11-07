/**
 * Gives a Task its place on the Work board and the failure it shows, and
 * gives a session the time its last turn ended (spec 09).
 *
 * - `tasks.board_rank` orders the cards of one cell, a cell being the Tasks
 *   with the same `(project_id, stage)`. It is a string of digits from the 62
 *   characters `0-9A-Za-z`, read as a fraction (`tasks/board-rank.ts`).
 *   Existing Tasks get ranks spread evenly over their cell, the oldest first
 *   by `(created_at, id)`. A cell holds deleted Tasks too, so every row gets a
 *   rank. The partial index serves a cell read in rank order. It leaves out
 *   deleted Tasks and Tasks at `done` or `dropped`, which are never shown in
 *   rank order, so its size follows the board and not the history. A read of
 *   it repeats the index's condition (`tasks/repository.ts`, `ON_BOARD`).
 * - `tasks.failed_run_id` is the run whose failure the Task shows until the
 *   failure ends. A live Task whose newest run failed gets it now, so failures
 *   from before the upgrade show too. "Newest" is by `(created_at, id)`.
 * - `tasks.failure_revision` counts the changes to who is handling the
 *   failure. It starts at 0 for every Task, and the first failure to be set or
 *   cleared after the upgrade raises it.
 * - `task_failure_recoveries` has one row per run start that ended a failure,
 *   so that the Undo of that start can bring the failure back. Like
 *   `runs.task_id`, its ids are not foreign keys: a run is history that keeps
 *   the id of a Task deleted since.
 * - `sessions.last_turn_ended_at` is when the session's own agent last ended a
 *   turn. `last_activity_at` moves on every tool event, so it cannot say that.
 *   Sessions that are not live (`idle` or `exited`) take their
 *   `last_activity_at`; the others stay empty until their turn ends.
 * - `runs_task_finished` and `sessions_task_turn_ended` hold, for each Task,
 *   only the columns the board totals read (when a run ended, and the
 *   `agent_id` and last turn end of a session), so the totals of a Task never
 *   read its runs or sessions themselves.
 *
 * The backfill groups rows by the hex of `project_id` and reads `id` as it
 * comes, so it makes no assumption about the shape of an id.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The digits of a board rank, in ascending order. A copy of the alphabet in
 * `tasks/board-rank.ts`: a migration that has shipped never changes, and the
 * test of this migration checks that the two agree.
 */
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Returns `count` ranks in ascending order, evenly spread over the range, with
 * one digit more than needed to tell them apart so a card can later be put
 * between two of them. A copy of `spreadBoardRanks`, for the reason above.
 */
const spreadRanks = (count: number): ReadonlyArray<string> => {
  const base = ALPHABET.length;
  let width = 1;
  while (base ** width < (count + 1) * base) width++;
  const unit = base ** width;
  return Array.from({ length: count }, (_, index) => {
    let value = Math.floor(((index + 1) * unit) / (count + 1));
    let digits = "";
    for (let place = 0; place < width; place++) {
      digits = ALPHABET[value % base]! + digits;
      value = Math.floor(value / base);
    }
    return digits.replace(/0+$/, "");
  });
};

interface TaskToRank {
  readonly id: Uint8Array | string;
  readonly cell: string;
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // SQLite refuses to add a NOT NULL column without a default. The default
  // exists only for that: the loop below overwrites it on every existing row,
  // and the repository writes a rank on every insert.
  yield* sql`ALTER TABLE tasks ADD COLUMN board_rank TEXT NOT NULL DEFAULT ''`;
  yield* sql`ALTER TABLE tasks ADD COLUMN failed_run_id BLOB`;
  yield* sql`ALTER TABLE tasks ADD COLUMN failure_revision INTEGER NOT NULL DEFAULT 0`;

  const tasks = yield* sql<TaskToRank>`
    SELECT id, hex(project_id) || ':' || stage AS cell FROM tasks ORDER BY created_at, id
  `;
  // A Map keeps the order its keys were added in, and the rows are sorted, so
  // each cell lists its Tasks oldest first.
  const cells = new Map<string, Array<TaskToRank>>();
  for (const task of tasks) {
    const cell = cells.get(task.cell);
    if (cell === undefined) cells.set(task.cell, [task]);
    else cell.push(task);
  }
  for (const cell of cells.values()) {
    const ranks = spreadRanks(cell.length);
    for (const [index, task] of cell.entries()) {
      yield* sql`UPDATE tasks SET board_rank = ${ranks[index]!} WHERE id = ${task.id}`;
    }
  }

  // Serves the cards of one cell in rank order, with no sort of its own.
  yield* sql`
    CREATE INDEX tasks_board_rank ON tasks (project_id, stage, board_rank)
      WHERE deleted_at IS NULL AND stage NOT IN ('done', 'dropped')
  `;

  yield* sql`
    UPDATE tasks SET failed_run_id = newest.id
    FROM (
      SELECT id, task_id, status,
             ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY created_at DESC, id DESC) AS position
      FROM runs WHERE task_id IS NOT NULL
    ) newest
    WHERE newest.task_id = tasks.id AND newest.position = 1 AND newest.status = 'failed'
      AND tasks.deleted_at IS NULL
  `;

  yield* sql`
    CREATE TABLE task_failure_recoveries (
      run_id BLOB PRIMARY KEY NOT NULL,
      task_id BLOB NOT NULL,
      failed_run_id BLOB NOT NULL,
      revision_after INTEGER NOT NULL,
      restored_at TEXT
    ) WITHOUT ROWID
  `;

  yield* sql`ALTER TABLE sessions ADD COLUMN last_turn_ended_at TEXT`;
  yield* sql`
    UPDATE sessions SET last_turn_ended_at = last_activity_at
    WHERE status IN ('idle', 'exited')
  `;

  // Serve the board's per-Task totals from the index alone. `finished_at` and
  // `last_turn_ended_at` sit after large columns in their rows, so without
  // these a read of up to a thousand Tasks would read every run and session
  // of each. The session index holds `agent_id` and not `kind`: `kind` is a
  // generated column, and SQLite never answers from an index alone for one.
  // A session with no `agent_id` is a Thread (see `kind`, migration 0092).
  yield* sql`
    CREATE INDEX runs_task_finished ON runs (task_id, finished_at) WHERE task_id IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX sessions_task_turn_ended ON sessions (task_id, agent_id, last_turn_ended_at)
      WHERE task_id IS NOT NULL
  `;
});
