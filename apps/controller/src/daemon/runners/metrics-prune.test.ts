/**
 * Tests for the hourly prune of the Runner Metrics history: it runs at once,
 * then every hour, and deletes what is older than the retention window.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import { withTransaction } from "../../db";
import { TestDatabase } from "../../db/testing";
import { ServingPromotionStateLayer } from "../../promotion/testing";
import { RunnerMetricsService, RunnerMetricsServiceLayer } from "../../runner-metrics";
import { runnerRepository } from "../../runners";
import { SettingsLayer } from "../../settings";
import { runRunnerMetricsPruneLoop } from "./metrics-prune";

const layer = RunnerMetricsServiceLayer.pipe(
  Layer.provideMerge(SettingsLayer),
  Layer.provideMerge(ServingPromotionStateLayer),
  Layer.provideMerge(TestDatabase),
);

const START = Date.parse("2026-11-03T12:00:00.000Z");
const DAY = 24 * 60 * 60_000;

describe("runRunnerMetricsPruneLoop", () => {
  it("deletes the history older than the retention window at once, and again every hour", async () => {
    const counts = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const sql = yield* SqlClient.SqlClient;
        const service = yield* RunnerMetricsService;
        const runners = yield* runnerRepository;
        const runner = yield* withTransaction(
          sql,
          runners.insert({
            name: "laptop",
            connectivity: "online",
            lifecycle: "active",
            reserved: false,
            labels: [],
            credentialHash: "hash-laptop",
            at: new Date(START).toISOString(),
          }),
        );
        const metrics = { diskFreeBytes: 1, availableMemoryBytes: 1 };
        const recordDaysAgo = (days: number) =>
          withTransaction(
            sql,
            service.record(runner.id, metrics, new Date(START - days * DAY).toISOString()),
          );
        const countRows = Effect.map(
          sql<{ readonly count: number }>`SELECT count(*) AS count FROM runner_metrics`,
          (rows) => rows[0]?.count ?? 0,
        );

        yield* recordDaysAgo(20);
        yield* recordDaysAgo(1);
        const loop = yield* Effect.forkChild(runRunnerMetricsPruneLoop);
        yield* TestClock.adjust(Duration.zero);
        const atStart = yield* countRows;

        // Too old to keep, but written after the first pass: it waits for the next one.
        yield* recordDaysAgo(14.01);
        yield* TestClock.adjust(Duration.minutes(59));
        const beforeTheHour = yield* countRows;
        yield* TestClock.adjust(Duration.minutes(1));
        const afterTheHour = yield* countRows;
        yield* Fiber.interrupt(loop);
        return { atStart, beforeTheHour, afterTheHour };
      }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer()), Effect.orDie),
    );

    expect(counts).toEqual({ atStart: 1, beforeTheHour: 2, afterTheHour: 1 });
  });
});
