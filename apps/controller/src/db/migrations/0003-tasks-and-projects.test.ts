/**
 * Tests what the Task and Project migration creates, read back from
 * `sqlite_master` on a migrated in-memory database.
 *
 * "Applying the migrations twice is a no-op" is tested once for all of them,
 * in `db/migrate.test.ts`.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestDatabase } from "../testing";

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, TestDatabase));

interface SchemaRow {
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string | null;
}

const readSchemaRows = (type: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<SchemaRow>`
      SELECT name, tbl_name, sql FROM sqlite_master WHERE type = ${type} ORDER BY name
    `;
  });

/**
 * Returns how many rows a MATCH finds, so the test does not depend on how the
 * index stores them.
 */
const countMatches = (expression: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly n: number;
    }>`SELECT count(*) AS n FROM tasks_fts WHERE tasks_fts MATCH ${expression}`;
    return rows[0]?.n ?? 0;
  });

const TITLE = "Café Naïve reopening";
const DESCRIPTION = "The terrace needs a permit.";

/** Inserts one task row in plain SQL: triggers keep the index current, not a service. */
const insertTask = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO tasks
      (id, title, description, status, priority, created_at, updated_at, status_changed_at)
    VALUES
      (randomblob(16), ${TITLE}, ${DESCRIPTION}, 'open', 'normal',
       '2026-09-04T00:00:00.000Z', '2026-09-04T00:00:00.000Z', '2026-09-04T00:00:00.000Z')
  `;
});

describe("the Task and Project tables", () => {
  it("creates tasks, projects, task_provenance and project_resources", async () => {
    const names = (await run(readSchemaRows("table"))).map((row) => row.name);
    for (const table of ["tasks", "projects", "task_provenance", "project_resources"]) {
      expect(names, `${table} is missing`).toContain(table);
    }
  });

  it("indexes tasks and projects only over the live rows", async () => {
    const indexes = (await run(readSchemaRows("index"))).filter(
      // An index SQLite created itself for a UNIQUE or PRIMARY KEY column has
      // no SQL of its own and cannot have a WHERE clause.
      (row) => (row.tbl_name === "tasks" || row.tbl_name === "projects") && row.sql !== null,
    );
    expect(indexes.length).toBeGreaterThan(0);
    for (const index of indexes) {
      expect(index.sql, `${index.name} is not partial`).toMatch(
        /WHERE\s+"?deleted_at"?\s+IS\s+NULL/i,
      );
    }
  });

  it("serves both status queries from an index, without a temporary b-tree", async () => {
    const plans = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const explainQueryPlan = (statement: string) =>
          Effect.map(
            sql<{ readonly detail: string }>`${sql.literal(`EXPLAIN QUERY PLAN ${statement}`)}`,
            (rows) => rows.map((row) => row.detail).join(" / "),
          );
        return {
          sorted: yield* explainQueryPlan(`SELECT id FROM tasks WHERE deleted_at IS NULL
                               ORDER BY status ASC, id ASC LIMIT 51`),
          filtered: yield* explainQueryPlan(`SELECT id FROM tasks
                                 WHERE deleted_at IS NULL AND status IN ('open')
                                 ORDER BY updated_at DESC, id DESC LIMIT 51`),
        };
      }),
    );
    // A temporary b-tree sorts the whole matching set for every page, so page
    // one hundred costs as much as page one.
    expect(plans.sorted).toContain("SCAN tasks USING INDEX tasks_status");
    expect(plans.sorted).not.toContain("tasks_status_updated_at");
    expect(plans.sorted).not.toContain("TEMP B-TREE");
    expect(plans.filtered).toContain("tasks_status_updated_at");
    expect(plans.filtered).not.toContain("TEMP B-TREE");
  });

  it("keys project_resources on the pair, so one link is written once", async () => {
    const { table, refused } = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<SchemaRow>`
          SELECT name, tbl_name, sql FROM sqlite_master WHERE name = 'project_resources'
        `;
        yield* sql`INSERT INTO projects (id, name, created_at, updated_at)
                   VALUES (x'00000000000000000000000000000001', 'p', 'a', 'a')`;
        // The link points at a resource as well as at a project, so a resource
        // has to exist.
        yield* sql`INSERT INTO resources (id, kind, workspace_include, created_at, updated_at)
                   VALUES (x'00000000000000000000000000000002', 'folder', 0, 'a', 'a')`;
        const link = sql`INSERT INTO project_resources (project_id, resource_id)
                         VALUES (x'00000000000000000000000000000001',
                                 x'00000000000000000000000000000002')`;
        yield* link;
        const refused = yield* Effect.match(link, {
          onFailure: () => true,
          onSuccess: () => false,
        });
        return { table: rows[0]?.sql ?? "", refused };
      }),
    );
    expect(table).toMatch(/PRIMARY KEY\s*\(\s*project_id,\s*resource_id\s*\)/i);
    expect(refused).toBe(true);
  });

  it("creates the full-text index over tasks with the diacritic-folding tokenizer", async () => {
    const fts = (await run(readSchemaRows("table"))).find((row) => row.name === "tasks_fts");
    expect(fts?.sql ?? "").toMatch(/unicode61\s+remove_diacritics\s+2/);
  });

  it("creates the three triggers that keep the index on tasks current", async () => {
    const triggers = await run(readSchemaRows("trigger"));
    for (const name of ["tasks_fts_insert", "tasks_fts_delete", "tasks_fts_update"]) {
      expect(
        triggers.find((trigger) => trigger.name === name)?.tbl_name,
        `${name} is missing or is not on tasks`,
      ).toBe("tasks");
    }
  });
});

describe("the full-text index", () => {
  it("finds an inserted task by a word of its title, without its diacritics", async () => {
    const [cafe, terrace, absent] = await run(
      Effect.gen(function* () {
        yield* insertTask;
        return [
          yield* countMatches("cafe"),
          yield* countMatches("terrace"),
          yield* countMatches("permitted"),
        ];
      }),
    );
    expect({ cafe, terrace, absent }).toEqual({ cafe: 1, terrace: 1, absent: 0 });
  });

  it("follows an update and a delete of the row it indexes", async () => {
    const [before, after, gone] = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* insertTask;
        yield* sql`UPDATE tasks SET title = 'Bakery reopening'`;
        const before = yield* countMatches("cafe");
        const after = yield* countMatches("bakery");
        yield* sql`DELETE FROM tasks`;
        return [before, after, yield* countMatches("bakery")] as const;
      }),
    );
    expect({ before, after, gone }).toEqual({ before: 0, after: 1, gone: 0 });
  });
});
