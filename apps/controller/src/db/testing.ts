/**
 * The database layer that tests run against: a database with the production
 * migrations applied (spec 04, Repository interfaces). There are no mock
 * repositories, so every test run also checks the migrations.
 */
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inject } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { AfterCommit, type Change } from "./after-commit";
import {
  openDatabase,
  openDatabaseWriter,
  withTransaction,
  type DatabaseError,
  type DatabaseFiles,
} from "./client";

/**
 * Creates a temporary folder that is deleted when the scope closes, and returns
 * the two files of a database inside it. Neither file exists yet.
 */
const createTemporaryDatabaseFiles = Effect.gen(function* () {
  const folder = yield* Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "hercule-test-db-"))),
    (created) => Effect.sync(() => rmSync(created, { recursive: true, force: true })),
  );
  return {
    databaseFile: join(folder, "test.db"),
    controllerLockFile: join(folder, "controller.lock"),
  } satisfies DatabaseFiles;
});

/**
 * Creates the temporary folder like {@link createTemporaryDatabaseFiles} and
 * copies the migrated template database to its database file.
 */
const createTemplateCopyFiles = Effect.tap(createTemporaryDatabaseFiles, (files) =>
  Effect.sync(() => copyFileSync(inject("templateDatabase"), files.databaseFile)),
);

/**
 * Opens a copy of the migrated template database in a temporary folder, which
 * is deleted when the layer's scope closes. Each layer built from this one
 * gets its own copy, so tests never see each other's rows. The template is
 * migrated once per test run, by `template.global-setup.ts`.
 *
 * The copy is a file, because an in-memory SQLite database has no WAL and cannot be
 * shared by two connections. It is opened exactly as the controller opens its
 * own database: the controller lock file, the writer, the read-only reader, and
 * WAL. So a write outside `withTransaction` fails here as it does in production.
 */
export const TestDatabase: Layer.Layer<SqlClient.SqlClient, DatabaseError> = Layer.unwrap(
  Effect.map(createTemplateCopyFiles, openDatabase),
);

/**
 * Opens a new, empty database file in a temporary folder, which is deleted when
 * the layer's scope closes. Only the writer is open, so every statement runs on
 * it, inside a transaction or not.
 *
 * Only migration tests use this layer. They run part of the migrations, insert
 * fixture rows without a transaction, and run the rest, which is what the
 * controller does at boot: migrations run on the writer before the reader
 * exists. Any other test must use {@link TestDatabase}: a test on a client with
 * only a writer cannot notice a production write that runs outside a
 * transaction.
 */
export const TestDatabaseWriter: Layer.Layer<SqlClient.SqlClient, DatabaseError> = Layer.unwrap(
  Effect.map(createTemporaryDatabaseFiles, openDatabaseWriter),
);

/**
 * Runs a test's arranging writes (fixture rows, setup through a repository) in
 * a transaction, as production writes run. Fails with the effect's own error or
 * an `SqlError`.
 *
 * Never wrap the code under test with it: that code must open its own
 * transaction, so that a missing one still fails the test.
 */
export const inTransaction = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SqlError, R | SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => withTransaction(sql, effect));

/**
 * Builds a listener that stands in for the live socket, the only other
 * receiver of announcements. Returns the layer to provide as `AfterCommit`,
 * and the list the listener fills with every change announced after a
 * commit, in order.
 */
export const buildAnnouncementRecorder = (): {
  readonly listener: Layer.Layer<AfterCommit>;
  readonly announced: ReadonlyArray<Change>;
} => {
  const announced: Array<Change> = [];
  const listener = Layer.succeed(AfterCommit, {
    publish: (changes) =>
      Effect.sync(() => {
        announced.push(...changes);
      }),
  });
  return { listener, announced };
};
