/**
 * The one SQLite database the controller owns.
 *
 * Uses `bun:sqlite` through `@effect/sql-sqlite-bun`, in WAL mode, with one
 * writer process. The driver enables WAL on open. This module checks the result
 * rather than trusting it, because a database that silently fell back to the
 * rollback journal makes every reader wait for the writer. It then locks the
 * home exclusively, so "one writer process" is enforced rather than assumed
 * (`takeExclusiveLock`).
 *
 * Transactions are ambient:
 *
 * - a caller wraps its write set in `withTransaction`;
 * - every repository call inside it uses the same transaction;
 * - a nested `withTransaction` joins the outer one through a savepoint;
 * - a failure anywhere inside rolls back the whole transaction.
 */
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { isSqlErrorReason, SqlError } from "effect/unstable/sql/SqlError";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { withAnnouncements } from "./after-commit";

/** The in-memory database name; tests open the real schema against it. */
export const MEMORY = ":memory:";

/**
 * The database file could not be opened, or a statement on it failed. The error
 * always includes the file name, because a controller that fails at boot has
 * printed nothing else yet.
 */
export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly filename: string;
  readonly message: string;
}> {}

/**
 * Returns true when an error, or anything in its cause chain, means another
 * connection held the database lock.
 *
 * The lock error is not always the outermost one: a transaction wraps the
 * statement that failed, a migration wraps the transaction, and each wrapper
 * keeps the inner error as `cause` (a `SqlError`'s cause is its reason, and a
 * reason's cause is the driver error). Checking only the outermost error would
 * lose the one message worth printing and leave a bare `database is locked`.
 *
 * Two errors count:
 *
 * - `LockTimeoutError`, which the driver raises when a statement waits out the
 *   busy timeout;
 * - a bare `database is locked` from `bun:sqlite`, which is what the driver's
 *   very first statement on a new connection fails with.
 *
 * Both mean the same thing: another controller holds the home.
 */
const wasLocked = (error: unknown): boolean => {
  const seen = new Set<unknown>();
  let value: unknown = error;
  while (typeof value === "object" && value !== null && !seen.has(value)) {
    if (isSqlErrorReason(value) && value._tag === "LockTimeoutError") return true;
    if (value instanceof Error && value.message.includes("database is locked")) return true;
    seen.add(value);
    value = (value as { readonly cause?: unknown }).cause;
  }
  return false;
};

/**
 * How long a statement waits for a lock before it gives up.
 *
 * One connection holds the home exclusively and the driver runs its statements
 * one at a time, so inside a controller there is nothing to wait for. Only a
 * second controller can hold this lock, and it will not release it soon.
 * Waiting the driver's default five seconds would only delay the error message
 * the operator needs.
 */
const BUSY_TIMEOUT = Duration.seconds(1);

/** Returns the error message for a second controller started on the same home. */
const ALREADY_OPEN = (filename: string): string =>
  `${filename} is already open by another Hercule controller. One controller serves a home; ` +
  `stop the other one and try again.`;

/**
 * Converts a driver error into a `DatabaseError` with one line of text that the
 * person running `hercule serve` can act on. A lock timeout gets its own
 * message, because the only thing that holds the lock that long is a second
 * controller on the same home.
 */
export const createDatabaseError = (filename: string, error: unknown): DatabaseError => {
  if (error instanceof DatabaseError) return error;
  if (wasLocked(error)) {
    return new DatabaseError({ filename, message: ALREADY_OPEN(filename) });
  }
  return new DatabaseError({
    filename,
    message: `Cannot use ${filename}: ${error instanceof Error ? error.message : String(error)}`,
  });
};

const configureConnection = (
  filename: string,
): Effect.Effect<void, SqlError | DatabaseError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Foreign keys are off by default in SQLite, and the setting is per
    // connection, so it has to be set on every open rather than in a migration.
    yield* sql`PRAGMA foreign_keys = ON`;
    const rows = yield* sql<{ readonly journal_mode: string }>`PRAGMA journal_mode`;
    const journalMode = rows[0]?.journal_mode ?? "unknown";
    // SQLite does not support WAL for an in-memory database, so it is exempt.
    if (filename !== MEMORY) {
      if (journalMode.toLowerCase() !== "wal") {
        return yield* new DatabaseError({
          filename,
          message: `${filename} opened in journal mode ${journalMode}; Hercule requires WAL.`,
        });
      }
      yield* takeExclusiveLock(filename);
    }
  });

/**
 * Locks the home for this process for as long as the connection lives (ADR
 * 0004: one writer process). Fails with a `DatabaseError` when another
 * controller holds the lock.
 *
 * `locking_mode = EXCLUSIVE` makes SQLite keep the file locks it acquires
 * instead of releasing them at the end of each statement, so the write below
 * leaves this connection holding the database until it is closed. A second
 * controller then cannot open the same home. The operating system holds the
 * lock, so a controller that was killed leaves nothing behind to clean up,
 * which is where a pid file or a lock file goes wrong.
 *
 * The mode takes effect only on the next lock SQLite acquires, so the empty
 * write transaction here is what actually locks the home. A second controller
 * never gets this far: the driver's own first statement on the connection
 * already needs the lock, waits out the busy timeout, and fails with the
 * message from {@link createDatabaseError}.
 */
const takeExclusiveLock = (
  filename: string,
): Effect.Effect<void, SqlError | DatabaseError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA locking_mode = EXCLUSIVE`;
    const taken = Effect.andThen(sql`BEGIN IMMEDIATE`, sql`COMMIT`);
    yield* Effect.catchTag(taken, "SqlError", (error) =>
      Effect.fail(createDatabaseError(filename, error)),
    );
  });

/**
 * Opens the database file and provides it as both `SqlClient` and the Bun
 * `SqliteClient`. Pass {@link MEMORY} for a throwaway database.
 *
 * A file that is not a SQLite database makes `bun:sqlite` throw, which would
 * reach the user as a defect with no path in it. So every failure while opening
 * is converted into a {@link DatabaseError}.
 */
export const openDatabase = (
  filename: string,
): Layer.Layer<SqlClient.SqlClient | SqliteClient.SqliteClient, DatabaseError> =>
  Layer.effectDiscard(configureConnection(filename)).pipe(
    Layer.provideMerge(SqliteClient.layer({ filename, busyTimeout: BUSY_TIMEOUT })),
    Layer.catchCause(
      (cause): Layer.Layer<SqlClient.SqlClient | SqliteClient.SqliteClient, DatabaseError> =>
        Layer.unwrap(Effect.fail(createDatabaseError(filename, Cause.squash(cause)))),
    ),
  );

/**
 * Opens a copy of the database that `copyDatabaseTo` wrote, and provides it as
 * `SqlClient`. Fails with a {@link DatabaseError} when the file cannot be opened.
 *
 * Unlike {@link openDatabase}, it keeps the copy in the rollback journal and
 * takes no exclusive lock. The copy is about to be sent or moved as one file,
 * and in WAL mode closing it would leave `-wal` and `-shm` files beside it. A
 * controller that later opens the file switches it to WAL as usual.
 */
export const openDatabaseCopy = (
  filename: string,
): Layer.Layer<SqlClient.SqlClient, DatabaseError> =>
  SqliteClient.layer({ filename, disableWAL: true }).pipe(
    Layer.catchCause((cause): Layer.Layer<SqlClient.SqlClient, DatabaseError> =>
      Layer.unwrap(Effect.fail(createDatabaseError(filename, Cause.squash(cause)))),
    ),
  );

/**
 * Runs one operation's write set in a transaction, on the client the caller
 * already holds. Nested calls join the outer transaction through a savepoint.
 *
 * A transaction never spans a wait on anything outside this process: not a
 * runner round trip, not a provider call, not an outbox delivery. SQLite has
 * one writer, so a transaction held across an external wait blocks every other
 * write in the controller. Local CPU work, such as generating a key, is fine.
 *
 * The changes the write set announced are published after the commit and
 * thrown away on a rollback (`./after-commit.ts`).
 *
 * Only the write set can be interrupted. An interrupt that arrives during it
 * rolls the transaction back. One that arrives later, such as a client that
 * hangs up while the transaction commits, takes effect once the after-commit
 * work has run: the write is durable by then, and dropping that work would
 * leave the controller's memory and every live screen out of step with the
 * database.
 */
export const withTransaction = <A, E, R>(
  sql: SqlClient.SqlClient,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SqlError, R> =>
  Effect.uninterruptibleMask((restore) => withAnnouncements(sql.withTransaction(restore(effect))));
