import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { openDatabase, withTransaction } from "./client";
import {
  copyDatabaseAndStopWrites,
  resumeWrites,
  stopWrites,
  withFinalTransaction,
} from "./writes";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "hercule-writes-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Creates the test's table on the writer and puts one note in it, as a migration would. */
const setUp = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE notes (text TEXT NOT NULL)`;
  yield* sql`INSERT INTO notes (text) VALUES ('before the copy')`;
});

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(
    Effect.provide(
      effect,
      openDatabase(
        {
          databaseFile: join(scratch, "hercule.db"),
          controllerLockFile: join(scratch, "controller.lock"),
        },
        setUp,
      ),
    ),
  );

/** Returns the driver's error text for a failed statement. */
const describeRefusal = (error: SqlError): string => String(error.reason.cause);

/** Inserts a note with a bare statement, for code that already runs on the held writer. */
const insertNoteStatement = (sql: SqlClient.SqlClient, text: string) =>
  sql`INSERT INTO notes (text) VALUES (${text})`;

/** Inserts a note in a transaction of its own, the only place the database accepts a write. */
const insertNote = (sql: SqlClient.SqlClient, text: string) =>
  withTransaction(sql, insertNoteStatement(sql, text));

const countNotes = (sql: SqlClient.SqlClient) =>
  Effect.map(sql<{ readonly n: number }>`SELECT count(*) AS n FROM notes`, (rows) => rows[0]?.n);

describe("stopWrites", () => {
  it("refuses a write in a transaction, answers a read outside one, and lets writes through after resumeWrites", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* stopWrites(sql);
        const refused = yield* Effect.flip(insertNote(sql, "while stopped"));
        const countWhileStopped = yield* countNotes(sql);
        yield* resumeWrites(sql);
        yield* insertNote(sql, "after resume");
        return {
          refused: describeRefusal(refused),
          countWhileStopped,
          countAfterResume: yield* countNotes(sql),
        };
      }),
    );

    expect(outcome.refused).toContain("attempt to write a readonly database");
    expect(outcome.countWhileStopped).toBe(1);
    expect(outcome.countAfterResume).toBe(2);
  });
});

describe("copyDatabaseAndStopWrites", () => {
  it("copies the database and refuses every write until writes resume", async () => {
    const copy = join(scratch, "copy.db");
    const outcome = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* copyDatabaseAndStopWrites(sql, copy);
        const refused = yield* Effect.flip(insertNote(sql, "after the copy"));
        const refusedInNestedTransaction = yield* Effect.flip(
          withTransaction(sql, insertNote(sql, "after the copy")),
        );
        yield* resumeWrites(sql);
        yield* insertNote(sql, "after the thaw");
        return {
          refused: describeRefusal(refused),
          refusedInNestedTransaction: describeRefusal(refusedInNestedTransaction),
          count: yield* countNotes(sql),
        };
      }),
    );

    expect(existsSync(copy)).toBe(true);
    expect(outcome.refused).toContain("attempt to write a readonly database");
    expect(outcome.refusedInNestedTransaction).toContain("attempt to write a readonly database");
    expect(outcome.count).toBe(2);
  });

  it("still answers reads in a transaction, nested ones included, while writes are stopped", async () => {
    const count = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* copyDatabaseAndStopWrites(sql, join(scratch, "copy.db"));
        return yield* withTransaction(sql, withTransaction(sql, countNotes(sql)));
      }),
    );

    expect(count).toBe(1);
  });
});

describe("withFinalTransaction", () => {
  it("writes while writes are stopped, and leaves them stopped", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* copyDatabaseAndStopWrites(sql, join(scratch, "copy.db"));
        yield* withFinalTransaction(sql, insertNoteStatement(sql, "the seal"));
        const refused = yield* Effect.flip(insertNote(sql, "after the seal"));
        return { refused: describeRefusal(refused), count: yield* countNotes(sql) };
      }),
    );

    expect(outcome.refused).toContain("attempt to write a readonly database");
    expect(outcome.count).toBe(2);
  });

  it("rolls back when its effect fails, and leaves writes stopped", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* withFinalTransaction(
          sql,
          Effect.andThen(insertNoteStatement(sql, "rolled back"), Effect.fail("no seal")),
        ).pipe(Effect.flip);
        const refused = yield* Effect.flip(insertNote(sql, "after the seal"));
        return { refused: describeRefusal(refused), count: yield* countNotes(sql) };
      }),
    );

    expect(outcome.refused).toContain("attempt to write a readonly database");
    expect(outcome.count).toBe(1);
  });
});
