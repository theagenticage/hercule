/**
 * Boot-time migrations (spec 04, Migrations on boot; spec 15 section 8).
 *
 * On `hercule serve` the controller takes a `VACUUM INTO` copy of the database,
 * refuses to start if the database is newer than the binary, and applies every
 * pending migration inside one transaction.
 */
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import type * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as SqliteMigrator from "@effect/sql-sqlite-bun/SqliteMigrator";
import { migrations } from "./migrations/index";

/** The Migrator's own ledger table; the highest id in it is the database's schema version. */
const MIGRATIONS_TABLE = "effect_sql_migrations";

/** Pre-migration copies are named so the daily backups sort separately (spec 15 section 8). */
const PREMIGRATION_SUFFIX = "-premigration.db";

/** How many pre-migration copies survive a prune (spec 04, Backups). */
const KEEP_PREMIGRATION_COPIES = 3;

/**
 * The database was written by a newer binary. There are no down migrations, so
 * the only honest move is to refuse to start and name both versions.
 */
export class SchemaVersionError extends Data.TaggedError("SchemaVersionError")<{
  readonly databaseVersion: number;
  readonly binaryVersion: number;
  readonly message: string;
}> {}

/** The highest applied migration id, or 0 on a database that has never been migrated. */
export const databaseVersion: Effect.Effect<number, SqlError, SqlClient.SqlClient> = Effect.gen(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql<{
      readonly name: string;
    }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${MIGRATIONS_TABLE}`;
    if (tables.length === 0) return 0;
    const rows = yield* sql<{
      readonly version: number | null;
    }>`SELECT max(migration_id) AS version FROM effect_sql_migrations`;
    return rows[0]?.version ?? 0;
  },
);

/** UTC, filename-safe, sorts by age: `20260904T092133084Z`. */
const formatTimestamp = (now: Date): string => now.toISOString().replaceAll(/[-:.]/g, "");

/** Keeps the newest pre-migration copies and deletes the rest. Daily backups are untouched. */
const pruneBackups = (backupsDir: string): Effect.Effect<void, PlatformError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const entries = yield* fs.readDirectory(backupsDir);
    const stale = entries
      .filter((entry) => entry.endsWith(PREMIGRATION_SUFFIX))
      .sort()
      .slice(0, -KEEP_PREMIGRATION_COPIES);
    yield* Effect.forEach(stale, (entry) => fs.remove(`${backupsDir}/${entry}`), { discard: true });
  });

/**
 * Copies the database into `backupsDir` and prunes the older copies, keeping
 * the newest three (spec 04, Backups). `VACUUM INTO` rather than a file copy,
 * because after an unclean shutdown the `-wal` file holds writes the `.db` file
 * does not have. It cannot run inside a transaction, so it happens before the
 * migrator opens one. Returns the path it wrote.
 */
export const backupBeforeMigration = (
  backupsDir: string,
): Effect.Effect<string, SqlError | PlatformError, SqlClient.SqlClient | FileSystem> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem;
    yield* fs.makeDirectory(backupsDir, { recursive: true });
    const now = new Date(yield* Clock.currentTimeMillis);
    const path = `${backupsDir}/${formatTimestamp(now)}${PREMIGRATION_SUFFIX}`;
    // A path is not bindable in a VACUUM statement, so it is inlined with
    // SQLite's own quoting. Backup paths come from the config, never from a row.
    yield* sql.unsafe(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
    yield* pruneBackups(backupsDir);
    return path;
  });

/** Applies every pending migration inside one transaction, and nothing else. */
export const runMigrations = (
  set: ReadonlyArray<Migrator.ResolvedMigration> = migrations,
): Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  SqlError | Migrator.MigrationError,
  SqlClient.SqlClient
> => Effect.suspend(() => SqliteMigrator.run({ loader: Effect.succeed(set) }));

/** The schema version a migration set carries: the highest id in it. */
const findHighestId = (set: ReadonlyArray<Migrator.ResolvedMigration>): number =>
  set.reduce((highest, [id]) => Math.max(highest, id), 0);

/**
 * The boot sequence: refuse a database newer than this binary, copy it if it
 * holds anything worth keeping, then migrate.
 *
 * The copy is skipped when the database file did not exist when it was opened -
 * a first run has nothing to lose - and when nothing is pending, which would
 * otherwise leave a copy behind on every boot.
 *
 * `migrations` is the embedded set; a test passes a longer one to exercise a
 * pending migration against a database that already exists.
 */
export const migrate = (options: {
  readonly backupsDir: string;
  readonly databaseExisted: boolean;
  readonly migrations?: ReadonlyArray<Migrator.ResolvedMigration>;
}): Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  SqlError | Migrator.MigrationError | SchemaVersionError | PlatformError,
  SqlClient.SqlClient | FileSystem
> =>
  Effect.gen(function* () {
    const set = options.migrations ?? migrations;
    const target = findHighestId(set);
    const version = yield* databaseVersion;
    if (version > target) {
      return yield* new SchemaVersionError({
        databaseVersion: version,
        binaryVersion: target,
        message:
          `This database is at schema version ${version}, and this Hercule binary only knows ` +
          `version ${target}. Hercule has no down migrations; run a build at or after ` +
          `schema version ${version}.`,
      });
    }
    if (options.databaseExisted && version < target) {
      yield* backupBeforeMigration(options.backupsDir);
    }
    return yield* runMigrations(set);
  });
