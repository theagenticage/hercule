/**
 * The database layer that tests run against: an in-memory database with the
 * production migrations applied (spec 04, Repository interfaces). There are no
 * mock repositories, so every test run also checks the migrations.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as Migrator from "effect/unstable/sql/Migrator";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { AfterCommit, type Change } from "./after-commit";
import { MEMORY, openDatabase, type DatabaseError } from "./client";
import { runMigrations } from "./migrate";

export const TestDatabase: Layer.Layer<
  SqlClient.SqlClient | SqliteClient.SqliteClient,
  SqlError | DatabaseError | Migrator.MigrationError
> = Layer.effectDiscard(runMigrations()).pipe(Layer.provideMerge(openDatabase(MEMORY)));

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
