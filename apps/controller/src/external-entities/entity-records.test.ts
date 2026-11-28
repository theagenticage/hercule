/**
 * Tests that the SQL condition `buildReadableCondition` selects the same
 * things as the TypeScript rule `deriveAccess`, on a migrated database, and
 * that the restricted places (`isRestrictedPlace`) are the things it leaves out.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { inTransaction, TestDatabase } from "../db/testing";
import {
  buildReadableCondition,
  deriveAccess,
  isRestrictedPlace,
  type EntityAccess,
} from "./entity-records";

const AT = "2026-03-01T00:00:00.000Z";
const FIRST_CONNECTION = new Uint8Array(16).fill(1);
const SECOND_CONNECTION = new Uint8Array(16).fill(2);

/** What two Connections can report about one thing, and one thing nobody observed. */
const CASES: ReadonlyArray<ReadonlyArray<EntityAccess>> = [
  [],
  ["ok"],
  ["inaccessible"],
  ["deleted"],
  ["ok", "inaccessible"],
  ["inaccessible", "ok"],
  ["deleted", "ok"],
  ["deleted", "inaccessible"],
  ["ok", "ok"],
  ["inaccessible", "inaccessible"],
];

describe("the readable condition", () => {
  it("selects exactly the things deriveAccess calls ok", async () => {
    const readable = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // The second Connection is disabled: a disabled Connection still counts as
        // reading, unlike in the acting filter of the workflow offers.
        for (const [id, status] of [
          [FIRST_CONNECTION, "connected"],
          [SECOND_CONNECTION, "disabled"],
        ] as const) {
          yield* sql`INSERT INTO connections (id, plugin_id, type, label, display_name, account_id,
              status, labels, config, created_at, updated_at)
            VALUES (${id}, 'acme', 'acme/account', ${`c${id[0]}`}, 'a', ${`a${id[0]}`},
              ${status}, '[]', '{}', ${AT}, ${AT})`;
        }
        for (const [index, observations] of CASES.entries()) {
          const ref = `acme:ticket:${index}`;
          yield* sql`
            INSERT INTO external_entities (id, ref, kind, noun, completeness, title,
                source_updated_at, first_observed_at, updated_at)
            VALUES (${new Uint8Array(16).fill(index + 10)}, ${ref}, 'acme/ticket', 'N', 'full', 'T',
                ${AT}, ${AT}, ${AT})`;
          for (const [position, access] of observations.entries()) {
            // A refused observation still reports a concern: that makes it
            // "observing" (OBSERVING_SQL) but never "readable".
            yield* sql`
              INSERT INTO external_entity_observations (ref, connection_id, access, concerns)
              VALUES (${ref}, ${position === 0 ? FIRST_CONNECTION : SECOND_CONNECTION}, ${access},
                ${access === "ok" ? "[]" : '["assigned"]'})`;
          }
        }
        const rows = yield* sql<{ readonly ref: string }>`
          SELECT t.ref FROM external_entities t
          WHERE ${sql.literal(buildReadableCondition("t"))} ORDER BY t.ref`;
        return rows.map((row) => row.ref);
      }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
    );

    const expected = CASES.flatMap((observations, index) =>
      deriveAccess(observations.map((access) => ({ access }))) === "ok"
        ? [`acme:ticket:${index}`]
        : [],
    ).sort();
    expect(readable).toEqual(expected);
    // The rows above have no pace, so none is a work record: each is a place, and a place is
    // restricted exactly when the condition leaves it out.
    const restricted = CASES.flatMap((observations, index) =>
      isRestrictedPlace({
        isWorkRecord: false,
        access: deriveAccess(observations.map((access) => ({ access }))),
      })
        ? [`acme:ticket:${index}`]
        : [],
    ).sort();
    expect([...readable, ...restricted].sort()).toEqual(
      CASES.map((_, index) => `acme:ticket:${index}`).sort(),
    );
    // Guards against both sides being empty or full by accident.
    expect(readable.length).toBeGreaterThan(0);
    expect(readable.length).toBeLessThan(CASES.length);
  });
});

describe("isRestrictedPlace", () => {
  it.each([
    [false, "ok", false],
    [false, "inaccessible", true],
    [false, "deleted", true],
    [true, "ok", false],
    [true, "inaccessible", false],
    [true, "deleted", false],
  ] as const)(
    "for a record with isWorkRecord %s and access %s answers %s",
    (isWorkRecord, access, restricted) => {
      expect(isRestrictedPlace({ isWorkRecord, access })).toBe(restricted);
    },
  );
});
