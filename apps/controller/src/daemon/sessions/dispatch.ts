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
 *
 * Each start frame carries the session's first input, and the runner answers
 * that input as it answers any `sessionInput`. The answer is recorded by the
 * same rule, so a start's input and an input sent on its own end up the same
 * way.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { withTransaction } from "../../db";
import { PluginHost } from "../../plugins";
import { PromotionState } from "../../promotion";
import { LocalRunnerId, RunnerConnections, runnerRepository } from "../../runners";
import { readInstanceSecrets, Secrets } from "../../secrets";
import { SessionService, type StartRequest } from "../../sessions";
import { githubAccounts } from "../../workspaces";
import { absorbFailures } from "../absorbing";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* SessionService;
  const runners = yield* runnerRepository;
  const connections = yield* RunnerConnections;
  const accounts = yield* githubAccounts;
  const secrets = yield* Secrets;
  const host = yield* PluginHost;
  const localRunnerId = yield* LocalRunnerId;
  const promotion = yield* PromotionState;
  // Each start waits for the runner's answer on a fiber of its own, owned by
  // this layer and not by the caller: a dispatch runs on a request's or a
  // driver item's fiber, which ends long before the answer comes. The fibers
  // end with the controller.
  const runInBackground = yield* FiberSet.makeRuntime();

  /**
   * Sends one start frame and records the answer to the input it carries.
   *
   * When the runner is not connected, the frame is never sent, and the
   * session and its input go back to the queue (`SessionService.requeue`), so
   * the next change to this runner's capacity tries again.
   *
   * Otherwise the wait has no deadline, unlike a `sessionInput`'s. The answer
   * comes only after the harness has started, and a start can take a while:
   * a cold harness, a large checkout. The wait still ends when the connection
   * does, so a runner that stops answering pings ends it, and the answer is
   * then recorded as missing, as for any input on the wire. A refused or
   * missing answer puts the input back to waiting with the reason, for the
   * next send of the session's input. The one exception is an agent step's
   * prompt with a missing answer: the runner may have run it, so it is
   * marked `sent` and never sent again (`SessionService.recordInputAnswer`),
   * and the runner is asked for the step's result instead. The wait ended
   * with the connection, so the request is sent only when the runner has
   * connected again by then. Otherwise the runner is asked when it connects.
   */
  const sendStart = (runnerId: string, start: StartRequest): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const sent = yield* connections.sendFrameCarryingInput(
        runnerId,
        start.frame,
        Duration.infinity,
      );
      if (sent._tag === "notSent") return yield* sessions.requeue(start);
      // Only an unconfirmed step prompt needs anything more: a refusal is
      // recorded on the input, where its reader sees it, and nobody waits on
      // this start to be told.
      const recorded = yield* sessions.recordInputAnswer(start.input, sent, runnerId);
      if (recorded._tag === "unconfirmed") {
        yield* connections.tell(runnerId, recorded.resultRequest);
      }
    });

  return {
    /**
     * Moves this runner's oldest queued sessions to `starting`, as many as its
     * cap and its disk watermark allow, and sends the runner a frame to start
     * each one, carrying the input the session starts with (`sendStart`).
     * The answers are recorded later, on fibers of their own.
     *
     * Waits while a promotion freezes the controller, and never claims
     * anything once it is sealed. The new machine's copy of the data still
     * has these sessions queued, so it starts them itself when the runner
     * connects to it. A session this controller claimed and started after
     * the copy would start twice. The claim is counted, so a freeze waits for
     * it. The start frames go out on fibers of their own: each one waits for
     * the runner as long as the start takes, and a freeze must not wait for
     * that.
     */
    dispatch: (runnerId: string): Effect.Effect<void, SqlError> =>
      promotion.whenServing(
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
              const room =
                runner.maxConcurrentSessions - (yield* runners.runningSessions(runnerId));
              if (room <= 0) return [];
              return yield* sessions.claimStarts(runnerId, room, {
                readGithubAccount: accounts.readGithubAccount,
                readSecrets: (instanceId, providerId) =>
                  Effect.flatMap(host.providers(), (registered) =>
                    readInstanceSecrets(secrets, registered, instanceId, providerId),
                  ),
                localRunnerId: localRunnerId.read(),
              });
            }),
          );
          // Send after the commit: a transaction never waits on a runner, and a
          // runner must never be told about a row that could still roll back.
          for (const start of ready) {
            runInBackground(
              absorbFailures(
                "Sending a session's start, or recording the answer to it, failed",
                sendStart(runnerId, start),
              ),
            );
          }
        }),
      ),
  };
});

export class Dispatch extends Context.Service<Dispatch, Effect.Success<typeof make>>()(
  "hercule/controller/daemon/Dispatch",
) {}

export const DispatchLayer: Layer.Layer<
  Dispatch,
  never,
  | SqlClient.SqlClient
  | SessionService
  | RunnerConnections
  | Secrets
  | PluginHost
  | LocalRunnerId
  | PromotionState
> = Layer.effect(Dispatch)(make);
