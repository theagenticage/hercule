import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { FileSystem } from "effect/FileSystem";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { MEMORY, openDatabase, withTransaction } from "./client";
import { backupBeforeMigration, databaseVersion, migrate, runMigrations } from "./migrate";
import { binaryVersion, migrations } from "./migrations/index";
import { TestDatabase } from "./testing";

/** The tables migration 0001 creates: the boot set of spec 04. */
const TABLES = [
  "secrets",
  "permission_profiles",
  "settings",
  "controller_identity",
  "setup_state",
  "events",
];

type DatabaseEffect<A, E> = Effect.Effect<A, E, SqlClient.SqlClient | FileSystem>;

const provided = <A, E>(filename: string, effect: DatabaseEffect<A, E>) =>
  effect.pipe(Effect.provide(openDatabase(filename)), Effect.provide(BunFileSystem.layer));

const run = <A, E>(filename: string, effect: DatabaseEffect<A, E>) =>
  Effect.runPromise(provided(filename, effect));

const runExit = <A, E>(filename: string, effect: DatabaseEffect<A, E>) =>
  Effect.runPromiseExit(provided(filename, effect));

const tableNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`;
  return rows.map((row) => row.name);
});

let home: string;
let databaseFile: string;
let backupsDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hydra-db-"));
  databaseFile = join(home, "hydra.db");
  backupsDir = join(home, "backups");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("migrations", () => {
  it("applies the whole set to an in-memory database", async () => {
    const found = await run(
      MEMORY,
      Effect.gen(function* () {
        const applied = yield* runMigrations();
        expect(applied.map(([id]) => id)).toEqual([1]);
        return yield* tableNames;
      }),
    );
    for (const table of TABLES) expect(found).toContain(table);
  });

  it("is a no-op on the second run", async () => {
    const [first, second, version] = await run(
      databaseFile,
      Effect.gen(function* () {
        const first = yield* migrate({ backupsDir, databaseExisted: false });
        const second = yield* migrate({ backupsDir, databaseExisted: true });
        return [first, second, yield* databaseVersion] as const;
      }),
    );
    expect(first).toHaveLength(binaryVersion);
    expect(second).toEqual([]);
    expect(version).toBe(binaryVersion);
  });

  it("refuses a database newer than the binary, naming both versions", async () => {
    const exit = await runExit(
      databaseFile,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (99, 'from-the-future')`;
        return yield* migrate({ backupsDir, databaseExisted: true });
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const message = Exit.isFailure(exit) ? String(exit.cause) : "";
    expect(message).toContain("99");
    expect(message).toContain(`version ${binaryVersion}`);
  });

  it("hands tests a migrated in-memory database", async () => {
    const found = await Effect.runPromise(tableNames.pipe(Effect.provide(TestDatabase)));
    for (const table of TABLES) expect(found).toContain(table);
  });

  it("takes no pre-migration copy on a first run", async () => {
    await run(databaseFile, migrate({ backupsDir, databaseExisted: false }));
    expect(existsSync(backupsDir)).toBe(false);
  });

  it("copies an existing database before it applies a pending migration", async () => {
    // A second migration, as a later Hydra would carry it: the composed path is
    // "the file was already there and something is pending", which the embedded
    // set alone cannot exercise while it holds one migration.
    const withSecond = [
      ...migrations,
      [
        2,
        "add-a-table",
        Effect.succeed(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`CREATE TABLE later (id INTEGER PRIMARY KEY)`;
          }),
        ),
      ] as const,
    ];

    const { applied, tables } = await run(
      databaseFile,
      Effect.gen(function* () {
        yield* migrate({ backupsDir, databaseExisted: false });
        const applied = yield* migrate({
          backupsDir,
          databaseExisted: true,
          migrations: withSecond,
        });
        return { applied, tables: yield* tableNames };
      }),
    );

    expect(applied.map(([id]) => id)).toEqual([2]);
    expect(tables).toContain("later");
    const copies = readdirSync(backupsDir);
    expect(copies).toHaveLength(1);
    // The copy is the database as it was, without the pending migration.
    const before = await run(join(backupsDir, copies[0]!), tableNames);
    expect(before).not.toContain("later");
  });
});

describe("the pre-migration copy", () => {
  it("writes a VACUUM INTO copy and keeps the newest three", async () => {
    const older = [
      "20200101T000000000Z",
      "20200102T000000000Z",
      "20200103T000000000Z",
      "20200104T000000000Z",
    ];
    const written = await run(
      databaseFile,
      Effect.gen(function* () {
        yield* runMigrations();
        yield* Effect.sync(() => {
          mkdirSync(backupsDir, { recursive: true });
          for (const stamp of older) {
            writeFileSync(join(backupsDir, `${stamp}-premigration.db`), "");
          }
        });
        return yield* backupBeforeMigration(backupsDir);
      }),
    );

    const copies = readdirSync(backupsDir).sort();
    expect(copies).toEqual([
      `${older[2]}-premigration.db`,
      `${older[3]}-premigration.db`,
      written.slice(backupsDir.length + 1),
    ]);
    // The copy is a real database, not an empty file.
    const restored = await run(written, tableNames);
    for (const table of TABLES) expect(restored).toContain(table);
  });
});

describe("the database file", () => {
  it("runs in WAL mode", async () => {
    const mode = await run(
      databaseFile,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly journal_mode: string }>`PRAGMA journal_mode`;
        return rows[0]?.journal_mode;
      }),
    );
    expect(mode).toBe("wal");
  });
});

describe("ambient transactions", () => {
  const insert = (key: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO settings (scope, key, value, updated_at)
        VALUES ('controller', ${key}, '1', '2026-01-01T00:00:00.000Z')
      `;
    });

  const keys = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly key: string }>`SELECT key FROM settings ORDER BY key`;
    return rows.map((row) => row.key);
  });

  it("commits a nested transaction with its parent", async () => {
    const found = await run(
      MEMORY,
      Effect.gen(function* () {
        yield* runMigrations();
        yield* withTransaction(
          Effect.gen(function* () {
            yield* insert("outer");
            yield* withTransaction(insert("inner"));
          }),
        );
        return yield* keys;
      }),
    );
    expect(found).toEqual(["inner", "outer"]);
  });

  it("rolls the whole write set back when anything inside fails", async () => {
    const found = await run(
      MEMORY,
      Effect.gen(function* () {
        yield* runMigrations();
        yield* withTransaction(
          Effect.gen(function* () {
            yield* insert("outer");
            yield* withTransaction(
              Effect.gen(function* () {
                yield* insert("inner");
                return yield* Effect.fail("the runner said no");
              }),
            );
          }),
        ).pipe(Effect.ignore);
        return yield* keys;
      }),
    );
    expect(found).toEqual([]);
  });
});
