/**
 * Tests what the entity fields migration does to a database at the previous
 * head: the table starts empty, holds one row per ref and key, and the
 * queries that narrow by a field's value use its indexes.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../migrate";
import { TestDatabaseWriter } from "../testing";
import { migrations } from "./index";

const UP_TO_FIELDS = migrations.filter(([id]) => id <= 120);

const explain = (sql: SqlClient.SqlClient, statement: string) =>
  sql
    .unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${statement}`)
    .pipe(Effect.map((rows) => rows.map((row) => row.detail).join("\n")));

describe("the entity fields migration", () => {
  it("creates an empty table that holds one row per ref and key", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(UP_TO_FIELDS);
        const empty = yield* sql`SELECT ref FROM external_entity_fields`;
        yield* sql`INSERT INTO external_entity_fields (ref, key, text_value) VALUES ('a', 'team', 'x')`;
        yield* sql`INSERT INTO external_entity_fields (ref, key, number_value) VALUES ('a', 'size', 3)`;
        const repeated = yield* Effect.exit(
          sql`INSERT INTO external_entity_fields (ref, key, text_value) VALUES ('a', 'team', 'y')`,
        );
        return { empty: empty.length, repeated: repeated._tag };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );
    expect(outcome).toEqual({ empty: 0, repeated: "Failure" });
  });

  it("narrows by a text or a number value through its own index", async () => {
    const plans = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(UP_TO_FIELDS);
        return {
          text: yield* explain(
            sql,
            `SELECT ref FROM external_entity_fields
             WHERE key = 'team' AND text_value = 'x' AND text_value IS NOT NULL`,
          ),
          number: yield* explain(
            sql,
            `SELECT ref FROM external_entity_fields
             WHERE key = 'size' AND number_value > 2 AND number_value IS NOT NULL`,
          ),
        };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );
    expect(plans.text).toMatch(/INDEX external_entity_fields_text/);
    expect(plans.number).toMatch(/INDEX external_entity_fields_number/);
  });
});
