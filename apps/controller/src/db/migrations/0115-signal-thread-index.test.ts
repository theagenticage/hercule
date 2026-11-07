/**
 * Tests the rules the signal thread index migration adds: the index that
 * answers a lookup of open signals by ref alone, the three reasons a timeline
 * row may have, and the JSON check on an entity's reason templates.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../migrate";
import { TestDatabaseWriter } from "../testing";
import { migrations } from "./index";

const UP_TO_SIGNAL_THREAD_INDEX = migrations.filter(([id]) => id <= 115);

const AT = "2026-11-01T00:00:00.000Z";

const migrated = Effect.gen(function* () {
  yield* runMigrations(UP_TO_SIGNAL_THREAD_INDEX);
  return yield* SqlClient.SqlClient;
});

describe("the signal thread index migration", () => {
  it("answers a lookup of open signals by ref alone from the partial index", async () => {
    const plan = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* migrated;
        return yield* sql<{ readonly detail: string }>`
          EXPLAIN QUERY PLAN
          SELECT id FROM signals WHERE status = 'open' AND thread_ref IN ('a', 'b')`;
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );
    expect(plan.map((row) => row.detail).join("\n")).toContain("signals_open_thread_ref");
  });

  it("refuses a timeline reason other than reassigned, moved and linked", async () => {
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* migrated;
        const insert = (reason: string) =>
          Effect.exit(
            sql`INSERT INTO external_entity_timeline (ref, reason, observed_at)
                VALUES ('github:pr:acme/api#1', ${reason}, ${AT})`,
          );
        return {
          reassigned: (yield* insert("reassigned"))._tag,
          moved: (yield* insert("moved"))._tag,
          linked: (yield* insert("linked"))._tag,
          other: (yield* insert("deleted"))._tag,
        };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );
    expect(results).toEqual({
      reassigned: "Success",
      moved: "Success",
      linked: "Success",
      other: "Failure",
    });
  });

  it("refuses reason templates that are not JSON", async () => {
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* migrated;
        const insert = (ref: string, templates: string | null) =>
          Effect.exit(
            sql`INSERT INTO external_entities (id, ref, kind, noun, completeness, title,
                                               first_observed_at, updated_at, reason_templates)
                VALUES (randomblob(16), ${ref}, 'github/issue', 'Issue', 'partial', 'A title',
                        ${AT}, ${AT}, ${templates})`,
          );
        return {
          json: (yield* insert("a", '{"mentioned":{"say":"{person} wrote","tone":"plain"}}'))._tag,
          none: (yield* insert("b", null))._tag,
          notJson: (yield* insert("c", "{oops"))._tag,
        };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );
    expect(results).toEqual({ json: "Success", none: "Success", notJson: "Failure" });
  });
});
