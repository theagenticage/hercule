import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import type { FileSystem } from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { openDatabaseWriter, withTransaction } from "./client";
import {
  backupBeforeMigration,
  copyDatabaseTo,
  findSkippedMigrations,
  migrate,
  readDatabaseVersion,
  runMigrations,
} from "./migrate";
import { MigrationMasterKey } from "./migration-master-key";
import { binaryVersion, migrations } from "./migrations/index";
import { TestDatabase, TestDatabaseWriter } from "./testing";

/**
 * Tables the migrations must create: the boot tables, then users and
 * credentials, then tasks and projects, then resources.
 */
const TABLES = [
  "secrets",
  "permission_profiles",
  "settings",
  "controller_identity",
  "setup_state",
  "events",
  "users",
  "login_tokens",
  "api_keys",
  "tasks",
  "projects",
  "task_provenance",
  // Resources, the working areas they are checked out into, and the checkouts
  // themselves.
  "resources",
  "workspaces",
  "checkouts",
];

type DatabaseEffect<A, E> = Effect.Effect<A, E, SqlClient.SqlClient | FileSystem>;

/**
 * Runs `effect` on the writer of the database file `filename`, with the lock
 * file in the test's temp folder. A file can be opened again after the first
 * run has finished, because closing the writer releases the lock.
 */
const provideDatabase = <A, E>(filename: string, effect: DatabaseEffect<A, E>) =>
  effect.pipe(
    Effect.provide(
      openDatabaseWriter({
        databaseFile: filename,
        controllerLockFile: join(home, "controller.lock"),
      }),
    ),
    Effect.provide(BunFileSystem.layer),
  );

const run = <A, E>(filename: string, effect: DatabaseEffect<A, E>) =>
  Effect.runPromise(provideDatabase(filename, effect));

const runExit = <A, E>(filename: string, effect: DatabaseEffect<A, E>) =>
  Effect.runPromiseExit(provideDatabase(filename, effect));

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
  home = mkdtempSync(join(tmpdir(), "hercule-db-"));
  databaseFile = join(home, "hercule.db");
  backupsDir = join(home, "backups");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("migrations", () => {
  it("applies the whole set to a new database", async () => {
    const found = await Effect.runPromise(
      Effect.gen(function* () {
        const applied = yield* runMigrations();
        expect(applied.map(([id]) => id)).toEqual(migrations.map(([id]) => id));
        return yield* tableNames;
      }).pipe(Effect.provide(TestDatabaseWriter)),
    );
    for (const table of TABLES) expect(found).toContain(table);
  });

  it("is a no-op on the second run", async () => {
    const [first, second, version] = await run(
      databaseFile,
      Effect.gen(function* () {
        const first = yield* migrate({ backupsDir, databaseExisted: false });
        const second = yield* migrate({ backupsDir, databaseExisted: true });
        return [first, second, yield* readDatabaseVersion] as const;
      }),
    );
    // Counted from the list rather than from the highest id, because an id
    // may be left free for a migration another branch is adding.
    expect(first).toHaveLength(migrations.length);
    expect(second).toEqual([]);
    expect(version).toBe(binaryVersion);
  });

  it("fails on a database newer than the binary, and reports both versions", async () => {
    const exit = await runExit(
      databaseFile,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        const future = binaryVersion + 1;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${future}, 'from-the-future')`;
        return yield* migrate({ backupsDir, databaseExisted: true });
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const message = Exit.isFailure(exit) ? String(exit.cause) : "";
    expect(message).toContain(String(binaryVersion + 1));
    expect(message).toContain(`version ${binaryVersion}`);
  });

  it("gives tests a migrated temporary database", async () => {
    const found = await Effect.runPromise(tableNames.pipe(Effect.provide(TestDatabase)));
    for (const table of TABLES) expect(found).toContain(table);
  });

  it("takes no pre-migration copy on a first run", async () => {
    await run(databaseFile, migrate({ backupsDir, databaseExisted: false }));
    expect(existsSync(backupsDir)).toBe(false);
  });

  it("copies an existing database before it applies a pending migration", async () => {
    // One migration beyond the embedded set, as a later Hercule release would
    // add. This tests the case "the file already existed and a migration is
    // pending", which the embedded set alone cannot reach, because a first run
    // applies all of it at once.
    const pendingId = binaryVersion + 1;
    const withSecond = [
      ...migrations,
      [
        pendingId,
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

    expect(applied.map(([id]) => id)).toEqual([pendingId]);
    expect(tables).toContain("later");
    const copies = readdirSync(backupsDir);
    expect(copies).toHaveLength(1);
    // The copy is the database as it was, without the pending migration.
    const before = await run(join(backupsDir, copies[0]!), tableNames);
    expect(before).not.toContain("later");
  });
});

/** Returns a migration that creates an empty table named `table`. */
const createTableMigration = (id: number, table: string) =>
  [
    id,
    `create-${table}`,
    Effect.succeed(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`);
      }),
    ),
  ] as const;

/** A migration that records whether the Master Key reached it. */
const recordMasterKeyMigration = [
  1,
  "record-master-key",
  Effect.succeed(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const key = yield* Effect.serviceOption(MigrationMasterKey);
      yield* sql.unsafe(`CREATE TABLE key_seen (present INTEGER)`);
      yield* sql`INSERT INTO key_seen (present) VALUES (${Option.isSome(key) ? 1 : 0})`;
    }),
  ),
] as const;

describe("the Master Key a migration receives", () => {
  const readKeySeen = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly present: number }>`SELECT present FROM key_seen`;
    return rows.map((row) => row.present);
  });

  it("is handed to a migration that asks for it when the boot opened one", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    const seen = await run(
      databaseFile,
      Effect.gen(function* () {
        yield* migrate({
          backupsDir,
          databaseExisted: false,
          migrations: [recordMasterKeyMigration],
          masterKey: key,
        });
        return yield* readKeySeen;
      }),
    );
    expect(seen).toEqual([1]);
  });

  it("is absent for a migration when the machine has no key yet", async () => {
    const seen = await run(
      databaseFile,
      Effect.gen(function* () {
        yield* migrate({
          backupsDir,
          databaseExisted: false,
          migrations: [recordMasterKeyMigration],
        });
        return yield* readKeySeen;
      }),
    );
    expect(seen).toEqual([0]);
  });
});

describe("a migration added below the database's version", () => {
  it("refuses to start, names the skipped id, and changes nothing", async () => {
    // A build with 79 and 80 ran first; a later build also holds 77, which
    // another branch added and merged afterwards.
    const exit = await runExit(
      databaseFile,
      Effect.gen(function* () {
        yield* migrate({
          backupsDir,
          databaseExisted: false,
          migrations: [createTableMigration(79, "t79"), createTableMigration(80, "t80")],
        });
        return yield* migrate({
          backupsDir,
          databaseExisted: true,
          migrations: [
            createTableMigration(77, "t77"),
            createTableMigration(79, "t79"),
            createTableMigration(80, "t80"),
          ],
        });
      }),
    );
    expect(exit).toMatchObject({
      _tag: "Failure",
      cause: {
        reasons: [
          { error: { _tag: "SkippedMigrationError", skippedIds: [77], databaseVersion: 80 } },
        ],
      },
    });
    expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain(
      "Migration 77 was never applied",
    );
    expect(await run(databaseFile, tableNames)).not.toContain("t77");
    expect(existsSync(backupsDir)).toBe(false);
  });

  it("finds only ids at or below the highest applied id that were never applied", () => {
    const set = [77, 78, 79, 80, 81].map((id) => createTableMigration(id, `t${id}`));
    expect(findSkippedMigrations([79, 80], set)).toEqual([77, 78]);
    // A pending upgrade, every id applied, and a new database skip nothing.
    expect(findSkippedMigrations([77, 78, 79, 80], set)).toEqual([]);
    expect(findSkippedMigrations([77, 78, 79, 80, 81], set)).toEqual([]);
    expect(findSkippedMigrations([], set)).toEqual([]);
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

  it("writes a VACUUM INTO snapshot to a path outside backups/", async () => {
    const dest = join(home, "promotion-copy.db");
    await run(
      databaseFile,
      Effect.gen(function* () {
        yield* runMigrations();
        yield* copyDatabaseTo(dest);
      }),
    );
    expect(existsSync(dest)).toBe(true);
    const restored = await run(dest, tableNames);
    for (const table of TABLES) expect(restored).toContain(table);
    expect(existsSync(backupsDir)).toBe(false);
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
  const insertSetting = (key: string) =>
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
    const found = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            yield* insertSetting("outer");
            yield* withTransaction(sql, insertSetting("inner"));
          }),
        );
        return yield* keys;
      }).pipe(Effect.provide(TestDatabase)),
    );
    expect(found).toEqual(["inner", "outer"]);
  });

  it("rolls the whole write set back when anything inside fails", async () => {
    const found = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            yield* insertSetting("outer");
            yield* withTransaction(
              sql,
              Effect.gen(function* () {
                yield* insertSetting("inner");
                return yield* Effect.fail("the runner said no");
              }),
            );
          }),
        ).pipe(Effect.ignore);
        return yield* keys;
      }).pipe(Effect.provide(TestDatabase)),
    );
    expect(found).toEqual([]);
  });
});

/**
 * Tests what the resources migration must create.
 *
 * The checks run against the same migrated temporary database every controller
 * test uses, so a missing table or key fails here, in one place, rather than
 * across the whole suite.
 */
describe("resources, workspaces and checkouts", () => {
  const listColumns = (table: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM pragma_table_info(${table})`;
      return rows.map((row) => row.name);
    });

  /** Every foreign key in the database, as the table it is on and the table it points at. */
  const foreignKeys = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql<{
      readonly name: string;
    }>`SELECT name FROM sqlite_master WHERE type = 'table'`;
    const found: Array<{ from: string; column: string; to: string }> = [];
    for (const table of tables) {
      const keys = yield* sql<{
        readonly table: string;
        readonly from: string;
      }>`SELECT "table", "from" FROM pragma_foreign_key_list(${table.name})`;
      for (const key of keys) {
        found.push({ from: table.name, column: key.from, to: key.table });
      }
    }
    return found;
  });

  it("has more migrations than the eighteen that came before it", () => {
    expect(binaryVersion).toBeGreaterThanOrEqual(19);
  });

  it("gives a session the project it belongs to", async () => {
    const columns = await Effect.runPromise(
      listColumns("sessions").pipe(Effect.provide(TestDatabase)),
    );
    expect(columns).toContain("project_id");
    expect(columns).toContain("workspace_id");
  });

  it("points a workspace's checkouts at the resources and the workspace they belong to", async () => {
    const keys = await Effect.runPromise(foreignKeys.pipe(Effect.provide(TestDatabase)));
    const listForeignKeysFrom = (table: string) => keys.filter((key) => key.from === table);

    expect(
      listForeignKeysFrom("checkouts")
        .map((key) => key.to)
        .sort(),
    ).toEqual(["resources", "workspaces"]);
    expect(listForeignKeysFrom("workspaces").map((key) => key.to)).toContain("runners");
  });

  it("gives the project-to-resource join the foreign key it never had", async () => {
    const keys = await Effect.runPromise(foreignKeys.pipe(Effect.provide(TestDatabase)));
    // The table may have been replaced rather than altered, so the test checks
    // only that some table points at both a project and a resource.
    const joins = keys.filter((key) => key.column === "resource_id" && key.to === "resources");
    expect(joins.length, "no table points its resource_id at resources").toBeGreaterThan(0);
    const owners = new Set(joins.map((key) => key.from));
    const toProjects = keys.filter((key) => owners.has(key.from) && key.to === "projects");
    expect(toProjects.length, "the join does not point at a project").toBeGreaterThan(0);
  });
});
