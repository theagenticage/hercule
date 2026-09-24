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

const provideDatabase = <A, E>(filename: string, effect: DatabaseEffect<A, E>) =>
  effect.pipe(Effect.provide(openDatabase(filename)), Effect.provide(BunFileSystem.layer));

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
  it("applies the whole set to an in-memory database", async () => {
    const found = await run(
      MEMORY,
      Effect.gen(function* () {
        const applied = yield* runMigrations();
        expect(applied.map(([id]) => id)).toEqual(migrations.map(([id]) => id));
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

  it("fails on a database newer than the binary, and reports both versions", async () => {
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

  it("gives tests a migrated in-memory database", async () => {
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
    const found = await run(
      MEMORY,
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            yield* insertSetting("outer");
            yield* withTransaction(sql, insertSetting("inner"));
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
      }),
    );
    expect(found).toEqual([]);
  });
});

/**
 * Tests what the resources migration must create.
 *
 * The checks run against the same migrated in-memory database every controller
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
