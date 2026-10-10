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
 * The setting belongs to the connection, not to the file. The controller has
 * exactly one connection, so it covers every writer in the process, and a
 * restart opens a new connection that starts writable.
 *
 * The functions here hold that one connection while they work. Every other
 * statement in the process waits until they are done, so no write can run
 * between the copy and the stop, or slip into the one transaction allowed
 * while writes are stopped.
 */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { withAnnouncements } from "./after-commit";
import { copyDatabaseTo } from "./migrate";

/**
 * Runs `effect` while holding the controller's one connection, and returns
 * its result. Every statement `effect` runs through `sql` uses that
 * connection, and statements on other fibers wait until `effect` ends.
 *
 * The driver lends the held connection to statements through its transaction
 * service, the same way it does inside `withTransaction`. `effect` must not
 * call `withTransaction` itself: the driver would take the held connection
 * for an outer transaction that was never begun, and fail.
 */
const holdConnection = <A, E, R>(
  sql: SqlClient.SqlClient,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SqlError, R> =>
  Effect.scoped(
    Effect.flatMap(sql.reserve, (connection) =>
      Effect.provideService(effect, sql.transactionService, [connection, 0]),
    ),
  );

/**
 * Stops every write on the connection, until {@link resumeWrites} or a
 * restart. A controller that boots sealed calls it once its boot is done.
 */
export const stopWrites = (sql: SqlClient.SqlClient): Effect.Effect<void, SqlError> =>
  Effect.asVoid(sql`PRAGMA query_only = ON`);

/**
 * Copies the database to `path` with `VACUUM INTO`, then stops every write
 * to it until {@link resumeWrites}. Fails with a `SqlError` when the copy
 * fails, and then leaves writes allowed.
 *
 * The copy comes first because `VACUUM INTO` is refused once writes are
 * stopped. Both run while the connection is held, so no other statement can
 * write between them, and the copy holds every write the database ever
 * accepts until writes resume. The two steps cannot be interrupted apart.
 */
export const copyDatabaseAndStopWrites = (
  sql: SqlClient.SqlClient,
  path: string,
): Effect.Effect<void, SqlError> =>
  Effect.uninterruptible(
    holdConnection(
      sql,
      Effect.andThen(
        Effect.provideService(copyDatabaseTo(path), SqlClient.SqlClient, sql),
        stopWrites(sql),
      ),
    ),
  );

/**
 * Lets the database accept writes again after
 * {@link copyDatabaseAndStopWrites}. Does nothing when writes were not
 * stopped.
 */
export const resumeWrites = (sql: SqlClient.SqlClient): Effect.Effect<void, SqlError> =>
  Effect.asVoid(sql`PRAGMA query_only = OFF`);

/**
 * Runs `effect` as one transaction, even while writes are stopped, and stops
 * writes for good once it ends, whether it commits or rolls back. Returns the
 * result of `effect`. Nothing after it writes until the process restarts,
 * unless {@link resumeWrites} is called.
 *
 * This is how a promotion seals the controller: the seal is the one write
 * allowed after the copy, and nothing may write after it. The connection is
 * held from the moment writes are allowed until they are stopped again, so
 * no other writer can use that moment.
 *
 * Behaves like `withTransaction` otherwise:
 *
 * - a failure in `effect` rolls the transaction back;
 * - the changes `effect` announced are published after the commit;
 * - only `effect` can be interrupted.
 *
 * Unlike `withTransaction`, `effect` must not open a nested
 * `withTransaction`: it runs on a connection held outside the driver's own
 * transactions (see `holdConnection`).
 */
export const withFinalTransaction = <A, E, R>(
  sql: SqlClient.SqlClient,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SqlError, R> =>
  Effect.uninterruptibleMask((restore) =>
    withAnnouncements(
      holdConnection(
        sql,
        Effect.gen(function* () {
          yield* resumeWrites(sql);
          yield* sql`BEGIN IMMEDIATE`;
          // A commit that fails is a defect, as it is in the driver's own
          // transactions: the database is in a state no caller can repair.
          return yield* Effect.onExit(restore(effect), (exit) =>
            Effect.orDie(Exit.isSuccess(exit) ? sql`COMMIT` : sql`ROLLBACK`),
          );
        }).pipe(Effect.ensuring(Effect.orDie(stopWrites(sql)))),
      ),
    ),
  );
