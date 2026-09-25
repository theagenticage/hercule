/**
 * The only consumer of what the fleet reports:
 *
 * - the sessions a runner holds, and what happens in them;
 * - the result of provisioning a workspace;
 * - the git credentials a runner asks for;
 * - every change that may have given a runner room for more work.
 *
 * There are two queues, each read by its own fiber. Session traffic has its
 * own queue, so a session's events are applied in the order the runner
 * numbered them, and the rest of the fleet's reports do not wait behind them.
 * Work that waits on a runner, such as a flush or a dispatch, is forked and
 * never done inline. A failure in one item is logged and dropped, so one
 * report that fails to write does not stop the traffic of every other runner.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { AssistantMessages } from "../../assistants";
import { withTransaction } from "../../db";
import { RunnerConnections, type FleetTraffic, type SessionTraffic } from "../../runners";
import { SessionService } from "../../sessions";
import { WorkspaceService } from "../../workspaces";
import { absorbFailures, forkAndAbsorbFailures } from "../absorbing";
import { Dispatch, Live } from "../sessions";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const connections = yield* RunnerConnections;
  const sessions = yield* SessionService;
  const workspaces = yield* WorkspaceService;
  const { dispatch } = yield* Dispatch;
  const { flush, deliverQueuedInput } = yield* Live;
  const assistantMessages = yield* AssistantMessages;

  const applyFleetTraffic = (traffic: FleetTraffic): Effect.Effect<void, SqlError> => {
    switch (traffic._tag) {
      case "workspaceReported":
        return Effect.gen(function* () {
          // This is the only place the two domains meet. The workspaces domain
          // records the runner's report, and the sessions domain decides what
          // it means for the sessions waiting on the workspace. Both writes
          // are one transaction, so a failed workspace and the sessions it
          // strands are updated together or not at all.
          const settled = yield* withTransaction(
            sql,
            Effect.gen(function* () {
              const settled = yield* workspaces.reported(traffic.runnerId, traffic.report);
              // A workspace that failed to provision ends the sessions waiting
              // on it, with the runner's error message as the reason.
              if (settled?.moved === "failed") {
                yield* sessions.endForWorkspace(
                  settled.workspaceId,
                  traffic.report.message ?? null,
                );
              }
              return settled;
            }),
          );
          // A workspace that became ready lets its waiting sessions start. The
          // dispatch sends frames to the runner, so it runs after the commit,
          // on its own fiber.
          if (settled?.moved === "ready") {
            yield* forkAndAbsorbFailures(
              "Dispatching sessions to a ready workspace failed",
              dispatch(traffic.runnerId),
            );
          }
        });
      case "credentialRequested":
        // The credential is valid for this one request only, so it is sent
        // straight back on the connection that asked, and never stored.
        return Effect.flatMap(
          workspaces.credentialAnswer(traffic.runnerId, traffic.request),
          (answer) => Effect.asVoid(connections.tell(traffic.runnerId, answer)),
        );
      case "placementsChanged":
        // Forked, like the dispatch for a ready workspace: filling a runner's
        // free room takes a transaction and a credential read per session, and
        // the rest of the fleet must not wait behind one runner.
        return forkAndAbsorbFailures(
          "Dispatching to a freed slot failed",
          dispatch(traffic.runnerId),
        );
    }
  };

  const ingestSessionTraffic = (traffic: SessionTraffic): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      if (traffic.frame._tag === "sessionsReport") {
        const ended = yield* sessions.bound(traffic.runnerId, traffic.frame.sessions);
        // Mark the runner only after the write is committed. The mark lives in
        // a `Map`, which does not roll back, so a report that failed to write
        // must not make the runner dispatchable.
        yield* connections.markSessionsReported(traffic.runnerId, traffic.connection);
        // A process for a session the controller has already ended keeps
        // running without a token, and it blocks a resume of that session on
        // the runner. Nothing else would stop it, so the runner is told to.
        for (const id of ended) {
          yield* connections.tell(traffic.runnerId, sessions.stopping(id));
        }
        yield* forkAndAbsorbFailures(
          "Dispatching after a runner's sessions report failed",
          dispatch(traffic.runnerId),
        );
        return;
      }
      const { seq, event } = traffic.frame;
      // The fold reads and publishes but writes nothing, so it runs outside
      // the transaction. A browser watching the session gets the delta
      // whether or not the write succeeds.
      const report = yield* sessions.foldReport(traffic.runnerId, seq, event);
      if (report === undefined) return;
      const applied = yield* withTransaction(
        sql,
        Effect.gen(function* () {
          const applied = yield* sessions.applyReport(traffic.runnerId, event, report);
          // Same transaction as the session's write. A session starting or
          // ending counts as activity in its workspace, which keeps the
          // workspace from expiring while in use.
          if (applied.worked !== undefined) {
            yield* workspaces.touched(applied.worked.workspaceId, applied.worked.at);
          }
          // Same transaction again, so a conversation's messages and the
          // transcript they are read from never disagree after a crash. The
          // assistants domain decides what the report means for the
          // conversation.
          yield* assistantMessages.recordSessionReport(report.session, event);
          return applied;
        }),
      );
      // A session that went idle can take its queued input. A session that
      // exited has freed a slot on its runner.
      if (applied.moved === "idle") {
        yield* forkAndAbsorbFailures(
          "Sending a session's queued input failed",
          flush(event.sessionId),
        );
      }
      if (applied.moved === "exited") {
        yield* forkAndAbsorbFailures(
          "Dispatching to a freed slot failed",
          dispatch(traffic.runnerId),
        );
      }
      // A session the runner unloaded while input waited for it is resumed
      // in place, so the input runs.
      if (applied.unloadedHoldingInput === true) {
        yield* forkAndAbsorbFailures(
          "Resuming an unloaded session for its waiting input failed",
          deliverQueuedInput(event.sessionId),
        );
      }
    });

  return {
    driving: Stream.runForEach(connections.fleetTraffic, (traffic) =>
      absorbFailures("Applying a runner's report failed", applyFleetTraffic(traffic)),
    ),

    ingesting: Stream.runForEach(connections.sessionTraffic, (traffic) =>
      absorbFailures("Recording a session report failed", ingestSessionTraffic(traffic)),
    ),
  };
});

export class Inbound extends Context.Service<Inbound, Effect.Success<typeof make>>()(
  "hercule/controller/daemon/Inbound",
) {}

export const InboundLayer: Layer.Layer<
  Inbound,
  never,
  | SqlClient.SqlClient
  | RunnerConnections
  | SessionService
  | WorkspaceService
  | Dispatch
  | Live
  | AssistantMessages
> = Layer.effect(Inbound)(make);
