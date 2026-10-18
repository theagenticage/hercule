/**
 * The vitest global setup that migrates the template database the `node` and
 * `node-isolated` projects copy for each test (see `TestDatabase` in
 * `testing.ts`).
 *
 * Running the migrations takes about 65 ms, and nearly every controller test
 * needs a fresh database. Copying a migrated file takes well under a
 * millisecond, so the migrations run once per test run, here, and each test
 * opens its own copy. Every test run still checks the migrations.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { TestProject } from "vitest/node";
import { openDatabaseWriter } from "./client";
import { runMigrations } from "./migrate";

declare module "vitest" {
  export interface ProvidedContext {
    /** The path of the migrated template database. */
    readonly templateDatabase: string;
  }
}

/**
 * Migrates a new database file in a temporary folder and provides its path to
 * the tests as `templateDatabase`. Returns the teardown that deletes the
 * folder after the run.
 *
 * The migrations run on the writer, as they do at boot. The lock file sits
 * beside the database and is released when the migrations finish; the tests
 * copy only the database file.
 */
export default async function migrateTemplateDatabase(project: TestProject): Promise<() => void> {
  const folder = mkdtempSync(join(tmpdir(), "hercule-test-template-"));
  const files = {
    databaseFile: join(folder, "template.db"),
    controllerLockFile: join(folder, "controller.lock"),
  };
  await Effect.runPromise(
    Effect.scoped(
      Layer.build(
        Layer.effectDiscard(runMigrations()).pipe(Layer.provideMerge(openDatabaseWriter(files))),
      ),
    ),
  );
  project.provide("templateDatabase", files.databaseFile);
  return () => rmSync(folder, { recursive: true, force: true });
}
