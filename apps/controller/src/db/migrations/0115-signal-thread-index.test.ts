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
  it("answers a lookup of signals by ref alone, open or not, from one index", async () => {
    const plans = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* migrated;
        const explain = (where: string) =>
          Effect.map(
            sql.unsafe<{ readonly detail: string }>(
              `EXPLAIN QUERY PLAN SELECT id FROM signals WHERE ${where}`,
            ),
            (rows) => rows.map((row) => row.detail).join("\n"),
          );
        return {
          open: yield* explain("status = 'open' AND thread_ref IN ('a', 'b')"),
          any: yield* explain("thread_ref = 'a'"),
        };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );
    expect(plans.open).toMatch(/SEARCH signals USING (COVERING )?INDEX signals_thread_ref/);
    expect(plans.any).toMatch(/SEARCH signals USING (COVERING )?INDEX signals_thread_ref/);
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

  it("marks a claim whose target is pending, and serves the due ones from a partial index", async () => {
    const { pending, plan } = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* migrated;
        yield* sql`INSERT INTO external_entity_relation_claims
          (from_ref, relation, to_ref, claim_type, actor, evidence_key, state, observed_at)
          VALUES ('a:x:1', 'linked', 'unresolved:url:https://x.test', 'person', 'user', '', 'current', ${AT}),
                 ('a:x:1', 'linked', 'a:x:2', 'person', 'user', '', 'current', ${AT})`;
        const pending = yield* sql<{ readonly to_ref: string; readonly is_pending: number }>`
          SELECT to_ref, is_pending FROM external_entity_relation_claims ORDER BY id`;
        const plan = yield* sql<{ readonly detail: string }>`
          EXPLAIN QUERY PLAN
          SELECT id FROM external_entity_relation_claims
          WHERE is_pending = 1 AND next_resolve_at <= ${AT}`;
        return { pending, plan };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );
    expect(pending).toEqual([
      { to_ref: "unresolved:url:https://x.test", is_pending: 1 },
      { to_ref: "a:x:2", is_pending: 0 },
    ]);
    expect(plan.map((row) => row.detail).join("\n")).toContain("external_entity_claims_pending");
  });
});
