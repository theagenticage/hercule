/** Tests the cost of the Inbox relation, which must follow the things on the Inbox and not every record. */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { TestDatabase } from "../db/testing";
import { buildEligibleEntities } from "./inbox-relation";

describe("buildEligibleEntities", () => {
  it("reaches the records by the refs that concern the user, link a live Task or hold a signal, without scanning every record", async () => {
    const eligible = buildEligibleEntities({ askingKinds: [] });
    const plan = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN WITH ${eligible.sql} SELECT ref FROM eligible`,
          eligible.params,
        );
        return rows.map((row) => row.detail);
      }).pipe(Effect.provide(TestDatabase)),
    );
    expect(plan.some((detail) => /^SCAN e\b/.test(detail))).toBe(false);
    expect(plan.some((detail) => detail.includes("SEARCH e USING INDEX"))).toBe(true);
  });
});
