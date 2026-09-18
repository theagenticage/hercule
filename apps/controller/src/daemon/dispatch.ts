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
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { SessionSpec, type SessionStart } from "@hydra/protocol";
import { withTransaction } from "../db";
import type { SessionTokens } from "../permissions";
import { RunnerConnections, runnerRepository } from "../runners";
import type { Secrets } from "../secrets";
import { SessionService } from "../sessions";
import { gitCredentials, gitIdentityOf } from "../workspaces";

const decodeSpec = Schema.decodeUnknownEffect(SessionSpec);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* SessionService;
  const runners = yield* runnerRepository;
  const connections = yield* RunnerConnections;
  const credentials = yield* gitCredentials;

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
            return yield* sessions.starting(runnerId, room);
          }),
        );
        // After the commit, because a transaction never spans a wait on a
        // machine, and a machine is never told about a row that may roll back.
        for (const row of ready) {
          // Read now rather than stored: a token is never written down anywhere
          // but the frame that carries it to the machine.
          const account =
            row.githubConnectionId === null
              ? undefined
              : yield* credentials.githubAccountOf(row.githubConnectionId);
          const start: SessionStart = {
            _tag: "sessionStart",
            sessionId: row.id,
            providerId: row.providerId,
            config: row.config as Schema.Json,
            // A defect, not a typed failure: the document was encoded by this
            // same codec at insert, so a decode failure means a spec field's
            // codec changed underneath a row already queued with the old one.
            spec: yield* Effect.orDie(decodeSpec(JSON.parse(row.spec))),
            token: row.token,
            ...(account === undefined
              ? {}
              : { ghToken: account.token, gitIdentity: gitIdentityOf(account.login) }),
            ...(row.checkoutBranch === null ? {} : { checkoutBranch: row.checkoutBranch }),
          };
          if (!(yield* connections.tell(runnerId, start))) yield* sessions.requeue(row.id);
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
  SqlClient.SqlClient | SessionService | RunnerConnections | Secrets | SessionTokens
> = Layer.effect(Dispatch)(make);
