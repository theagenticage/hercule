/** Tests the cost of the read of the live links of Tasks, which must not follow finished work. */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { TestDatabase } from "../db/testing";
import { buildLiveTaskLinksSql, LIVE_TASK_LINKS_SQL } from "./repository";

const readPlan = (statement: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN SELECT ref FROM (${statement})`,
      );
      return rows.map((row) => row.detail);
    }).pipe(Effect.provide(TestDatabase)),
  );

describe("the live links of Tasks", () => {
  it("starts from the live Tasks and reaches their links by key, so finished Tasks cost nothing", async () => {
    const plan = await readPlan(LIVE_TASK_LINKS_SQL);
    expect(
      plan.some((detail) => detail.startsWith("SCAN tasks USING INDEX tasks_board_rank")),
    ).toBe(true);
    expect(plan.some((detail) => detail.includes("SEARCH l USING PRIMARY KEY (task_id=?)"))).toBe(
      true,
    );
    expect(plan.some((detail) => detail.startsWith("SCAN l"))).toBe(false);
  });

  it("seeks the links of each ref when the read is limited to some refs", async () => {
    const plan = await readPlan(
      buildLiveTaskLinksSql("l.ref IN (SELECT value FROM json_each('[\"acme:ticket:1\"]'))"),
    );
    expect(
      plan.some((detail) => detail.includes("USING INDEX task_entity_links_ref (ref=?)")),
    ).toBe(true);
    expect(plan.some((detail) => detail.startsWith("SCAN tasks"))).toBe(false);
  });
});
