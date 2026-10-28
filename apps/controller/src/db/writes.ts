/**
 * Stops and resumes writes to the controller's database, for a promotion
 * (spec 03 section 8.2).
 *
 * Once a promotion has copied the database, a write on this machine would be
 * missing on the machine the data moves to. Rather than trust every writer to
 * check the promotion phase first, the connection itself refuses writes.
 * SQLite's `query_only` setting makes every statement that would change the
 * database fail with `SQLITE_READONLY` ("attempt to write a readonly
 * database"), and that includes `BEGIN IMMEDIATE`. Reads still work, also
 * inside `withTransaction`, which begins with a plain `BEGIN` for this reason
 * (see `./client.ts`). A writer that forgot the promotion then fails with an
 * error instead of writing data the new machine never receives.
 *
 * The setting belongs to the writer connection, not to the file. Every
 * transaction runs on that connection, so it covers every writer in the
 * process, and a restart opens a new connection that starts writable. The
 * reader connection is read-only anyway, so it needs no setting.
 *
 * The functions here hold the writer while they work. Writes on other fibers
 * queue behind them, so no write can run between the copy and the stop, or slip
 * into the one transaction allowed while writes are stopped. Reads outside a
 * transaction run on the reader and keep being answered throughout, including
 * while writes are stopped, except during the `VACUUM INTO` copy, which blocks
 * the process while it runs.
 */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { withAnnouncements } from "./after-commit";
import { holdWriter } from "./client";
import { copyDatabaseTo } from "./migrate";

/**
 * Sets the `query_only` setting of the connection the statement runs on. Takes
 * no gate: it must run inside {@link holdWriter}, where the statement reaches the
 * held writer. Outside it, the statement would reach the read-only reader.
 */
const setQueryOnly = (sql: SqlClient.SqlClient, enabled: boolean): Effect.Effect<void, SqlError> =>
  Effect.asVoid(enabled ? sql`PRAGMA query_only = ON` : sql`PRAGMA query_only = OFF`);

/**
 * Stops every write on the writer, until {@link resumeWrites} or a restart. A
 * controller that boots sealed calls it once its boot is done.
 */
export const stopWrites = (sql: SqlClient.SqlClient): Effect.Effect<void, SqlError> =>
  holdWriter(sql, setQueryOnly(sql, true));

/**
 * Copies the database to `path` with `VACUUM INTO`, then stops every write
 * to it until {@link resumeWrites}. Fails with a `SqlError` when the copy
 * fails, and then leaves writes allowed.
 *
 * The copy comes first because `VACUUM INTO` is refused once writes are
 * stopped. Both run while the writer is held, so no other write can run
 * between them, and the copy holds every write the database ever accepts until
 * writes resume. The two steps cannot be interrupted apart. The wait for the
 * writer can be interrupted, because nothing has been done yet at that point.
 */
export const copyDatabaseAndStopWrites = (
  sql: SqlClient.SqlClient,
  path: string,
): Effect.Effect<void, SqlError> =>
  holdWriter(
    sql,
    Effect.uninterruptible(
      Effect.andThen(
        Effect.provideService(copyDatabaseTo(path), SqlClient.SqlClient, sql),
        setQueryOnly(sql, true),
      ),
    ),
  );

/**
 * Lets the database accept writes again after
 * {@link copyDatabaseAndStopWrites}. Does nothing when writes were not
 * stopped.
 */
export const resumeWrites = (sql: SqlClient.SqlClient): Effect.Effect<void, SqlError> =>
  holdWriter(sql, setQueryOnly(sql, false));

/**
 * Runs `effect` as one transaction, even while writes are stopped, and stops
 * writes for good once it ends, whether it commits or rolls back. Returns the
 * result of `effect`. Nothing after it writes until the process restarts,
 * unless {@link resumeWrites} is called.
 *
 * This is how a promotion seals the controller: the seal is the one write
 * allowed after the copy, and nothing may write after it. The writer is held
 * from the moment writes are allowed until they are stopped again, so no other
 * writer can use that moment.
 *
 * Behaves like `withTransaction` otherwise:
 *
 * - a failure in `effect` rolls the transaction back;
 * - the changes `effect` announced are published after the commit;
 * - the wait for the writer and `effect` can be interrupted, nothing else can.
 *
 * Unlike `withTransaction`, `effect` must not open a nested
 * `withTransaction`: it runs on a writer held outside the driver's own
 * transactions (see {@link holdWriter}).
 */
export const withFinalTransaction = <A, E, R>(
  sql: SqlClient.SqlClient,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SqlError, R> =>
  holdWriter(
    sql,
    Effect.uninterruptibleMask((restore) =>
      withAnnouncements(
        Effect.gen(function* () {
          yield* setQueryOnly(sql, false);
          yield* sql`BEGIN IMMEDIATE`;
          // A commit that fails is a defect, as it is in the driver's own
          // transactions: the database is in a state no caller can repair.
          return yield* Effect.onExit(restore(effect), (exit) =>
            Effect.orDie(Exit.isSuccess(exit) ? sql`COMMIT` : sql`ROLLBACK`),
          );
        }).pipe(Effect.ensuring(Effect.orDie(setQueryOnly(sql, true)))),
      ),
    ),
  );
