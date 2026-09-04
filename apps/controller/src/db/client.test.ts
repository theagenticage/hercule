import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { LockTimeoutError, SqlError, UnknownError } from "effect/unstable/sql/SqlError";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { databaseError, openDatabase, withTransaction } from "./client";

let home: string;
let file: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hydra-db-"));
  file = join(home, "hydra.db");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("databaseError", () => {
  it("names the other controller when a real transaction times out on the write lock", async () => {
    // The shape a second `hydra serve` hits: one connection holds the write
    // lock, the other opens a transaction that reads and then writes. The busy
    // timeout is shortened to keep the suite quick; the default is five seconds.
    const holder = new Database(file, { create: true });
    holder.run("PRAGMA journal_mode = WAL");
    holder.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    holder.run("BEGIN IMMEDIATE");
    holder.run("INSERT INTO t (v) VALUES ('held')");

    const write = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* withTransaction(
        sql,
        Effect.gen(function* () {
          yield* sql`SELECT count(*) AS n FROM t`;
          yield* sql`INSERT INTO t (v) VALUES ('second')`;
        }),
      );
    }).pipe(
      Effect.provide(SqliteClient.layer({ filename: file, busyTimeout: Duration.millis(100) })),
    );

    try {
      const error = await Effect.runPromise(write.pipe(Effect.flip));
      expect(databaseError(file, error).message).toContain(
        "already open by another Hydra controller",
      );
    } finally {
      holder.run("ROLLBACK");
      holder.close();
    }
  });

  it("finds a lock timeout a wrapper buried in the cause chain", () => {
    const inner = new SqlError({
      reason: new LockTimeoutError({ cause: { code: "SQLITE_BUSY" } }),
    });
    const outer = new SqlError({ reason: new UnknownError({ cause: inner }) });
    expect(databaseError(file, outer).message).toContain(
      "already open by another Hydra controller",
    );
  });

  it("says what it could not do when the failure is not a lock", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`SELECT * FROM absent`;
      }).pipe(Effect.provide(openDatabase(file)), Effect.flip),
    );
    expect(databaseError(file, error).message).toContain(`Cannot use ${file}`);
  });
});

describe("one controller per home (ADR 0004)", () => {
  it("refuses a second open of the same database file", async () => {
    const open = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`SELECT 1`;
    });

    const both = Effect.gen(function* () {
      // The first controller holds the home for as long as its scope lives; the
      // second one boots against the same file while it does.
      yield* Effect.forkScoped(
        Effect.provide(Effect.andThen(open, Effect.never), openDatabase(file)),
      );
      yield* Effect.sleep(Duration.millis(250));
      return yield* Effect.flip(Effect.provide(open, openDatabase(file)));
    });

    const error = await Effect.runPromise(Effect.scoped(both));
    expect(error.message).toContain("already open by another Hydra controller");
  });

  it("lets the next controller in once the first has closed", async () => {
    const open = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`SELECT 1`;
    });

    await Effect.runPromise(Effect.provide(open, openDatabase(file)));
    await Effect.runPromise(Effect.provide(open, openDatabase(file)));
  });
});
