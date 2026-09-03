/**
 * The database layer tests run against: `:memory:` with the production
 * migration set applied (spec 04, Repository interfaces). There are no mock
 * repositories, and migration drift is caught by every test run.
 */
import * as Layer from "effect/Layer";
import type { PlatformError } from "effect/PlatformError";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as Migrator from "effect/unstable/sql/Migrator";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { MEMORY, openDatabase, type JournalModeError } from "./client";
import { runMigrations } from "./migrate";

export const TestDatabase: Layer.Layer<
  SqlClient.SqlClient | SqliteClient.SqliteClient,
  SqlError | JournalModeError | Migrator.MigrationError | PlatformError
> = Layer.effectDiscard(runMigrations).pipe(Layer.provideMerge(openDatabase(MEMORY)));
