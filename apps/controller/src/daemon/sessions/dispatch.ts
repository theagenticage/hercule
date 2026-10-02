/**
 * Starts as many queued sessions on a runner as it has room for.
 *
 * A runner has room when it is online, active, above its disk watermark and
 * below its session cap. Its oldest queued sessions are claimed in one
 * transaction, and then the runner is sent a frame to start each one.
 *
 * Everything that can give a runner room comes back through here: a session
 * ending, a workspace becoming ready, a watermark crossed, a cap raised, a
 * drain lifted, or a new connection. So one place decides what starts next,
 * and one frame starts it.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { ConnectionTypes } from "../../connections";
import { withTransaction } from "../../db";
import { PluginHost } from "../../plugins";
import { RunnerConnections, runnerRepository } from "../../runners";
import { readInstanceSecrets, Secrets } from "../../secrets";
import { SessionService } from "../../sessions";
import { githubAccounts } from "../../workspaces";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* SessionService;
  const runners = yield* runnerRepository;
  const connections = yield* RunnerConnections;
  const accounts = yield* githubAccounts;
  const secrets = yield* Secrets;
  const host = yield* PluginHost;

  return {
    /**
     * Moves this runner's oldest queued sessions to `starting`, as many as its
     * cap and its disk watermark allow, and sends the runner a frame to start
     * each one. If a frame cannot be sent, the session goes back to the queue,
     * and the next change to this runner's capacity tries again.
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
            // Online means the socket is up, not that the runner has reported
            // its sessions yet. A start sent before that report arrives would
            // be missing from the report, so the report would mark it exited.
            if (!(yield* connections.hasReportedSessions(runnerId))) return [];
            const watermark = runner.watermark;
            // No watermark reported yet does not mean the disk is full.
            if (watermark !== null && watermark.diskFreeBytes < runner.diskWatermarkBytes) {
              return [];
            }
            const room = runner.maxConcurrentSessions - (yield* runners.runningSessions(runnerId));
            if (room <= 0) return [];
            return yield* sessions.starting(runnerId, room, {
              readGithubAccount: accounts.readGithubAccount,
              secretsOf: (instanceId, providerId) =>
                Effect.flatMap(host.providers(), (registered) =>
                  readInstanceSecrets(secrets, registered, instanceId, providerId),
                ),
            });
          }),
        );
        // Send after the commit: a transaction never waits on a runner, and a
        // runner must never be told about a row that could still roll back.
        for (const { sessionId, frame } of ready) {
          if (!(yield* connections.tell(runnerId, frame))) yield* sessions.requeue(sessionId);
        }
      }),
  };
});

export class Dispatch extends Context.Service<Dispatch, Effect.Success<typeof make>>()(
  "hercule/controller/daemon/Dispatch",
) {}

export const DispatchLayer: Layer.Layer<
  Dispatch,
  never,
  SqlClient.SqlClient | SessionService | RunnerConnections | Secrets | PluginHost | ConnectionTypes
> = Layer.effect(Dispatch)(make);
