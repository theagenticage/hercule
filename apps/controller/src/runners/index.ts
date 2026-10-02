/**
 * Runners: the daemons that host sessions on the controller's behalf.
 *
 * This domain owns the runner rows and the live connections to runners, and
 * calls no other domain. When a runner reports something another domain acts
 * on, the report is published on `RunnerConnections`, and the layer above this
 * domain decides what to do about it.
 */
export { requireAdapter, requireOnline } from "./adapters";
export { RunnerJoinLayer } from "./join";
export { JoinTokens, JoinTokensLayer } from "./join-tokens";
export {
  LOCAL_RUNNER,
  LocalRunnerFailed,
  LocalRunnerId,
  startLocalRunner,
  type LocalRunner,
  type LocalRunnerOptions,
} from "./local";
export {
  RunnerFactsDeadline,
  RunnerConnections,
  RunnerConnectionsLayer,
  type Answer,
  type Connection,
  type FleetTraffic,
  type SessionTraffic,
} from "./connections";
export { buildOnlineClause, runnerRepository, type PlacementCandidate } from "./repository";
export { RunnerJoinRouteLayer } from "./route";
export { RunnerPingSchedule, RunnerSocketRouteLayer, type RunnerPings } from "./socket";
export {
  DRAINING,
  NO_SUCH_RUNNER,
  RETIRED,
  RunnerService,
  RunnerServiceLayer,
  type MoveError,
  type QueryInput,
  type RetireInput,
  type UpdateInput,
} from "./service";
