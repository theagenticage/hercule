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
  buildNextMinuteStatement,
  buildPruneStatement,
  buildRecordStatement,
  buildRunnerBatchStatement,
  computeRunnerBatchSize,
  planReads,
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

const OTHER_RUNNER = "0199e0e7-7b21-7000-8000-000000000002";

const READ_RANGE =
  /SEARCH runner_metrics USING PRIMARY KEY \(runner_id=\? AND minute>\? AND minute<\?\)/g;

const THIRD_RUNNER = "0199e0e7-7b21-7000-8000-000000000003";

/** Reads the plan of the page that `request` asks for after `resume`, with `later` the runners it takes. */
const readPagePlan = (
  request: PointsRequest,
  resume: Resume | undefined,
  later: ReadonlyArray<string> = [],
): Promise<string> =>
  readPlan((sql) => buildPointsStatement(sql, request, planReads(request, resume, later)));

describe("the plan of a points query", () => {
  it("seeks the primary key for one runner, on the first page and after a cursor", async () => {
    const request = { ...REQUEST, runnerId: RUNNER };
    for (const resume of [undefined, { runnerId: RUNNER, minuteMs: 3 * HOUR_MS }]) {
      const plan = await readPagePlan(request, resume);
      expect(plan.match(READ_RANGE)).toHaveLength(1);
      expect(plan).not.toMatch(/SCAN runner_metrics/);
    }
  });

  it("seeks the primary key for the runners it takes, on the first page", async () => {
    const plan = await readPagePlan(REQUEST, undefined, [RUNNER, OTHER_RUNNER]);
    expect(plan.match(READ_RANGE)).toHaveLength(1);
    expect(plan).not.toMatch(/SCAN runner_metrics/);
  });

  it("after a cursor, seeks the cursor's runner and then the runners it takes, each by the primary key", async () => {
    const plan = await readPagePlan(REQUEST, { runnerId: RUNNER, minuteMs: 3 * HOUR_MS }, [
      OTHER_RUNNER,
      THIRD_RUNNER,
    ]);
    expect(plan.match(READ_RANGE)).toHaveLength(2);
    expect(plan).not.toMatch(/SCAN runner_metrics/);
  });
});

describe("the plan of the list of the next runners", () => {
  it("walks the runners' primary key in order and stops at the count, with no sort", async () => {
    // From the start, the walk begins at the first entry: it is a scan of an
    // ordered index that LIMIT cuts short. After a runner, it seeks.
    const first = await readPlan((sql) => buildRunnerBatchStatement(sql, undefined, 5));
    expect(first).toMatch(/SCAN runners USING COVERING INDEX sqlite_autoindex_runners_1/);
    const later = await readPlan((sql) => buildRunnerBatchStatement(sql, RUNNER, 5));
    expect(later).toMatch(/SEARCH runners USING COVERING INDEX sqlite_autoindex_runners_1/);
    expect(`${first}\n${later}`).not.toMatch(/TEMP B-TREE/);
  });
});

describe("how many runners a read for every runner takes", () => {
  it("is enough to fill a page, and one more", () => {
    // 14 days of hour points: 336 + 1 points per runner. 501 points need two runners, plus one.
    expect(computeRunnerBatchSize({ ...REQUEST, limit: 500 })).toBe(3);
    expect(computeRunnerBatchSize({ ...REQUEST, limit: 50 })).toBe(2);
    // A span of three hours holds 4 points per runner at most, so 11 points need three, plus one.
    expect(computeRunnerBatchSize({ ...REQUEST, endMs: 3 * HOUR_MS, limit: 10 })).toBe(4);
  });
});

describe("the ranges a page reads", () => {
  it("for one runner start at the cursor and end after a page of points", () => {
    const request = { ...REQUEST, runnerId: RUNNER, limit: 10 };
    expect(planReads(request, undefined, [])).toEqual([
      { runners: { kind: "one", runnerId: RUNNER }, fromMs: 0, toMs: 11 * HOUR_MS },
    ]);
    expect(planReads(request, { runnerId: RUNNER, minuteMs: 11 * HOUR_MS }, [])).toEqual([
      { runners: { kind: "one", runnerId: RUNNER }, fromMs: 11 * HOUR_MS, toMs: 22 * HOUR_MS },
    ]);
  });

  it("for one runner end with the span", () => {
    const request = { ...REQUEST, runnerId: RUNNER, limit: 10, endMs: 5 * HOUR_MS };
    expect(planReads(request, undefined, [])).toEqual([
      { runners: { kind: "one", runnerId: RUNNER }, fromMs: 0, toMs: 5 * HOUR_MS },
    ]);
  });

  it("for every runner take the runners listed, whole", () => {
    expect(planReads(REQUEST, undefined, [RUNNER, OTHER_RUNNER])).toEqual([
      {
        runners: { kind: "these", runnerIds: [RUNNER, OTHER_RUNNER] },
        fromMs: 0,
        toMs: 14 * DAY_MS,
      },
    ]);
  });

  it("for every runner after a cursor start at the cursor's runner, then take the runners listed", () => {
    expect(
      planReads(REQUEST, { runnerId: OTHER_RUNNER, minuteMs: 3 * HOUR_MS }, [THIRD_RUNNER]),
    ).toEqual([
      { runners: { kind: "one", runnerId: OTHER_RUNNER }, fromMs: 3 * HOUR_MS, toMs: 14 * DAY_MS },
      { runners: { kind: "these", runnerIds: [THIRD_RUNNER] }, fromMs: 0, toMs: 14 * DAY_MS },
    ]);
  });
});

describe("the plan of the look for the next row", () => {
  it("reads one entry of the primary key", async () => {
    const plan = await readPlan((sql) => buildNextMinuteStatement(sql, RUNNER, 0, DAY_MS));
    expect(plan.match(READ_RANGE)).toHaveLength(1);
    expect(plan).not.toMatch(/SCAN|TEMP B-TREE/);
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
