/**
 * The one SQLite database the controller owns.
 *
 * `bun:sqlite` through `@effect/sql-sqlite-bun`, WAL, one writer process. The
 * driver enables WAL on open; this module asserts the result rather than
 * trusting it, because a database that silently fell back to the rollback
 * journal serializes every reader behind the writer. It then takes the home
 * exclusively, so "one writer process" is enforced rather than assumed
 * (`takeTheHome`).
 *
 * Transactions are ambient: a caller wraps its write set in `withTransaction`,
 * every repository call inside sees the same transaction, a nested
 * `withTransaction` joins the outer one through a savepoint, and a failure
 * anywhere inside rolls the whole thing back.
 */
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { isSqlErrorReason, SqlError } from "effect/unstable/sql/SqlError";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";

/** The in-memory database name; tests open the real schema against it. */
export const MEMORY = ":memory:";

/**
 * The database file could not be opened, or refused a statement. Always names
 * the file, because a controller failing at boot has said nothing else yet.
 */
export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly filename: string;
  readonly message: string;
}> {}

/**
 * One line for whatever the driver said, in the terms of the person running
 * `hydra serve`.
 *
 * A lock timeout is the interesting case: SQLite has one writer, the driver
 * waits five seconds for it, and the only thing that holds it that long is a
 * second controller on the same home.
 */
/**
 * True when the database was locked by someone else, anywhere in an error's
 * cause chain.
 *
 * The lock is not always the outermost reason: a transaction wraps the
 * statement that failed, a migration wraps the transaction, and each wrapper
 * keeps what it wrapped as `cause` (a `SqlError`'s cause is its reason, a
 * reason's cause is the driver error). Reading only the top-level reason turns
 * the one message worth printing into `database is locked`.
 *
 * Two shapes count. The driver raises `LockTimeoutError` when it waits out its
 * busy timeout on a statement of its own; the very first statement of an open,
 * which the driver runs before Hydra sees the connection, comes back as a bare
 * `database is locked` from `bun:sqlite` instead. Both mean the same thing:
 * another controller holds the home.
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
 * one at a time, so inside a controller there is nothing to wait for. The only
 * thing that can hold this lock is a second controller, and that one is not
 * going away: waiting the driver's default five seconds would only delay the
 * line the operator needs.
 */
const BUSY_TIMEOUT = Duration.seconds(1);

/** What a second controller on the same home is told. */
const ALREADY_OPEN = (filename: string): string =>
  `${filename} is already open by another Hydra controller. One controller serves a home; ` +
  `stop the other one and try again.`;

export const databaseError = (filename: string, error: unknown): DatabaseError => {
  if (error instanceof DatabaseError) return error;
  if (wasLocked(error)) {
    return new DatabaseError({ filename, message: ALREADY_OPEN(filename) });
  }
  return new DatabaseError({
    filename,
    message: `Cannot use ${filename}: ${error instanceof Error ? error.message : String(error)}`,
  });
};

const configure = (
  filename: string,
): Effect.Effect<void, SqlError | DatabaseError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Off by default in SQLite, and a per-connection setting, so it has to be
    // set on every open rather than recorded in a migration.
    yield* sql`PRAGMA foreign_keys = ON`;
    const rows = yield* sql<{ readonly journal_mode: string }>`PRAGMA journal_mode`;
    const journalMode = rows[0]?.journal_mode ?? "unknown";
    // SQLite refuses WAL for an in-memory database, which is why it is exempt.
    if (filename !== MEMORY) {
      if (journalMode.toLowerCase() !== "wal") {
        return yield* new DatabaseError({
          filename,
          message: `${filename} opened in journal mode ${journalMode}; Hydra requires WAL.`,
        });
      }
      yield* takeTheHome(filename);
    }
  });

/**
 * Takes the home for this process, for as long as the connection lives (ADR
 * 0004: one writer process).
 *
 * `locking_mode = EXCLUSIVE` makes SQLite keep the file locks it acquires
 * instead of dropping them at the end of each statement, so the first write
 * below leaves this connection holding the database until it is closed. A
 * second controller then cannot open the same home, and it is the operating
 * system that holds the lock: a controller that was killed leaves nothing
 * behind to clean up, which is the failure a pid file or a lock file gets
 * wrong.
 *
 * The mode is lazy - it takes effect on the next lock SQLite acquires - so the
 * empty write transaction here is what actually takes the home. A second
 * controller does not get this far: the driver's own first statement on the
 * connection already needs a lock this one holds, waits out the busy timeout
 * and fails with {@link databaseError}'s one line.
 */
const takeTheHome = (
  filename: string,
): Effect.Effect<void, SqlError | DatabaseError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA locking_mode = EXCLUSIVE`;
    const taken = Effect.andThen(sql`BEGIN IMMEDIATE`, sql`COMMIT`);
    yield* Effect.catchTag(taken, "SqlError", (error) =>
      Effect.fail(databaseError(filename, error)),
    );
  });

/**
 * Opens the database file and provides it as both `SqlClient` and the Bun
 * `SqliteClient`. Pass {@link MEMORY} for a throwaway database.
 *
 * A file that is not a SQLite database makes `bun:sqlite` throw, which would
 * otherwise reach the user as a defect with no path in it, so the whole open is
 * turned into a {@link DatabaseError}.
 */
export const openDatabase = (
  filename: string,
): Layer.Layer<SqlClient.SqlClient | SqliteClient.SqliteClient, DatabaseError> =>
  Layer.effectDiscard(configure(filename)).pipe(
    Layer.provideMerge(SqliteClient.layer({ filename, busyTimeout: BUSY_TIMEOUT })),
    Layer.catchCause(
      (cause): Layer.Layer<SqlClient.SqlClient | SqliteClient.SqliteClient, DatabaseError> =>
        Layer.unwrap(Effect.fail(databaseError(filename, Cause.squash(cause)))),
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
 */
export const withTransaction = <A, E, R>(
  sql: SqlClient.SqlClient,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SqlError, R> => sql.withTransaction(effect);
