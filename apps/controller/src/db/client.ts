/**
 * The one SQLite database the controller owns.
 *
 * Uses `bun:sqlite` through `@effect/sql-sqlite-bun`, in WAL mode. The
 * controller opens two connections to the one file and exposes them as the
 * single `SqlClient` every repository uses:
 *
 * - **The writer** is a normal read-write connection. It serves every
 *   `withTransaction` and nothing else once the controller is up. Migrations
 *   run on it before the reader exists.
 * - **The reader** is opened with `readonly: true`. It serves every statement
 *   that runs outside a transaction. In WAL mode it never waits for the writer,
 *   and it sees only committed rows. A write outside a transaction reaches the
 *   reader and fails with `attempt to write a readonly database`, so a write
 *   outside a transaction fails. One gap: a fiber forked inside a transaction
 *   keeps the writer in its context, so a write it makes after the transaction
 *   has ended still runs on the writer, outside any transaction.
 *
 * A third, tiny database, the controller lock file, makes sure only one
 * controller runs per Data Root (`takeControllerLock`). It cannot be the
 * database itself: an exclusive lock on the database would lock out the reader
 * too.
 *
 * Because the writer is one connection, writers queue. The queue is Hercule's
 * own one-permit gate in front of the writer (see {@link withTransaction}), so
 * that a transaction waiting for the writer can be interrupted.
 *
 * Transactions are ambient:
 *
 * - a caller wraps its write set in `withTransaction`;
 * - every repository call inside it uses the same transaction;
 * - a nested `withTransaction` joins the outer one through a savepoint;
 * - a failure anywhere inside rolls back the whole transaction.
 */
import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlError } from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { withAnnouncements } from "./after-commit";

/**
 * The database file could not be opened, or a statement on it failed. The error
 * always includes the file name, because a controller that fails at boot has
 * printed nothing else yet.
 */
export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly filename: string;
  readonly message: string;
}> {}

/** The two files that make up a controller's database: the data and the lock. */
export interface DatabaseFiles {
  readonly databaseFile: string;
  readonly controllerLockFile: string;
}

/**
 * Returns the messages of an error and of each error it wraps, outermost first,
 * without repeats. A failed statement arrives as a `SqlError` whose own message
 * is only "Failed to execute statement"; the reason, such as "attempt to write
 * a readonly database", sits in the errors it wraps.
 */
const collectMessages = (error: unknown): ReadonlyArray<string> => {
  const messages: Array<string> = [];
  let current: unknown = error;
  while (current instanceof Error && messages.length < 8) {
    if (!messages.includes(current.message)) messages.push(current.message);
    current = current.cause;
  }
  return messages.length === 0 ? [String(error)] : messages;
};

/**
 * Returns true when an error, or an error it wraps, is SQLite's "database is
 * locked": another connection holds a lock this one needs.
 */
const wasLocked = (error: unknown): boolean =>
  collectMessages(error).some((message) => message.includes("database is locked"));

/**
 * How long a statement waits for a lock before it gives up.
 *
 * Nothing inside one controller should wait for a lock: the writer is the only
 * connection that writes, writers queue in the gate before they reach it, and
 * the reader does not take locks that block the writer. The timeout covers the
 * rare moment when the reader meets a WAL checkpoint, which holds a lock for a
 * few milliseconds. It is short so that anything else surfaces as an error
 * instead of as a hang.
 */
const BUSY_TIMEOUT = Duration.seconds(1);

/**
 * Returns the message for a controller lock file that another process holds.
 * It names the Data Root and says how to find the process. It deliberately
 * does not suggest deleting the lock file: that does not stop the process that
 * holds the lock, and a second controller on the same database corrupts it.
 */
const describeLockHeld = (lockFile: string): string =>
  `${lockFile} is already open by another Hercule process: a controller, or a ` +
  `\`hercule promote\` receiving data into the Data Root ${dirname(lockFile)}. ` +
  `Stop that process first. \`hercule service status\` shows a controller that runs as a ` +
  `service; otherwise look for it with \`ps\`. Do not delete controller.lock: it does not ` +
  `stop that process, and a second controller on the same database would corrupt it.`;

/**
 * Converts a driver error into a `DatabaseError` with one line of text that the
 * person running `hercule serve` can act on. Returns a `DatabaseError`
 * unchanged. The line includes the message of every error the driver error
 * wraps, so the reason a statement failed is not lost.
 *
 * A "locked" error is not reported as another controller: the controller lock
 * is taken first, so by the time the database is locked, the holder is a
 * program that does not know the lock file (an older Hercule, another SQLite
 * tool). Only {@link takeControllerLock} can tell that another controller runs.
 */
export const createDatabaseError = (filename: string, error: unknown): DatabaseError => {
  if (error instanceof DatabaseError) return error;
  if (wasLocked(error)) {
    return new DatabaseError({
      filename,
      message:
        `${filename} is locked by another program, most likely an older Hercule version or ` +
        `another SQLite tool that has the database open. Stop it and try again.`,
    });
  }
  return new DatabaseError({
    filename,
    message: `Cannot use ${filename}: ${collectMessages(error).join(": ")}`,
  });
};

/**
 * Takes an exclusive SQLite lock on `file` until the scope closes. Fails with
 * whatever `describeFailure` returns for the error that stopped it.
 *
 * `locking_mode = EXCLUSIVE` makes SQLite keep the file locks it takes instead
 * of releasing them at the end of each transaction, and it locks out every
 * other connection, a read-only one included. The mode takes effect only on the
 * next lock SQLite takes, so the empty `BEGIN IMMEDIATE; COMMIT` is what
 * actually takes the lock. A second taker fails on its first statement or on
 * `BEGIN IMMEDIATE`, with no busy timeout, so it is refused at once. The
 * journal is kept in memory so that no `-journal` file appears beside `file`.
 * (Only the WAL setting is stored in a database file, so `journal_mode =
 * MEMORY` leaves a file in the rollback journal as it was.)
 *
 * The operating system holds the lock, so a process that was killed leaves
 * nothing behind to clean up, which is where a pid file goes wrong.
 */
const holdExclusiveLock = (
  file: string,
  describeFailure: (error: unknown) => DatabaseError,
): Effect.Effect<void, DatabaseError, Scope.Scope> =>
  Effect.asVoid(
    Effect.acquireRelease(
      Effect.try({
        try: () => {
          const lock = new Database(file, { create: true, readwrite: true });
          try {
            lock.run("PRAGMA journal_mode = MEMORY");
            lock.run("PRAGMA locking_mode = EXCLUSIVE");
            lock.run("BEGIN IMMEDIATE");
            lock.run("COMMIT");
          } catch (error) {
            lock.close();
            throw error;
          }
          return lock;
        },
        catch: describeFailure,
      }),
      (lock) => Effect.sync(() => lock.close()),
    ),
  );

/**
 * Locks the Data Root for this process until the scope closes (ADR 0004: one
 * controller per Data Root). Fails with a `DatabaseError` when another process
 * holds the lock, with a message that names a second controller or a
 * promotion, and when the lock file is not a SQLite file.
 *
 * The lock file is its own tiny SQLite database, never the data file. The
 * exclusive lock would lock out the controller's own read-only reader if it
 * were on the data file (see {@link holdExclusiveLock}).
 */
export const takeControllerLock = (
  lockFile: string,
): Effect.Effect<void, DatabaseError, Scope.Scope> =>
  holdExclusiveLock(lockFile, (error) => {
    if (wasLocked(error)) {
      return new DatabaseError({ filename: lockFile, message: describeLockHeld(lockFile) });
    }
    if (collectMessages(error).some((message) => message.includes("file is not a database"))) {
      return new DatabaseError({
        filename: lockFile,
        message:
          `${lockFile} is damaged: it is not a SQLite file. It holds no data. If no Hercule ` +
          `process is running on the Data Root ${dirname(lockFile)}, delete it and try again.`,
      });
    }
    return createDatabaseError(lockFile, error);
  });

/**
 * Takes the exclusive SQLite lock on the data file itself until the scope
 * closes, the way a controller held it before the controller lock file
 * existed. Fails with a `DatabaseError` when another process has the file
 * open.
 *
 * A promotion that receives data holds this lock on the file it is building,
 * so that a controller of an older version, which knows only this lock, cannot
 * start on a Home that is being filled.
 */
export const lockDatabaseFile = (
  databaseFile: string,
): Effect.Effect<void, DatabaseError, Scope.Scope> =>
  holdExclusiveLock(databaseFile, (error) =>
    wasLocked(error)
      ? new DatabaseError({
          filename: databaseFile,
          message: `${databaseFile} is already open by another process. Stop it and try again.`,
        })
      : createDatabaseError(databaseFile, error),
  );

/**
 * The gate in front of each client's writer, by client. Only this module
 * builds clients that have one; a client from elsewhere (`openDatabaseCopy`, or
 * a copy of a client made by spreading it) has no gate and goes straight to its
 * connection. A map keeps the gate out of the public `SqlClient` type.
 */
const writerGates = new WeakMap<SqlClient.SqlClient, Semaphore.Semaphore>();

/**
 * Builds the `SqlClient` the repositories use, over a writer and a way to
 * reach the reader, and registers its writer gate.
 *
 * - Statements outside a transaction run on `reads`.
 * - Transactions run on the writer.
 * - A transaction begins with a plain `BEGIN`, not the driver's `BEGIN
 *   IMMEDIATE`. `BEGIN IMMEDIATE` takes the write lock up front so that a
 *   transaction that reads first never waits for another writer when it
 *   writes. Here no other writer exists. And while a promotion has stopped
 *   writes (`./writes.ts`), SQLite refuses `BEGIN IMMEDIATE` but accepts
 *   `BEGIN`, so a transaction that only reads still works then, and one that
 *   writes still fails at its first write.
 */
const buildClient = (
  writer: SqliteClient.SqliteClient,
  reads: SqliteClient.SqliteClient["reserve"],
): Effect.Effect<SqlClient.SqlClient, never, Reactivity.Reactivity> =>
  Effect.map(
    SqlClient.make({
      acquirer: reads,
      transactionAcquirer: writer.reserve,
      compiler: Statement.makeCompilerSqlite(),
      beginTransaction: "BEGIN",
      spanAttributes: [["db.system.name", "sqlite"]],
    }),
    (sql) => {
      writerGates.set(sql, Semaphore.makeUnsafe(1));
      return sql;
    },
  );

/**
 * Opens the writer: takes the controller lock, opens the read-write
 * connection, and checks it. Fails with a `DatabaseError`; the connection and
 * the lock are released when the scope closes.
 *
 * A file that is not a SQLite database makes `bun:sqlite` throw, which would
 * reach the user as a defect with no path in it. So every failure while opening
 * is converted into a {@link DatabaseError}.
 */
const openWriter = (
  files: DatabaseFiles,
): Effect.Effect<SqliteClient.SqliteClient, DatabaseError, Scope.Scope | Reactivity.Reactivity> =>
  Effect.gen(function* () {
    yield* takeControllerLock(files.controllerLockFile);
    const writer = yield* SqliteClient.make({
      filename: files.databaseFile,
      busyTimeout: BUSY_TIMEOUT,
    });
    // Foreign keys are off by default in SQLite, and the setting is per
    // connection, so it is set on every open rather than in a migration.
    yield* writer`PRAGMA foreign_keys = ON`;
    // The driver enables WAL on open. The result is checked rather than
    // trusted, because a database that silently fell back to the rollback
    // journal makes every reader wait for the writer.
    const modeRows = yield* writer<{ readonly journal_mode: string }>`PRAGMA journal_mode`;
    const journalMode = modeRows[0]?.journal_mode ?? "unknown";
    if (journalMode.toLowerCase() !== "wal") {
      return yield* new DatabaseError({
        filename: files.databaseFile,
        message: `${files.databaseFile} opened in journal mode ${journalMode}; Hercule requires WAL.`,
      });
    }
    // On a new file the WAL setting is not stored, and the `-wal` and `-shm`
    // files do not exist, until the first write. The read-only connection
    // cannot open a file in that state. Writing `user_version` back as it is
    // makes that first write, and changes nothing.
    const versionRows = yield* writer<{ readonly user_version: number }>`PRAGMA user_version`;
    yield* writer.unsafe(`PRAGMA user_version = ${versionRows[0]?.user_version ?? 0}`);
    return writer;
  }).pipe(
    Effect.catchDefect((defect) => Effect.fail(createDatabaseError(files.databaseFile, defect))),
    Effect.catchTag("SqlError", (error) =>
      Effect.fail(createDatabaseError(files.databaseFile, error)),
    ),
  );

/**
 * Opens only the writer and provides it as `SqlClient`: the lock, the
 * read-write connection and the WAL check, with no reader. Every statement,
 * inside a transaction or not, runs on the writer. Fails with a
 * `DatabaseError`.
 *
 * This is the client that migrations run on, because the Effect migrator
 * creates its bookkeeping table outside a transaction, and on the full client
 * that statement would reach the read-only connection.
 */
export const openDatabaseWriter = (
  files: DatabaseFiles,
): Layer.Layer<SqlClient.SqlClient, DatabaseError> =>
  Layer.effect(SqlClient.SqlClient)(
    Effect.flatMap(openWriter(files), (writer) => buildClient(writer, writer.reserve)),
  ).pipe(Layer.provide(Reactivity.layer));

/**
 * Opens the database and provides it as `SqlClient`: the lock, the writer, the
 * read-only reader, and the combined client over both.
 *
 * Boot order:
 *
 * 1. take the controller lock;
 * 2. open the writer, set `foreign_keys` on it, and check WAL;
 * 3. run `setUp` on a client that has only the writer, so migrations create
 *    their bookkeeping table on a writable connection. Its errors reach the
 *    caller as themselves;
 * 4. open the reader, after the schema exists and the WAL files are written;
 * 5. build the combined client.
 *
 * Fails with a {@link DatabaseError} when a file cannot be opened, or with
 * whatever `setUp` fails with.
 */
export const openDatabase = <E = never, R = never>(
  files: DatabaseFiles,
  setUp?: Effect.Effect<unknown, E, R>,
): Layer.Layer<SqlClient.SqlClient, DatabaseError | E, Exclude<R, SqlClient.SqlClient>> =>
  Layer.effect(SqlClient.SqlClient)(
    Effect.gen(function* () {
      const writer = yield* openWriter(files);
      if (setUp !== undefined) {
        const writerOnly = yield* buildClient(writer, writer.reserve);
        yield* Effect.provideService(setUp, SqlClient.SqlClient, writerOnly);
      }
      const reader = yield* SqliteClient.make({
        filename: files.databaseFile,
        readonly: true,
        busyTimeout: BUSY_TIMEOUT,
      }).pipe(
        Effect.catchDefect((defect) =>
          Effect.fail(createDatabaseError(files.databaseFile, defect)),
        ),
      );
      return yield* buildClient(writer, reader.reserve);
    }),
  ).pipe(Layer.provide(Reactivity.layer));

/**
 * Opens a copy of the database that `copyDatabaseTo` wrote, and provides it as
 * `SqlClient`. Fails with a {@link DatabaseError} when the file cannot be opened.
 *
 * Unlike {@link openDatabase}, it keeps the copy in the rollback journal, takes
 * no controller lock, and has one connection. The copy is about to be sent or
 * moved as one file, and in WAL mode closing it would leave `-wal` and `-shm`
 * files beside it. A controller that later opens the file switches it to WAL as
 * usual.
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
 * Runs `effect` while holding the writer, and returns its result. Every
 * statement `effect` runs through `sql` uses the writer, and transactions on
 * other fibers wait until `effect` ends. The wait for the writer can be
 * interrupted exactly when the caller can be. A client without a writer gate (a
 * copy) runs `effect` at once.
 *
 * The writer is lent to statements through the client's transaction service.
 * `effect` must not call `withTransaction`: the held writer looks like an open
 * transaction, so `withTransaction` tries to join it with a savepoint, finds no
 * transaction was begun, and fails with `Service not found:
 * effect/sql/SqlClient/TransactionSemaphore/N`. `withFinalTransaction`
 * (`./writes.ts`) begins its own transaction instead.
 */
export const holdWriter = <A, E, R>(
  sql: SqlClient.SqlClient,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SqlError, R> => {
  const reserved = Effect.scoped(
    Effect.flatMap(sql.reserve, (connection) =>
      Effect.provideService(effect, sql.transactionService, [connection, 0]),
    ),
  );
  const gate = writerGates.get(sql);
  return gate === undefined ? reserved : gate.withPermit(reserved);
};

/**
 * Takes the gate's one permit and returns once the caller has it. The caller
 * must give it back with `gate.release(1)`.
 *
 * Only the wait for a free permit runs in the caller's own interruptibility
 * (`restore`). The permit is taken in the same uninterruptible step that sees it
 * is free, as Effect's own `withPermit` does. Calling `restore(gate.take(1))`
 * instead would leave a gap after the permit is taken in which an interrupt
 * could still land, and the permit would never be given back.
 */
const takeWriterGate = (
  gate: Semaphore.Semaphore,
  restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
): Effect.Effect<void> =>
  Effect.flatMap(gate.takeIfAvailable(1), (taken) =>
    taken
      ? Effect.void
      : Effect.flatMap(restore(gate.withPermit(Effect.void)), () => takeWriterGate(gate, restore)),
  );

/**
 * Runs one operation's write set in a transaction, on the client the caller
 * already holds. Nested calls join the outer transaction through a savepoint.
 *
 * A transaction waits on nothing but the database and short local computation.
 * A runner, the network, a plugin, a subprocess, the filesystem and a timer are
 * all excluded. With one writer, this rule is what keeps the writer free: a
 * transaction held across any of those waits blocks every other write in the
 * controller.
 *
 * The changes the write set announced are published after the commit and
 * thrown away on a rollback (`./after-commit.ts`).
 *
 * Interrupts:
 *
 * - The wait for the writer can be interrupted when the caller can be, and an
 *   interrupted waiter gives nothing up: it never held the writer. A caller
 *   inside `Effect.uninterruptible` is not abandoned; it waits its turn.
 * - An interrupt during the write set rolls the transaction back.
 * - An interrupt that arrives once the commit starts takes effect after the
 *   after-commit work has run, such as a client that hangs up while the
 *   transaction commits. The write is durable by then, and dropping that work
 *   would leave the controller's memory and every live screen out of step with
 *   the database.
 * - The writer is given back as soon as the commit (or rollback) is done, and
 *   the after-commit work runs after that, so a slow listener does not hold up
 *   the next write. Two transactions can therefore announce in either order.
 *
 * Upstream bug that the gate works around: Effect's `makeWithTransaction`
 * (`effect/unstable/sql/SqlClient`) acquires the connection inside
 * `Effect.uninterruptibleMask` without restoring it, so the driver's own wait
 * for the connection restores to "uninterruptible", and a transaction queued
 * behind another cannot be interrupted. It is present in 4.0.0-rc.112 through
 * 4.0.5 and is reported upstream as
 * https://github.com/Effect-TS/effect/issues/9514. In 4.0.5 the module moved
 * from `effect/unstable/sql/SqlClient` to `effect/sql/SqlClient`. The gate
 * waits first, in the caller's own interruptibility, so by the time Effect asks
 * the driver for the writer it is free. The interruptible wait can go once
 * Effect ships a fix; the gate itself stays, because
 * {@link holdWriter} uses it too. Only the wait for the gate is interruptible:
 * the permit itself is taken inside the uninterruptible region and released by
 * a finalizer, so no interrupt can land between taking it and the code that
 * gives it back (see {@link takeWriterGate}).
 */
export const withTransaction = <A, E, R>(
  sql: SqlClient.SqlClient,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SqlError, R> =>
  Effect.uninterruptibleMask((restore) => {
    const transaction = sql.withTransaction(restore(effect));
    const gate = writerGates.get(sql);
    return withAnnouncements(
      Effect.flatMap(
        Effect.serviceOption(sql.transactionService),
        Option.match({
          // Already inside a transaction, or holding the writer: this call holds
          // the gate's permit through its caller, so taking it again would wait on
          // itself forever. It joins through a savepoint instead.
          onSome: () => transaction,
          onNone: () =>
            gate === undefined
              ? transaction
              : // Only the wait for the permit is restored to the caller's
                // interruptibility. The permit is released as soon as the commit
                // is done, before the after-commit work runs.
                Effect.acquireUseRelease(
                  takeWriterGate(gate, restore),
                  () => transaction,
                  () => Effect.asVoid(gate.release(1)),
                ),
        }),
      ),
    );
  });
