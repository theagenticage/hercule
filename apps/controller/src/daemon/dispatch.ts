/**
 * Starting what a machine has room for: the oldest queued sessions of a runner
 * that is online, active, above its watermark and not yet full, claimed as one
 * write set and then told to the machine.
 *
 * Everything that can give a machine room - a session ending, a workspace
 * coming up, a watermark crossed, a cap raised, a drain lifted, a new
 * connection - comes back through here, so there is one place that decides what
 * starts next and one frame that starts it.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { withTransaction } from "../db";
import { PluginHost } from "../plugins";
import type { SessionTokens } from "../permissions";
import { RunnerConnections, runnerRepository } from "../runners";
import { instanceSecrets, Secrets } from "../secrets";
import { SessionService } from "../sessions";
import { gitCredentials } from "../workspaces";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* SessionService;
  const runners = yield* runnerRepository;
  const connections = yield* RunnerConnections;
  const credentials = yield* gitCredentials;
  const secrets = yield* Secrets;
  const host = yield* PluginHost;

  return {
    /**
     * Moves this runner's oldest queued sessions to `starting`, as many as its
     * cap and its disk watermark allow, and tells the machine to start each. A
     * start the machine does not take goes back to the queue, for the next
     * thing that changes this runner's capacity to try again.
     */
    dispatch: (runnerId: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const ready = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const found = yield* runners.read(runnerId);
            if (Option.isNone(found)) return [];
            const runner = found.value;
            if (runner.connectivity !== "online" || runner.lifecycle !== "active") return [];
            // Online says the socket is up, not that this connection has said
            // what it holds yet: a start sent before its report lands would be
            // one this report itself then reads as exited.
            if (!(yield* connections.hasReportedSessions(runnerId))) return [];
            const watermark = runner.watermark;
            // A watermark nobody has reported yet is not a machine that said no.
            if (watermark !== null && watermark.diskFreeBytes < runner.diskWatermarkBytes) {
              return [];
            }
            const room = runner.maxConcurrentSessions - (yield* runners.runningSessions(runnerId));
            if (room <= 0) return [];
            return yield* sessions.starting(runnerId, room, {
              accountOf: credentials.githubAccountOf,
              secretsOf: (instanceId, providerId) =>
                Effect.flatMap(host.providers(), (registered) =>
                  instanceSecrets(secrets, registered, instanceId, providerId),
                ),
            });
          }),
        );
        // After the commit, because a transaction never spans a wait on a
        // machine, and a machine is never told about a row that may roll back.
        for (const { sessionId, frame } of ready) {
          if (!(yield* connections.tell(runnerId, frame))) yield* sessions.requeue(sessionId);
        }
      }),
  };
});

export class Dispatch extends Context.Service<Dispatch, Effect.Success<typeof make>>()(
  "hydra/controller/daemon/Dispatch",
) {}

export const DispatchLayer: Layer.Layer<
  Dispatch,
  never,
  SqlClient.SqlClient | SessionService | RunnerConnections | Secrets | SessionTokens | PluginHost
> = Layer.effect(Dispatch)(make);
