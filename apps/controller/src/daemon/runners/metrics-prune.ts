/**
 * The hourly prune of the Runner Metrics history.
 *
 * The rule itself is `RunnerMetricsService.prune`: which rows go. This module
 * only repeats it.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { PromotionState } from "../../promotion";
import { RunnerMetricsService } from "../../runner-metrics";
import { absorbFailures } from "../absorbing";

/**
 * How often the prune runs. The table grows by one row per runner per
 * minute, so an hour is short enough to keep it near its retention window
 * and long enough that the delete is a small share of the controller's work.
 */
const RUNNER_METRICS_PRUNE_INTERVAL: Duration.Duration = Duration.hours(1);

/** The prune interval. Tests override it with a shorter one. */
export const RunnerMetricsPruneInterval = Context.Reference<Duration.Duration>(
  "hercule/controller/daemon/RunnerMetricsPruneInterval",
  { defaultValue: (): Duration.Duration => RUNNER_METRICS_PRUNE_INTERVAL },
);

/**
 * Deletes the Runner Metrics rows older than `retention.runnerMetrics` at
 * once, then again after each `RunnerMetricsPruneInterval`. Never returns. A
 * pass that fails is logged, and the next one runs.
 *
 * A pass runs only while the controller serves, so a frozen or sealed
 * controller deletes nothing.
 */
export const runRunnerMetricsPruneLoop: Effect.Effect<
  never,
  never,
  RunnerMetricsService | PromotionState
> = Effect.gen(function* () {
  const runnerMetrics = yield* RunnerMetricsService;
  const interval = yield* RunnerMetricsPruneInterval;
  const promotion = yield* PromotionState;
  while (true) {
    yield* absorbFailures(
      "Pruning the Runner Metrics history failed",
      promotion.whenServing(
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          runnerMetrics.prune(new Date(now).toISOString()),
        ),
      ),
    );
    yield* Effect.sleep(interval);
  }
});
