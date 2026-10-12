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
import type * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { AfterCommit, type Change } from "./after-commit";
import { openDatabase, type DatabaseError } from "./client";

/**
 * Opens a copy of the migrated template database in a temporary folder, which
 * is deleted when the layer's scope closes. Each layer built from this one
 * gets its own copy, so tests never see each other's rows. The template is
 * migrated once per test run, by `template.global-setup.ts`.
 *
 * The copy is a file, not an in-memory database, because the driver opens a
 * database only by name. So a test database runs in WAL mode and holds its
 * file exclusively, as the controller's own database does.
 */
export const TestDatabase: Layer.Layer<
  SqlClient.SqlClient | SqliteClient.SqliteClient,
  SqlError | DatabaseError
> = Layer.unwrap(
  Effect.gen(function* () {
    const folder = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "hercule-test-db-"))),
      (created) => Effect.sync(() => rmSync(created, { recursive: true, force: true })),
    );
    const file = join(folder, "test.db");
    copyFileSync(inject("templateDatabase"), file);
    return openDatabase(file);
  }),
);

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
