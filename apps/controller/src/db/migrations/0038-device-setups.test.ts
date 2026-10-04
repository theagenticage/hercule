/**
 * Tests the rules the device-setups migration puts in the table itself, on an
 * in-memory database migrated up to and including this migration:
 *
 * - a well-formed row is accepted, with or without a connection to reconnect;
 * - the poll interval is a positive number of seconds;
 * - the JSON columns hold valid JSON.
 *
 * The setup-targets migration later rebuilt the table with rules of its own,
 * so the tests stop at this migration, and that migration's test covers the
 * later rules. The rows are written in plain SQL, so the table's checks are
 * tested on their own rather than behind the repository that already follows
 * them.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations up to and including the one under test. */
const MIGRATIONS_UP_TO_DEVICE_SETUPS = migrations.filter(([id]) => id <= 38);

/** Runs the effect on a fresh in-memory database that has the schema as of this migration. */
const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(
    Effect.andThen(runMigrations(MIGRATIONS_UP_TO_DEVICE_SETUPS), effect).pipe(
      Effect.provide(openDatabase(MEMORY)),
      Effect.orDie,
    ),
  );

const at = "2026-09-01T00:00:00.000Z";

/** The columns a test sets; every other column gets a valid value. */
interface Row {
  readonly setupId: string;
  readonly connectionId?: Uint8Array | null;
  readonly labels?: string;
  readonly config?: string;
  readonly interval?: number;
}

/**
 * Inserts one setup row and returns `accepted`, or SQLite's error message when
 * a constraint refuses the row.
 */
const insertRow = (row: Row) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* Effect.match(
      sql`
        INSERT INTO device_setups
          (setup_id, type, connection_id, label, labels, config, device_code,
           interval_seconds, next_poll_at, expires_at, created_at)
        VALUES
          (${row.setupId}, 'github/github', ${row.connectionId ?? null}, 'work',
           ${row.labels ?? '["Code"]'}, ${row.config ?? "{}"}, 'a-device-code',
           ${row.interval ?? 5}, ${at}, ${at}, ${at})`,
      {
        // The SQL error wraps a constraint error, which wraps SQLite's own
        // error, and only SQLite's message names the constraint.
        onFailure: (error) => String(error.cause.cause),
        onSuccess: () => "accepted",
      },
    );
  });

describe("the device_setups table", () => {
  it("accepts a new flow and a reconnect", async () => {
    const results = await run(
      Effect.all([
        insertRow({ setupId: "a" }),
        insertRow({ setupId: "b", connectionId: new Uint8Array(16).fill(1) }),
      ]),
    );

    expect(results).toEqual(["accepted", "accepted"]);
  });

  it("refuses a poll interval that is not a positive number of seconds", async () => {
    const results = await run(
      Effect.all([
        insertRow({ setupId: "a", interval: 0 }),
        insertRow({ setupId: "b", interval: -5 }),
      ]),
    );

    for (const result of results) expect(result).toContain("CHECK constraint failed");
  });

  it("refuses labels or config that are not valid JSON", async () => {
    const results = await run(
      Effect.all([
        insertRow({ setupId: "a", labels: "[not json" }),
        insertRow({ setupId: "b", config: "{not json" }),
      ]),
    );

    for (const result of results) expect(result).toContain("CHECK constraint failed");
  });

  it("refuses a second row with the same setup id", async () => {
    const results = await run(
      Effect.all([insertRow({ setupId: "a" }), insertRow({ setupId: "a" })]),
    );

    expect(results[0]).toBe("accepted");
    expect(results[1]).toContain("UNIQUE constraint failed");
  });
});
