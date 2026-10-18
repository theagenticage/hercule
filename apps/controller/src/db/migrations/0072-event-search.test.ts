/**
 * Tests what the event search migration does to a database at the previous
 * head:
 *
 * - an event written before the migration is found by its title and author,
 *   and is no longer found once deleted;
 * - an event written after it is found, and is no longer found once deleted;
 * - the index stays consistent with the event log.
 *
 * The tests stop at this migration, so a later migration cannot change what
 * they check.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestDatabaseWriter } from "../testing";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 72);

/** The migrations up to and including the one under test. */
const UP_TO_EVENT_SEARCH = migrations.filter(([id]) => id <= 72);

const at = "2026-10-11T00:00:00.000Z";

/** Writes one event with that title and author, and a dedup key unique to it. */
const insertEvent = (dedupKey: string, title: string | null, author: string | null) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      INSERT INTO events
        (source, system, kind, occurred_at, received_at, dedup_key, payload, title, author)
      VALUES ('acme', 'acme', 'acme.thing.done', ${at}, ${at}, ${dedupKey}, '{}', ${title},
              ${author})`,
  );

/** Returns the ids of the events whose title or author match `query`, in id order. */
const searchEvents = (query: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(
      sql<{ readonly id: number }>`
        SELECT rowid AS id FROM events_fts WHERE events_fts MATCH ${query} ORDER BY rowid`,
      (rows) => rows.map((row) => row.id),
    ),
  );

describe("the event search migration", () => {
  it("indexes earlier events, keeps new and deleted events in step, and stays consistent", async () => {
    const checked = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* insertEvent("k1", "Bump lodash", "dependabot");
        yield* insertEvent("k2", null, null);
        yield* runMigrations(UP_TO_EVENT_SEARCH);

        const earlier = yield* searchEvents("dependabot");
        yield* insertEvent("k3", "Café opens", "octocat");
        const accentFolded = yield* searchEvents("cafe");
        yield* sql`DELETE FROM events WHERE id = 3`;
        const afterDelete = yield* searchEvents("cafe");
        yield* sql`DELETE FROM events WHERE id = 1`;
        const earlierAfterDelete = yield* searchEvents("dependabot");
        // Fails when the index holds terms the event log does not.
        yield* sql`INSERT INTO events_fts (events_fts, rank) VALUES ('integrity-check', 1)`;
        return { earlier, accentFolded, afterDelete, earlierAfterDelete };
      }).pipe(Effect.provide(TestDatabaseWriter)),
    );

    expect(checked).toEqual({
      earlier: [1],
      accentFolded: [3],
      afterDelete: [],
      earlierAfterDelete: [],
    });
  });
});
