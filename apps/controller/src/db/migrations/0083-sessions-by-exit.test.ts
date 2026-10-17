/**
 * Tests that the sessions-by-exit migration adds the index on
 * `sessions (status, exited_at)`, and that the session list filtered with
 * `activeSince` finds its sessions through that index, one lookup per half
 * of the filter, instead of scanning every session.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";

describe("the sessions-by-exit migration", () => {
  it("adds an index that both halves of the activeSince filter search", async () => {
    const plan = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        // The shape of the session list's source for `activeSince`.
        return yield* sql<{ readonly detail: string }>`
          EXPLAIN QUERY PLAN
          SELECT sessions.id FROM
            (SELECT id AS active_id FROM sessions
             WHERE status IN ('queued', 'starting', 'idle', 'busy')
             UNION ALL
             SELECT id FROM sessions
             WHERE status = 'exited' AND exited_at >= '2026-09-07T12:00:00.000Z')
            CROSS JOIN sessions ON id = active_id
          WHERE agent_id IS NOT NULL
          ORDER BY created_at DESC, id DESC`;
      }).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie),
    );

    const details = plan.map((step) => step.detail);
    expect(details).toContain("SEARCH sessions USING INDEX sessions_status_exited (status=?)");
    expect(details).toContain(
      "SEARCH sessions USING INDEX sessions_status_exited (status=? AND exited_at>?)",
    );
    expect(details.some((detail) => detail.startsWith("SCAN sessions"))).toBe(false);
  });
});
