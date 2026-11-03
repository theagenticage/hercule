/**
 * Runner Metrics history: one row of each runner's metrics per minute, kept
 * for `retention.runnerMetrics` days, and read as points of five minutes or
 * one hour.
 *
 * The runners domain owns the runner rows and the latest report. This domain
 * owns the history that grows from those reports.
 */
export {
  RunnerMetricsService,
  RunnerMetricsServiceLayer,
  type QueryInput,
  type RunnerMetricsPage,
} from "./service";
