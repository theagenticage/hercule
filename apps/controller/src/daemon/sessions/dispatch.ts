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
 * The GitHub Connections of all the sessions queued on the runner have their
 * tokens refreshed before the claim, outside its transaction: a refresh calls
 * GitHub, and a transaction never waits on anything outside the database.
 * The claim then reads the tokens plainly. The claim may skip some queued
 * sessions and take later ones, so every queued session's Connection is
 * refreshed, not just the oldest few. Callers wait for dispatch, so the wait
 * for the refreshes is bounded (`REFRESH_WAIT`).
 *
 * Each start frame carries the session's first input, and the runner answers
 * that input as it answers any `sessionInput`. The answer is recorded by the
 * same rule, so a start's input and an input sent on its own end up the same
 * way.
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { ConnectionTypes, githubTokens } from "../../connections";
import { withTransaction } from "../../db";
import { PluginHost } from "../../plugins";
import { PromotionState } from "../../promotion";
import { LocalRunnerId, RunnerConnections, runnerRepository } from "../../runners";
import { readInstanceSecrets, Secrets } from "../../secrets";
import { SessionService, type StartRequest } from "../../sessions";
import { githubAccounts } from "../../workspaces";
import { absorbFailures } from "../absorbing";
import { buildSessionCoordination } from "./coordination";

/**
 * How long one dispatch waits for the GitHub token refreshes. Requests and
 * resumes wait for dispatch, and one refresh can take much longer than this
 * (its request has a 30 s timeout). When the wait ends first, the sessions
 * start without a token that is still inside the refresh margin, and the
 * refresh finishes in the background.
 */
const REFRESH_WAIT = Duration.seconds(5);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* SessionService;
  const runners = yield* runnerRepository;
  const connections = yield* RunnerConnections;
  const accounts = yield* githubAccounts;
  const { readFreshGithubToken } = yield* githubTokens;
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
   * Returns the runner and the number of sessions it has room to start, or
   * `undefined` when it cannot start any now: it is unknown, offline, not
   * active, has not reported its sessions yet, is below its disk watermark, or
   * is at its cap.
   */
  const readRoom = (runnerId: string) =>
    Effect.gen(function* () {
      const found = yield* runners.read(runnerId);
      if (Option.isNone(found)) return undefined;
      const runner = found.value;
      if (runner.connectivity !== "online" || runner.lifecycle !== "active") return undefined;
      // Online means the socket is up, not that the runner has reported
      // its sessions yet. A start sent before that report arrives would
      // be missing from the report, so the report would mark it exited.
      if (!(yield* connections.hasReportedSessions(runnerId))) return undefined;
      const watermark = runner.watermark;
      // No watermark reported yet does not mean the disk is full.
      if (watermark !== null && watermark.diskFreeBytes < runner.diskWatermarkBytes) {
        return undefined;
      }
      const room = runner.maxConcurrentSessions - (yield* runners.runningSessions(runnerId));
      return room > 0 ? { runner, room } : undefined;
    });

  /**
   * Refreshes the tokens of the GitHub Connections of all this runner's queued
   * sessions, all at once, so the claim can read them plainly. A refresh only
   * calls GitHub for a token that is expired or inside the refresh margin;
   * otherwise it is a cheap read. It must run outside a transaction.
   *
   * The refreshes run on a fiber of this layer, and this waits for them at
   * most `REFRESH_WAIT`. A refresh that has started cannot be interrupted
   * (see `refreshTokens` in the Connections runtime), so one that is still
   * running when the wait ends carries on in the background and stores its new
   * token for the next start.
   *
   * A Connection that cannot give a token is logged as a warning and left
   * alone: the claim leaves the token off that session's start frame, and the
   * session starts without GitHub access.
   */
  const refreshGithubTokens = (runnerId: string): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const connectionIds = yield* sessions.listQueuedGithubConnectionIds(runnerId);
      if (connectionIds.length === 0) return;
      const refreshing = runInBackground(
        Effect.forEach(
          connectionIds,
          (connectionId) =>
            readFreshGithubToken(connectionId).pipe(
              Effect.asVoid,
              Effect.catchTag("GithubTokenUnavailable", (error) =>
                Effect.logWarning(
                  `Sessions queued on runner ${runnerId} start without a GitHub token: ${error.reason}`,
                ),
              ),
              // A defect (a database failure, a secret that does not decrypt)
              // is logged the same way: sessions that start without an
              // account are better than sessions that do not start. An
              // interruption is passed on.
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.failCause(cause)
                  : Effect.logError(
                      "A GitHub Connection could not be refreshed for a start",
                      cause,
                    ),
              ),
            ),
          { concurrency: "unbounded", discard: true },
        ),
      );
      // Timing out the join stops only the wait, not the fiber.
      yield* Effect.timeoutOption(Fiber.join(refreshing), REFRESH_WAIT);
    });

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
   *
   * The wait for the answer is not counted by the promotion gate, because a
   * freeze must not wait for a slow start. Recording the answer is counted:
   * it waits while a promotion freezes the controller, and never happens
   * once it is sealed. The new machine's copy then holds the session as
   * starting with its input unanswered, as it holds any step result a runner
   * reports after the copy.
   */
  const sendStart = (runnerId: string, start: StartRequest): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const sent = yield* connections.sendFrameCarryingInput(
        runnerId,
        start.frame,
        Duration.infinity,
      );
      yield* promotion.whenServing(
        Effect.gen(function* () {
          if (sent._tag === "notSent") return yield* sessions.requeue(start);
          // Only an unconfirmed step prompt needs anything more: a refusal is
          // recorded on the input, where its reader sees it, and nobody waits
          // on this start to be told.
          const recorded = yield* sessions.recordInputAnswer(start.input, sent, runnerId);
          if (recorded._tag === "unconfirmed") {
            yield* connections.tell(runnerId, recorded.resultRequest);
          }
        }),
      );
    });

  return {
    /**
     * Refreshes the tokens of the GitHub Connections of this runner's queued
     * sessions, waiting for that at most `REFRESH_WAIT`. Then moves its oldest
     * queued sessions to `starting`, as many as its
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
          // Skip the refresh when the runner cannot start anything now. The
          // room is read again inside the transaction, because the runner can
          // change while the refreshes run.
          if ((yield* readRoom(runnerId)) === undefined) return;
          yield* refreshGithubTokens(runnerId);
          const ready = yield* withTransaction(
            sql,
            Effect.gen(function* () {
              const claimable = yield* readRoom(runnerId);
              if (claimable === undefined) return [];
              const { runner, room } = claimable;
              return yield* sessions.claimStarts(runnerId, room, {
                readGithubAccount: accounts.readGithubAccount,
                readSecrets: (instanceId, providerId) =>
                  Effect.flatMap(host.providers(), (registered) =>
                    readInstanceSecrets(secrets, registered, instanceId, providerId),
                  ),
                buildCoordination: (sessionId) =>
                  Effect.provideService(
                    buildSessionCoordination(sessionId),
                    SqlClient.SqlClient,
                    sql,
                  ),
                runner,
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
  | ConnectionTypes
  | RunnerConnections
  | Secrets
  | PluginHost
  | LocalRunnerId
  | PromotionState
> = Layer.effect(Dispatch)(make);
