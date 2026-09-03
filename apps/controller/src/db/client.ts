/**
 * The one SQLite database the controller owns (spec 04, ADR 0004).
 *
 * `bun:sqlite` through `@effect/sql-sqlite-bun`, WAL, one writer process. The
 * driver enables WAL and a five-second busy timeout on open; this module
 * asserts the result rather than trusting it, because a database that silently
 * fell back to the rollback journal serializes every reader behind the writer.
 *
 * Transactions are ambient: a caller wraps its write set in `withTransaction`,
 * every repository call inside sees the same transaction, a nested
 * `withTransaction` joins the outer one through a savepoint, and a failure
 * anywhere inside rolls the whole thing back.
 */
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlError } from "effect/unstable/sql/SqlError";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";

/** The in-memory database name; tests open the real schema against it (spec 04). */
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
 * second controller on the same home (ADR 0004).
 */
export const databaseError = (filename: string, error: unknown): DatabaseError => {
  if (error instanceof DatabaseError) return error;
  if (error instanceof SqlError && error.reason._tag === "LockTimeoutError") {
    return new DatabaseError({
      filename,
      message:
        `${filename} stayed locked by another writer. Another Hydra controller is probably ` +
        `running on this home; stop it and try again.`,
    });
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
    if (filename !== MEMORY && journalMode.toLowerCase() !== "wal") {
      return yield* new DatabaseError({
        filename,
        message: `${filename} opened in journal mode ${journalMode}; Hydra requires WAL (spec 04).`,
      });
    }
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
    Layer.provideMerge(SqliteClient.layer({ filename })),
    Layer.catchCause(
      (cause): Layer.Layer<SqlClient.SqlClient | SqliteClient.SqliteClient, DatabaseError> =>
        Layer.unwrap(Effect.fail(databaseError(filename, Cause.squash(cause)))),
    ),
  );

/**
 * Runs one operation's write set in a transaction. Nested calls join the outer
 * transaction through a savepoint.
 *
 * A transaction never spans a wait on anything outside this process: not a
 * runner round trip, not a provider call, not an outbox delivery. SQLite has
 * one writer, so a transaction held across an external wait blocks every other
 * write in the controller. Local CPU work, such as generating a key, is fine.
 */
export const withTransaction = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SqlError, R | SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(effect);
  });
