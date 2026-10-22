/**
 * Tests what the handoff run migration does to a database at the previous
 * head: the provenance entries written before it are indexed too, only the
 * handoff entries (those that name a signal), and the statement that finds a
 * handoff by its run and Task probes the index.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestDatabaseWriter } from "../testing";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 90);

const at = "2026-10-20T00:00:00.000Z";

describe("the handoff run migration", () => {
  it("indexes the handoff entries written before it, not the other entries, and the handoff lookup uses the index", async () => {
    const { indexSql, entries, plan } = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* sql`
          INSERT INTO tasks (id, title, description, status, priority, labels, created_at, updated_at, status_changed_at)
          VALUES (x'01', 'A task', '', 'in-progress', 'normal', '[]', ${at}, ${at}, ${at})`;
        // A handoff entry, then an entry that names a run but no signal.
        yield* sql`
          INSERT INTO task_provenance (id, task_id, run_id, signal_id, at, actor)
          VALUES (x'a1', x'01', x'0a', x'0b', ${at}, 'user')`;
        yield* sql`
          INSERT INTO task_provenance (id, task_id, run_id, at, actor)
          VALUES (x'a2', x'01', x'0c', ${at}, 'user')`;
        yield* runMigrations();
        const indexes = yield* sql<{ readonly sql: string }>`
          SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'task_provenance_handoff_run'`;
        const entries = yield* sql<{ readonly run: string }>`
          SELECT hex(run_id) AS run FROM task_provenance INDEXED BY task_provenance_handoff_run
          WHERE run_id IN (x'0a', x'0c') AND signal_id IS NOT NULL`;
        const plan = yield* sql<{ readonly detail: string }>`
          EXPLAIN QUERY PLAN
          SELECT signal_id FROM task_provenance
          WHERE run_id = x'0a' AND signal_id IS NOT NULL AND task_id = x'01'`;
        return {
          indexSql: indexes.map((index) => index.sql.replace(/\s+/g, " ").trim()),
          entries: entries.map((entry) => entry.run),
          plan: plan.map((step) => step.detail),
        };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(indexSql).toEqual([
      "CREATE INDEX task_provenance_handoff_run ON task_provenance (run_id, task_id) WHERE signal_id IS NOT NULL",
    ]);
    expect(entries).toEqual(["0A"]);
    expect(plan).toEqual([
      "SEARCH task_provenance USING INDEX task_provenance_handoff_run (run_id=? AND task_id=?)",
    ]);
  });
});
