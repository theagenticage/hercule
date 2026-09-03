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
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";

/** The in-memory database name; tests open the real schema against it (spec 04). */
export const MEMORY = ":memory:";

/**
 * The database opened in a journal mode other than WAL. SQLite refuses WAL for
 * an in-memory database, which is why {@link MEMORY} is exempt.
 */
export class JournalModeError extends Data.TaggedError("JournalModeError")<{
  readonly filename: string;
  readonly journalMode: string;
  readonly message: string;
}> {}

const configure = (
  filename: string,
): Effect.Effect<void, SqlError | JournalModeError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Off by default in SQLite, and a per-connection setting, so it has to be
    // set on every open rather than recorded in a migration.
    yield* sql`PRAGMA foreign_keys = ON`;
    const rows = yield* sql<{ readonly journal_mode: string }>`PRAGMA journal_mode`;
    const journalMode = rows[0]?.journal_mode ?? "unknown";
    if (filename !== MEMORY && journalMode.toLowerCase() !== "wal") {
      return yield* new JournalModeError({
        filename,
        journalMode,
        message: `${filename} opened in journal mode ${journalMode}; Hydra requires WAL (spec 04).`,
      });
    }
  });

/**
 * Opens the database file and provides it as both `SqlClient` and the Bun
 * `SqliteClient`. Pass {@link MEMORY} for a throwaway database.
 */
export const openDatabase = (
  filename: string,
): Layer.Layer<SqlClient.SqlClient | SqliteClient.SqliteClient, SqlError | JournalModeError> =>
  Layer.effectDiscard(configure(filename)).pipe(
    Layer.provideMerge(SqliteClient.layer({ filename })),
  );

/**
 * Runs one operation's write set in a transaction. Nested calls join the outer
 * transaction through a savepoint.
 *
 * A transaction never spans a wait on anything outside the database: not a
 * runner round trip, not a provider call, not an outbox delivery. SQLite has
 * one writer, so a transaction held across an external wait blocks every other
 * write in the controller.
 */
export const withTransaction = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SqlError, R | SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(effect);
  });
