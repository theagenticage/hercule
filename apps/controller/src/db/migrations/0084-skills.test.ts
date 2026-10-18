/**
 * Tests the rules the Skill Library migration puts in the tables themselves,
 * on a migrated in-memory database:
 *
 * - a Skill's name is unique;
 * - an available revision differs from the current one;
 * - a revision's `applied_at` and `applied_by` are set together;
 * - two Skills may hold revisions with the same hash;
 * - the question "does any row name this hash" reads an index.
 *
 * The rows are written in plain SQL, so the tables' rules are tested on their
 * own rather than behind the service that already follows them.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestDatabase } from "../testing";

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, TestDatabase));

const at = "2026-10-18T00:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/** Turns a statement's outcome into `accepted`, or SQLite's error message when a constraint refuses it. */
const describeOutcome = <A, R>(
  statement: Effect.Effect<A, { readonly cause: unknown }, R>,
): Effect.Effect<string, never, R> =>
  Effect.match(statement, {
    // The SQL error wraps a constraint error, which wraps SQLite's own error,
    // and only SQLite's message names the constraint.
    onFailure: (error) => String((error.cause as { readonly cause: unknown }).cause),
    onSuccess: () => "accepted",
  });

/** Inserts a Skill with this one-byte id, and returns `accepted` or SQLite's error message. */
const insertSkill = (
  idByte: string,
  name: string,
  current: string | null,
  available: string | null,
) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    describeOutcome(
      sql`
        INSERT INTO skills
          (id, name, current_revision_hash, available_revision_hash, source,
           created_at, created_by, updated_at, updated_by)
        VALUES
          (${sql.literal(`x'${idByte.repeat(16)}'`)}, ${name}, ${current}, ${available},
           '{"kind":"upload"}', ${at}, 'user', ${at}, 'user')`,
    ),
  );

/** Inserts a revision of the Skill with this one-byte id, and returns `accepted` or SQLite's error message. */
const insertRevision = (
  idByte: string,
  hash: string,
  applied: { readonly at: string | null; readonly by: string | null },
) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    describeOutcome(
      sql`
        INSERT INTO skill_revisions
          (skill_id, hash, origin, file_count, size_bytes, description,
           created_at, created_by, applied_at, applied_by)
        VALUES
          (${sql.literal(`x'${idByte.repeat(16)}'`)}, ${hash}, 'import', 1, 10, 'A skill.',
           ${at}, 'user', ${applied.at}, ${applied.by})`,
    ),
  );

const APPLIED = { at, by: "user" };

describe("the skill tables", () => {
  it("refuses a second Skill with the same name", async () => {
    const outcomes = await run(
      Effect.all([insertSkill("01", "teach", null, null), insertSkill("02", "teach", null, null)]),
    );
    expect(outcomes[0]).toBe("accepted");
    expect(outcomes[1]).toContain("UNIQUE constraint failed: skills.name");
  });

  it("refuses an available revision equal to the current one, and accepts one beside no current revision", async () => {
    const outcomes = await run(
      Effect.all([
        insertSkill("01", "teach", HASH_A, HASH_A),
        insertSkill("02", "grill", HASH_A, HASH_B),
        insertSkill("03", "write", null, HASH_B),
      ]),
    );
    expect(outcomes[0]).toContain("CHECK constraint failed");
    expect(outcomes.slice(1)).toEqual(["accepted", "accepted"]);
  });

  it("sets a revision's applied time and actor together", async () => {
    const outcomes = await run(
      Effect.gen(function* () {
        yield* insertSkill("01", "teach", null, null);
        return yield* Effect.all([
          insertRevision("01", HASH_A, { at, by: null }),
          insertRevision("01", HASH_A, { at: null, by: "user" }),
          insertRevision("01", HASH_A, APPLIED),
          insertRevision("01", HASH_B, { at: null, by: null }),
        ]);
      }),
    );
    expect(outcomes[0]).toContain("CHECK constraint failed");
    expect(outcomes[1]).toContain("CHECK constraint failed");
    expect(outcomes.slice(2)).toEqual(["accepted", "accepted"]);
  });

  it("refuses a revision of a Skill that does not exist", async () => {
    const outcome = await run(insertRevision("09", HASH_A, APPLIED));
    expect(outcome).toContain("FOREIGN KEY constraint failed");
  });

  it("lets two Skills hold a revision with the same hash, and finds a hash through its index", async () => {
    const plan = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* insertSkill("01", "teach", null, null);
        yield* insertSkill("02", "grill", null, null);
        expect(yield* insertRevision("01", HASH_A, APPLIED)).toBe("accepted");
        expect(yield* insertRevision("02", HASH_A, APPLIED)).toBe("accepted");
        const rows = yield* sql<{ readonly detail: string }>`
          EXPLAIN QUERY PLAN SELECT 1 FROM skill_revisions WHERE hash = ${HASH_A} LIMIT 1
        `;
        return rows.map((row) => row.detail).join(" / ");
      }),
    );
    expect(plan).toContain("USING COVERING INDEX skill_revisions_hash");
  });
});
