/**
 * Tests that the SQL condition `buildReadableCondition` selects the same
 * things as the TypeScript rule `deriveAccess`, on a migrated database.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { inTransaction, TestDatabase } from "../db/testing";
import { buildReadableCondition, deriveAccess } from "./entity-records";

type Access = "ok" | "inaccessible" | "deleted";

const AT = "2026-03-01T00:00:00.000Z";
const FIRST_CONNECTION = new Uint8Array(16).fill(1);
const SECOND_CONNECTION = new Uint8Array(16).fill(2);

/** Every combination of what two Connections can report about one thing, and one thing nobody observed. */
const CASES: ReadonlyArray<ReadonlyArray<Access>> = [
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
        for (const id of [FIRST_CONNECTION, SECOND_CONNECTION]) {
          yield* sql`INSERT INTO connections (id, plugin_id, type, label, display_name, account_id,
              status, labels, config, created_at, updated_at)
            VALUES (${id}, 'acme', 'acme/account', ${`c${id[0]}`}, 'a', ${`a${id[0]}`},
              'connected', '[]', '{}', ${AT}, ${AT})`;
        }
        for (const [index, observations] of CASES.entries()) {
          const ref = `acme:ticket:${index}`;
          yield* sql`
            INSERT INTO external_entities (id, ref, kind, noun, completeness, title,
                source_updated_at, first_observed_at, updated_at)
            VALUES (${new Uint8Array(16).fill(index + 10)}, ${ref}, 'acme/ticket', 'N', 'full', 'T',
                ${AT}, ${AT}, ${AT})`;
          for (const [position, access] of observations.entries()) {
            yield* sql`
              INSERT INTO external_entity_observations (ref, connection_id, access)
              VALUES (${ref}, ${position === 0 ? FIRST_CONNECTION : SECOND_CONNECTION}, ${access})`;
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
    // Guards against both sides being empty or full by accident.
    expect(readable.length).toBeGreaterThan(0);
    expect(readable.length).toBeLessThan(CASES.length);
  });
});
