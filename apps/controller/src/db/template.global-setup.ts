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
import { openDatabase } from "./client";
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
 */
export default async function migrateTemplateDatabase(project: TestProject): Promise<() => void> {
  const folder = mkdtempSync(join(tmpdir(), "hercule-test-template-"));
  const file = join(folder, "template.db");
  await Effect.runPromise(
    Effect.scoped(
      Layer.build(
        Layer.effectDiscard(runMigrations()).pipe(Layer.provideMerge(openDatabase(file))),
      ),
    ),
  );
  project.provide("templateDatabase", file);
  return () => rmSync(folder, { recursive: true, force: true });
}
