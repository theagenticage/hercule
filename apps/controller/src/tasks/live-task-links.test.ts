/** Tests the cost of the reads of the live links of Tasks, which must not follow finished work. */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { TestDatabase } from "../db/testing";
import { ALL_LIVE_TASK_LINKS_SQL, buildLiveTaskLinksSql, LIVE_TASK_LINKS_SQL } from "./repository";

/** Returns the lines of the query plan of `statement`. */
const readPlan = (statement: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${statement}`,
      );
      return rows.map((row) => row.detail);
    }).pipe(Effect.provide(TestDatabase)),
  );

describe("the live links of all refs", () => {
  it("start from the live Tasks and reach their links by key, so finished Tasks cost nothing", async () => {
    const plan = await readPlan(`SELECT ref FROM (${ALL_LIVE_TASK_LINKS_SQL})`);
    expect(
      plan.some((detail) => detail.startsWith("SCAN tasks USING INDEX tasks_board_rank")),
    ).toBe(true);
    expect(plan.some((detail) => detail.includes("SEARCH l USING PRIMARY KEY (task_id=?)"))).toBe(
      true,
    );
    expect(plan.some((detail) => detail.startsWith("SCAN l"))).toBe(false);
  });
});

describe("the live links of some refs", () => {
  it("seek the links of each ref, when the caller filters one ref", async () => {
    const plan = await readPlan(
      `SELECT task_id FROM (${LIVE_TASK_LINKS_SQL}) WHERE ref = 'acme:ticket:1'`,
    );
    expect(
      plan.some((detail) => detail.includes("USING INDEX task_entity_links_ref (ref=?)")),
    ).toBe(true);
    expect(plan.some((detail) => detail.startsWith("SCAN tasks"))).toBe(false);
  });

  it("seek the links of each ref, when the read is limited to some refs", async () => {
    const plan = await readPlan(
      `SELECT ref FROM (${buildLiveTaskLinksSql("l.ref IN (SELECT value FROM json_each('[\"acme:ticket:1\"]'))")})`,
    );
    expect(
      plan.some((detail) => detail.includes("USING INDEX task_entity_links_ref (ref=?)")),
    ).toBe(true);
    expect(plan.some((detail) => detail.startsWith("SCAN tasks"))).toBe(false);
  });
});
