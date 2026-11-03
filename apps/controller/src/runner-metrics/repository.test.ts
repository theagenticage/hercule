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
} from "./repository";

const RUNNER = "0199e0e7-7b21-7000-8000-000000000001";

const REQUEST: PointsRequest = {
  runnerId: undefined,
  resolution: "hour",
  sinceMs: 0,
  untilMs: 14 * 24 * 60 * 60 * 1000,
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

describe("the plan of a points query", () => {
  it("seeks the primary key for one runner", async () => {
    const plan = await readPlan((sql) =>
      buildPointsStatement(sql, { ...REQUEST, runnerId: RUNNER }, undefined),
    );
    expect(plan).toMatch(
      /SEARCH runner_metrics USING PRIMARY KEY \(runner_id=\? AND minute>\? AND minute<\?\)/,
    );
    expect(plan).not.toMatch(/SCAN runner_metrics/);
  });

  it("seeks the primary key once per runner for every runner", async () => {
    const plan = await readPlan((sql) => buildPointsStatement(sql, REQUEST, undefined));
    expect(plan).toMatch(
      /SEARCH runner_metrics USING PRIMARY KEY \(runner_id=\? AND minute>\? AND minute<\?\)/,
    );
    expect(plan).not.toMatch(/SCAN runner_metrics/);
  });

  it("still seeks the primary key on a page after the first", async () => {
    const plan = await readPlan((sql) =>
      buildPointsStatement(sql, REQUEST, { runnerId: RUNNER, minuteMs: 3_600_000 }),
    );
    expect(plan).toMatch(/SEARCH runner_metrics USING PRIMARY KEY/);
    expect(plan).not.toMatch(/SCAN runner_metrics/);
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
