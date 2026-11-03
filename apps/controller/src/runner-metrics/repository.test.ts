/**
 * Tests that the statements of the Runner Metrics history reach their rows
 * through an index, by reading SQLite's query plan for each. A table that
 * grows by a row per runner per minute turns a scan into a slow request, and
 * the result of a scan is the same as the result of a seek, so only the plan
 * shows it.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { TestDatabase } from "../db/testing";
import {
  buildPointsStatement,
  buildPruneStatement,
  buildRecordStatement,
  type PointsRequest,
  type Resume,
} from "./repository";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const RUNNER = "0199e0e7-7b21-7000-8000-000000000001";

const REQUEST: PointsRequest = {
  runnerId: undefined,
  resolution: "hour",
  since: "1970-01-01T00:00:00.000Z",
  until: undefined,
  startMs: 0,
  endMs: 14 * DAY_MS,
  limit: 500,
  cursor: undefined,
};

/** Returns the lines of the plan SQLite makes for a statement, as the text it prints. */
const readPlan = (
  build: (sql: SqlClient.SqlClient) => {
    readonly compile: () => readonly [string, ReadonlyArray<unknown>];
  },
): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [text, params] = build(sql).compile();
      const rows = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${text}`,
        params,
      );
      return rows.map((row) => row.detail).join("\n");
    }).pipe(Effect.provide(TestDatabase), Effect.orDie),
  );

const READ_RANGE =
  /SEARCH runner_metrics USING PRIMARY KEY \(runner_id=\? AND minute>\? AND minute<\?\)/g;

/** Reads the plan of the page that `request` asks for after `resume`. */
const readPagePlan = (request: PointsRequest, resume: Resume | undefined): Promise<string> =>
  readPlan((sql) => buildPointsStatement(sql, request, resume));

/**
 * The inner select walks the primary key in order, so nothing sorts the rows
 * before the cap. Only the grouping into points uses a temporary b-tree.
 */
const expectKeyOrderWalk = (plan: string, ranges: number): void => {
  expect(plan.match(READ_RANGE)).toHaveLength(ranges);
  expect(plan).not.toMatch(/SCAN runner_metrics/);
  expect(plan.match(/TEMP B-TREE/g) ?? []).toEqual(["TEMP B-TREE"]);
  expect(plan).toMatch(/USE TEMP B-TREE FOR GROUP BY/);
};

describe("the plan of a points query", () => {
  const resume = { runnerId: RUNNER, minuteMs: 3 * HOUR_MS };

  it("for one runner walks the primary key in order, on the first page and after a cursor", async () => {
    const request = { ...REQUEST, runnerId: RUNNER };
    expectKeyOrderWalk(await readPagePlan(request, undefined), 1);
    expectKeyOrderWalk(await readPagePlan(request, resume), 1);
  });

  it("for every runner walks the primary key in order, on the first page", async () => {
    expectKeyOrderWalk(await readPagePlan(REQUEST, undefined), 1);
  });

  it("for every runner after a cursor merges the cursor's runner and the runners after it, both by the primary key", async () => {
    const plan = await readPagePlan(REQUEST, resume);
    expectKeyOrderWalk(plan, 2);
    expect(plan).toMatch(/MERGE \(UNION ALL\)/);
  });
});

describe("the plan of the prune", () => {
  it("seeks the primary key, one range per runner, rather than reading every row", async () => {
    const plan = await readPlan((sql) => buildPruneStatement(sql, 1_000));
    expect(plan).toMatch(/SEARCH runner_metrics USING PRIMARY KEY \(runner_id=\? AND minute<\?\)/);
    expect(plan).not.toMatch(/SCAN runner_metrics/);
  });
});

describe("the plan of the session counts a report is recorded with", () => {
  it("reads the index of the runner's sessions that have not exited, not its whole history", async () => {
    const plan = await readPlan((sql) =>
      buildRecordStatement(sql, RUNNER, 0, { diskFreeBytes: 1, availableMemoryBytes: 1 }),
    );
    expect(plan).toMatch(
      /SEARCH sessions USING (COVERING )?INDEX sessions_live_by_runner \(runner_id=\?\)/,
    );
    expect(plan).not.toMatch(/SCAN sessions/);
  });
});
