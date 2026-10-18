import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { AfterCommit, afterCommit, announce } from "./after-commit";
import {
  createDatabaseError,
  holdWriter,
  openDatabase,
  openDatabaseWriter,
  lockDatabaseFile,
  takeControllerLock,
  withTransaction,
  type DatabaseFiles,
} from "./client";

let home: string;
let files: DatabaseFiles;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hercule-db-"));
  files = {
    databaseFile: join(home, "hercule.db"),
    controllerLockFile: join(home, "controller.lock"),
  };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Creates the small schema these tests use, on the writer, as a migration would. */
const createSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE parent (id INTEGER PRIMARY KEY)`;
  yield* sql`CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent (id))`;
});

/** The database of a test: both connections, with the small schema in place. */
const database = (): Layer.Layer<SqlClient.SqlClient, unknown> => openDatabase(files, createSchema);

/** Runs a program against a fresh database in the test's temporary folder. */
const run = <A, E>(program: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(program, database()));

const insert = (sql: SqlClient.SqlClient, v: number) => sql`INSERT INTO t (v) VALUES (${v})`;

const countRows = (sql: SqlClient.SqlClient, v?: number) =>
  Effect.map(
    v === undefined
      ? sql<{ readonly n: number }>`SELECT count(*) AS n FROM t`
      : sql<{ readonly n: number }>`SELECT count(*) AS n FROM t WHERE v = ${v}`,
    (rows) => rows[0]?.n ?? -1,
  );

/**
 * Starts a transaction on its own fiber that inserts `v`, signals `started`,
 * and stays open until `release` is completed. Returns once the transaction
 * has started.
 */
const openHolder = (sql: SqlClient.SqlClient, v: number, release: Deferred.Deferred<void>) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const holder = yield* Effect.forkChild(
      withTransaction(
        sql,
        Effect.gen(function* () {
          yield* insert(sql, v);
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
        }),
      ),
    );
    yield* Deferred.await(started);
    return holder;
  });

describe("createDatabaseError", () => {
  it("reports the file it could not use", async () => {
    const error = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`SELECT * FROM absent`;
      }).pipe(Effect.flip),
    );
    expect(createDatabaseError(files.databaseFile, error).message).toContain(
      `Cannot use ${files.databaseFile}`,
    );
  });

  it("includes the reason a statement failed, not only that it failed", async () => {
    const error = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE written_outside_a_transaction (id INTEGER)`;
      }).pipe(Effect.flip),
    );
    expect(createDatabaseError(files.databaseFile, error).message).toContain(
      "attempt to write a readonly database",
    );
  });

  it("blames another program, not another controller, for a locked database", () => {
    // Once the controller lock is held, a locked database cannot mean a second
    // controller: it is a program that does not know the lock file.
    const message = createDatabaseError(
      files.databaseFile,
      new Error("database is locked"),
    ).message;
    expect(message).toContain("locked by another program");
    expect(message).toContain("older Hercule version");
    expect(message).not.toContain("another Hercule process");
  });
});

describe("the controller lock", () => {
  it("refuses a second taker while the first holds it, and frees it when the scope closes", async () => {
    const attempt = takeControllerLock(files.controllerLockFile);
    const program = Effect.gen(function* () {
      const first = yield* Scope.make();
      yield* Scope.provide(attempt, first);

      const refused = yield* Effect.flip(Effect.scoped(attempt));
      expect(refused.message).toContain("already open by another Hercule process");
      expect(refused.message).toContain(home);
      expect(refused.message).toContain("Do not delete controller.lock");
      expect(refused.filename).toBe(files.controllerLockFile);

      yield* Scope.close(first, Exit.void);
      yield* Effect.scoped(attempt);
    });
    await Effect.runPromise(program);
  });

  it("leaves no journal or other file beside the lock file", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* takeControllerLock(files.controllerLockFile);
          expect(readdirSync(home)).toEqual(["controller.lock"]);
        }),
      ),
    );
  });

  it("reports a lock file that is not a SQLite file as damaged, not as a damaged database", async () => {
    writeFileSync(files.controllerLockFile, "this is not a SQLite database at all, just text");
    const error = await Effect.runPromise(
      Effect.flip(Effect.scoped(takeControllerLock(files.controllerLockFile))),
    );
    expect(error.filename).toBe(files.controllerLockFile);
    expect(error.message).toContain("is damaged");
    expect(error.message).toContain("If no Hercule process is running");
  });

  it("keeps out another process, not only another connection in this one", async () => {
    // SQLite shares the lock state between connections of one process, so only
    // a second process shows that the operating system holds the lock.
    const script = `
      import { Database } from "bun:sqlite";
      try {
        const lock = new Database(process.argv[1], { readwrite: true });
        lock.run("PRAGMA locking_mode = EXCLUSIVE");
        lock.run("BEGIN IMMEDIATE");
        lock.run("COMMIT");
        console.log("got it");
      } catch (error) {
        console.log(error.message);
      }
    `;
    const tryFromOtherProcess = async (): Promise<string> => {
      const child = Bun.spawn([process.execPath, "-e", script, files.controllerLockFile], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const output = await new Response(child.stdout).text();
      await child.exited;
      return output.trim();
    };

    const whileHeld = await Effect.runPromise(
      Effect.scoped(
        Effect.andThen(takeControllerLock(files.controllerLockFile), () =>
          Effect.promise(tryFromOtherProcess),
        ),
      ),
    );
    expect(whileHeld).toBe("database is locked");
    expect(await tryFromOtherProcess()).toBe("got it");
  });
});

describe("the lock on the database file", () => {
  it("refuses a second lock, and a pre-change style open, while it is held", async () => {
    writeFileSync(files.databaseFile, "");
    const openThePreChangeWay = () => {
      const database = new Database(files.databaseFile, { readwrite: true });
      try {
        database.run("PRAGMA locking_mode = EXCLUSIVE");
        database.run("BEGIN IMMEDIATE");
        database.run("COMMIT");
      } finally {
        database.close();
      }
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* Scope.make();
        yield* Scope.provide(lockDatabaseFile(files.databaseFile), first);

        const refused = yield* Effect.flip(Effect.scoped(lockDatabaseFile(files.databaseFile)));
        expect(refused.message).toContain("already open by another process");
        expect(refused.filename).toBe(files.databaseFile);
        expect(openThePreChangeWay).toThrow("database is locked");

        yield* Scope.close(first, Exit.void);
        expect(openThePreChangeWay).not.toThrow();
      }),
    );
  });
});

describe("one controller per home", () => {
  it("fails a second open of the same home", async () => {
    const open = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`SELECT 1`;
    });

    const both = Effect.gen(function* () {
      // The first controller holds the home for as long as its scope lives; the
      // second one boots against the same home while it does.
      yield* Effect.forkScoped(Effect.provide(Effect.andThen(open, Effect.never), database()));
      yield* Effect.sleep(Duration.millis(250));
      return yield* Effect.flip(Effect.provide(open, database()));
    });

    const error = await Effect.runPromise(Effect.scoped(both));
    expect(error).toMatchObject({ _tag: "DatabaseError" });
    expect((error as { readonly message: string }).message).toContain(
      "already open by another Hercule process",
    );
  });

  it("lets the next controller in once the first has closed", async () => {
    const open = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`SELECT 1`;
    });

    await Effect.runPromise(Effect.provide(open, openDatabase(files)));
    await Effect.runPromise(Effect.provide(open, openDatabase(files)));
  });
});

describe("opening", () => {
  it("opens a new database that nothing has written to yet", async () => {
    // The reader cannot open a WAL database before its first write, so the
    // writer makes one on open.
    const journalMode = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly journal_mode: string }>`PRAGMA journal_mode`;
        return rows[0]?.journal_mode;
      }).pipe(Effect.provide(openDatabase(files))),
    );
    expect(journalMode).toBe("wal");
  });

  it("reports a file that is not a database as a database error naming the file", async () => {
    writeFileSync(
      files.databaseFile,
      "this is not a SQLite database, and it is long enough to be read",
    );
    const error = await Effect.runPromise(
      Effect.flip(Effect.provide(Effect.void, openDatabase(files))),
    );
    expect(error).toMatchObject({ _tag: "DatabaseError", filename: files.databaseFile });
    expect(error.message).toContain(`Cannot use ${files.databaseFile}`);
  });

  it("reaches the caller with the errors of the set-up step as themselves", async () => {
    class MigrationFailed extends Data.TaggedError("MigrationFailed")<{
      readonly reason: string;
    }> {}
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.provide(
          Effect.void,
          openDatabase(files, Effect.fail(new MigrationFailed({ reason: "test" }))),
        ),
      ),
    );
    expect(error).toBeInstanceOf(MigrationFailed);
  });

  it("runs the set-up step on the writer, outside any transaction", async () => {
    // `createSchema` creates its tables outside a transaction. On the
    // read-only connection those statements would fail.
    const rows = await run(Effect.flatMap(SqlClient.SqlClient, (sql) => countRows(sql)));
    expect(rows).toBe(0);
  });

  it("keeps foreign keys on for the writer", async () => {
    const { pragma, refused } = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* withTransaction(
          sql,
          sql<{ readonly foreign_keys: number }>`PRAGMA foreign_keys`,
        );
        const refused = yield* Effect.flip(
          withTransaction(sql, sql`INSERT INTO child (parent_id) VALUES (404)`),
        );
        return { pragma: rows[0]?.foreign_keys, refused };
      }),
    );
    expect(pragma).toBe(1);
    expect(refused.reason).toMatchObject({
      _tag: "ConstraintError",
      cause: { code: "SQLITE_CONSTRAINT_FOREIGNKEY" },
    });
  });
});

describe("the writer and the reader", () => {
  it("finishes a read while another fiber holds a transaction open", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const release = yield* Deferred.make<void>();
        const holder = yield* openHolder(sql, 1, release);

        const whileOpen = yield* countRows(sql).pipe(Effect.timeout("500 millis"));

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        return { whileOpen, afterCommit: yield* countRows(sql) };
      }),
    );
    // The read did not wait for the open transaction, did not see its row
    // before the commit, and sees it after.
    expect(seen).toEqual({ whileOpen: 0, afterCommit: 1 });
  });

  it("fails a write outside a transaction", async () => {
    const error = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* Effect.flip(insert(sql, 1));
      }),
    );
    // SQLite's text for this code is "attempt to write a readonly database".
    expect(error.reason.cause).toMatchObject({ code: "SQLITE_READONLY" });
  });

  it("lets a transaction nested in another one join it", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* withTransaction(sql, withTransaction(sql, insert(sql, 5))).pipe(
          Effect.timeout("2 seconds"),
        );
        return yield* countRows(sql, 5);
      }),
    );
    expect(rows).toBe(1);
  });
});

describe("a queued transaction", () => {
  it("can be interrupted while the holder is still open, and the writer is given back", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const release = yield* Deferred.make<void>();
        const holder = yield* openHolder(sql, 1, release);

        const waiter = yield* Effect.forkChild(withTransaction(sql, insert(sql, 2)));
        yield* Effect.sleep("20 millis");
        // Interrupting returns at once instead of waiting for the holder.
        yield* Fiber.interrupt(waiter).pipe(Effect.timeout("500 millis"));

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        // The writer was given back: a later transaction runs.
        yield* withTransaction(sql, insert(sql, 3)).pipe(Effect.timeout("2 seconds"));
        return {
          holder: yield* countRows(sql, 1),
          interrupted: yield* countRows(sql, 2),
          later: yield* countRows(sql, 3),
        };
      }),
    );
    expect(result).toEqual({ holder: 1, interrupted: 0, later: 1 });
  });

  it("gives the writer back whenever the interrupt lands", async () => {
    // Interrupts queued transactions at many different moments, then checks
    // that the writer was always given back: a final transaction must still run.
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (let i = 0; i < 300; i++) {
          const holder = yield* Effect.forkChild(
            withTransaction(sql, Effect.sleep(`${i % 7} millis`)),
          );
          const waiters: Array<Fiber.Fiber<unknown, unknown>> = [];
          for (let w = 0; w < 3; w++) {
            waiters.push(yield* Effect.forkChild(withTransaction(sql, insert(sql, i))));
          }
          yield* Effect.sleep(`${(i * 13) % 8} millis`);
          for (const waiter of waiters) yield* Fiber.interrupt(waiter);
          yield* Fiber.join(holder);
        }
        yield* withTransaction(sql, sql`SELECT 1`).pipe(Effect.timeout("2 seconds"));
      }),
    );
  });

  it("is not abandoned when the caller cannot be interrupted", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const release = yield* Deferred.make<void>();
        const holder = yield* openHolder(sql, 1, release);

        const waiter = yield* Effect.forkChild(
          Effect.uninterruptible(withTransaction(sql, insert(sql, 2))),
        );
        yield* Effect.sleep("20 millis");
        const interruption = yield* Effect.forkChild(Fiber.interrupt(waiter));
        yield* Effect.sleep("50 millis");
        const stillWaiting = interruption.pollUnsafe() === undefined;

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        yield* Fiber.join(interruption);
        return { stillWaiting, ran: yield* countRows(sql, 2) };
      }),
    );
    expect(result).toEqual({ stillWaiting: true, ran: 1 });
  });

  it("waits for a fiber that holds the writer, and can be interrupted there too", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const release = yield* Deferred.make<void>();
        const held = yield* Deferred.make<void>();
        const holder = yield* Effect.forkChild(
          holdWriter(
            sql,
            Effect.andThen(Deferred.succeed(held, undefined), Deferred.await(release)),
          ),
        );
        yield* Deferred.await(held);

        const waiter = yield* Effect.forkChild(withTransaction(sql, insert(sql, 2)));
        yield* Effect.sleep("20 millis");
        yield* Fiber.interrupt(waiter).pipe(Effect.timeout("500 millis"));

        const second = yield* Effect.forkChild(withTransaction(sql, insert(sql, 3)));
        yield* Effect.sleep("20 millis");
        const earlyCount = yield* countRows(sql, 3);

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        yield* Fiber.join(second);
        return {
          earlyCount,
          interrupted: yield* countRows(sql, 2),
          later: yield* countRows(sql, 3),
        };
      }),
    );
    expect(result).toEqual({ earlyCount: 0, interrupted: 0, later: 1 });
  });
});

describe("the writer alone", () => {
  it("runs every statement on the writer", async () => {
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* createSchema;
        yield* insert(sql, 1);
        return yield* countRows(sql);
      }).pipe(Effect.provide(openDatabaseWriter(files))),
    );
    expect(rows).toBe(1);
  });
});

describe("withTransaction", () => {
  /**
   * A listener whose `publish` signals `started`, then takes a moment, then
   * records that it finished. A change announced in a transaction reaches it.
   */
  const makeSlowListener = (started: Deferred.Deferred<void>, finished: { done: boolean }) => ({
    publish: () =>
      Effect.andThen(
        Deferred.succeed(started, undefined),
        Effect.andThen(
          Effect.sleep("30 millis"),
          Effect.sync(() => {
            finished.done = true;
          }),
        ),
      ),
  });

  it("runs a committed transaction's after-commit work when the caller is interrupted as it commits", async () => {
    const finished = { done: false };
    let settled = false;
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const started = yield* Deferred.make<void>();
        const caller = yield* Effect.forkChild(
          withTransaction(
            sql,
            Effect.andThen(
              insert(sql, 7),
              Effect.andThen(
                afterCommit(() => {
                  settled = true;
                }),
                announce({ _tag: "event" }),
              ),
            ),
          ).pipe(Effect.provideService(AfterCommit, makeSlowListener(started, finished))),
        );
        // The commit is done and the listener is publishing: hang up now.
        yield* Deferred.await(started);
        const exit = yield* Fiber.interrupt(caller).pipe(Effect.flatMap(() => Fiber.await(caller)));
        return { exit, rows: yield* countRows(sql, 7) };
      }),
    );

    expect(Exit.hasInterrupts(result.exit)).toBe(true);
    expect(result.rows).toBe(1);
    expect(settled).toBe(true);
    expect(finished.done).toBe(true);
  });

  it("lets the next writer start while the after-commit work of the last one still runs", async () => {
    const finished = { done: false };
    const next = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const started = yield* Deferred.make<void>();
        const first = yield* Effect.forkChild(
          withTransaction(sql, Effect.andThen(insert(sql, 1), announce({ _tag: "event" }))).pipe(
            Effect.provideService(AfterCommit, makeSlowListener(started, finished)),
          ),
        );
        yield* Deferred.await(started);
        // The first listener is still publishing; the writer is already free.
        yield* withTransaction(sql, insert(sql, 2)).pipe(Effect.timeout("2 seconds"));
        const stillPublishing = !finished.done;
        yield* Fiber.join(first);
        return stillPublishing;
      }),
    );
    expect(next).toBe(true);
  });
});
