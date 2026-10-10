import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { MEMORY, openDatabase, withTransaction } from "./client";
import { copyDatabaseAndStopWrites, resumeWrites, withFinalTransaction } from "./writes";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "hercule-writes-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE notes (text TEXT NOT NULL)`;
      yield* sql`INSERT INTO notes (text) VALUES ('before the copy')`;
      return yield* effect;
    }).pipe(Effect.provide(openDatabase(MEMORY))),
  );

/** Returns the driver's error text for a failed statement. */
const describeRefusal = (error: SqlError): string => String(error.reason.cause);

const insertNote = (sql: SqlClient.SqlClient, text: string) =>
  sql`INSERT INTO notes (text) VALUES (${text})`;

const countNotes = (sql: SqlClient.SqlClient) =>
  Effect.map(sql<{ readonly n: number }>`SELECT count(*) AS n FROM notes`, (rows) => rows[0]?.n);

describe("copyDatabaseAndStopWrites", () => {
  it("copies the database and refuses every write until writes resume", async () => {
    const copy = join(scratch, "copy.db");
    const outcome = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* copyDatabaseAndStopWrites(sql, copy);
        const refused = yield* Effect.flip(insertNote(sql, "after the copy"));
        const refusedInTransaction = yield* Effect.flip(
          withTransaction(sql, insertNote(sql, "after the copy")),
        );
        yield* resumeWrites(sql);
        yield* insertNote(sql, "after the thaw");
        return {
          refused: describeRefusal(refused),
          refusedInTransaction: describeRefusal(refusedInTransaction),
          count: yield* countNotes(sql),
        };
      }),
    );

    expect(existsSync(copy)).toBe(true);
    expect(outcome.refused).toContain("attempt to write a readonly database");
    expect(outcome.refusedInTransaction).toContain("attempt to write a readonly database");
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
        yield* withFinalTransaction(sql, insertNote(sql, "the seal"));
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
          Effect.andThen(insertNote(sql, "rolled back"), Effect.fail("no seal")),
        ).pipe(Effect.flip);
        const refused = yield* Effect.flip(insertNote(sql, "after the seal"));
        return { refused: describeRefusal(refused), count: yield* countNotes(sql) };
      }),
    );

    expect(outcome.refused).toContain("attempt to write a readonly database");
    expect(outcome.count).toBe(1);
  });
});
