/**
 * Asking a runner to report its facts now: `runner.refreshFacts`.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import {
  createInvalidStateError,
  type Id,
  type RunnerDetail,
  type Validation,
} from "@hercule/contract";
import { requireGrant } from "../../actor";
import {
  readRunnerOrFail,
  requireOnline,
  RunnerConnections,
  RunnerFactsDeadline,
  runnerRepository,
  type MoveError,
} from "../../runners";

const make = Effect.gen(function* () {
  const runners = yield* runnerRepository;
  const connections = yield* RunnerConnections;
  const readRunner = readRunnerOrFail(runners);

  return {
    /**
     * Asks the runner to report its facts now, and returns the updated runner.
     * Fails with `InvalidState` when the runner is not connected or does not
     * report in time. The runner reports by itself only hourly, and only when
     * something changed, so this is the only way to see a newly installed
     * harness CLI without waiting up to an hour.
     */
    refreshFacts: (id: Id): Effect.Effect<RunnerDetail, Exclude<MoveError, Validation>> =>
      Effect.gen(function* () {
        yield* requireGrant("runner.refreshFacts");
        const before = yield* readRunner(id);
        yield* requireOnline(before);
        if (!(yield* connections.refreshedFacts(id))) {
          const waited = Duration.format(yield* RunnerFactsDeadline);
          return yield* Effect.fail(
            createInvalidStateError(`that runner did not report its facts within ${waited}`),
          );
        }
        return yield* readRunner(id);
      }),
  };
});

export class FactsRefresh extends Context.Service<FactsRefresh, Effect.Success<typeof make>>()(
  "hercule/controller/daemon/FactsRefresh",
) {}

export const FactsRefreshLayer: Layer.Layer<
  FactsRefresh,
  never,
  SqlClient.SqlClient | RunnerConnections
> = Layer.effect(FactsRefresh)(make);
