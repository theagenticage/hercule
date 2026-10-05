/**
 * The sessions half of the runs domain's `WorkspaceSteps` port: opening the
 * session that one iteration of an agent step runs in, and stopping a run's
 * sessions when the run ends. `daemon/runs/workspace-steps.ts` serves the
 * port with these two methods beside its own.
 *
 * It holds no rule about runs. Placement and the live session operations do
 * the work; this file turns their refusals into the port's error, and sends
 * the frames once the caller's transaction has committed.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { isSqlError, type SqlError } from "effect/unstable/sql/SqlError";
import { formatIssue, InvalidState, NotFound, Validation, type Run } from "@hercule/contract";
import { buildRunActor, CurrentActor } from "../../actor";
import { withTransaction } from "../../db";
import type { GrantsError } from "../../permissions";
import { RunnerConnections } from "../../runners";
import { StepSessionRefused, type OpenedStepSession, type StepSessionToOpen } from "../../runs";
import { sessionRepository, SessionService } from "../../sessions";
import type { SettingError } from "../../settings";
import { WorkspaceService } from "../../workspaces";
import { absorbFailures } from "../absorbing";
import { makeForkAfterCommit } from "./after-commit";
import { Live } from "./live";
import { Placement } from "./placement";

/** An error placement or the live session operations refuse a step's session with. */
type SessionRefusal =
  InvalidState | NotFound | Validation | GrantsError | SettingError | Schema.SchemaError;

/** Returns the message of a refusal, with each issue of a `Validation` after it. */
const describeSessionRefusal = (refusal: SessionRefusal): string => {
  if (refusal instanceof Validation) {
    const { message, details } = refusal.error;
    return details.issues.length === 0
      ? message
      : `${message}: ${details.issues.map(formatIssue).join("; ")}`;
  }
  if (refusal instanceof InvalidState || refusal instanceof NotFound) {
    return refusal.error.message;
  }
  return refusal.message;
};

/**
 * Makes `openSession` and `stopSessions` of the `WorkspaceSteps` port (see
 * `runs/workspace-steps.ts` for what each one does).
 */
export const makeStepSessions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sessionRepository;
  const sessions = yield* SessionService;
  const placement = yield* Placement;
  const live = yield* Live;
  const workspaces = yield* WorkspaceService;
  const connections = yield* RunnerConnections;
  // Sends each stop once the run's ending commits.
  const sendAfterCommit = yield* makeForkAfterCommit;

  /**
   * Places the step's new session, or queues the prompt on its previous one.
   * Returns the session's id and its start or delivery.
   */
  const writeStepSession = (
    request: StepSessionToOpen,
  ): Effect.Effect<
    {
      readonly sessionId: string;
      readonly send: Effect.Effect<void, SessionRefusal | SqlError>;
    },
    SessionRefusal | SqlError
  > =>
    Effect.gen(function* () {
      const { step, definition, previousSessionId } = request;
      if (previousSessionId !== undefined) {
        const deliver = yield* live.queueStepInput(
          previousSessionId,
          request.prompt,
          step.iteration,
        );
        return { sessionId: previousSessionId, send: deliver };
      }
      const placed = yield* placement.placeStepSession({
        step,
        agentId: definition.agent,
        model: definition.model,
        options: definition.options,
        accessMode: definition.accessMode,
        outputSchema: definition.outputSchema,
        runnerId: request.runnerId,
        workspaceId: request.workspaceId,
        prompt: request.prompt,
        title: request.title,
      });
      return { sessionId: placed.sessionId, send: placed.start };
    });

  /**
   * Sends the provision of the run's workspace to its runner, when the
   * runner is connected and the workspace is still owed to it. The step that
   * pinned the run opened the workspace in the same transaction as the
   * session, so the runner may not have it yet. The runner ignores a
   * provision for a workspace it already holds.
   */
  const sendOwedProvision = (
    runnerId: string,
    workspaceId: string | null,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      if (workspaceId === null || !(yield* connections.holdsConnection(runnerId))) return;
      const provision = yield* workspaces.rebuildOwedProvision(workspaceId);
      if (Option.isSome(provision)) yield* connections.tell(runnerId, provision.value);
    });

  return {
    openSession: (
      request: StepSessionToOpen,
    ): Effect.Effect<OpenedStepSession, StepSessionRefused | SqlError> =>
      Effect.gen(function* () {
        // A savepoint, so that a refusal leaves no row behind in the caller's
        // transaction, which goes on to fail the step.
        const written = yield* Effect.result(withTransaction(sql, writeStepSession(request)));
        if (Result.isFailure(written)) {
          const refusal = written.failure;
          if (isSqlError(refusal)) return yield* Effect.fail(refusal);
          return yield* Effect.fail(
            new StepSessionRefused({
              message: `The step's session could not be opened: ${describeSessionRefusal(refusal)}`,
            }),
          );
        }
        const { sessionId, send } = written.success;
        return {
          sessionId,
          send: absorbFailures(
            `Could not send agent step ${request.step.stepId} of run ${request.step.runId} to its session; the controller delivers it later`,
            Effect.andThen(sendOwedProvision(request.runnerId, request.workspaceId), send),
          ),
        };
      }),

    stopSessions: (run: Pick<Run, "id" | "workflowId">): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        yield* sessions.cancelStepPromptsOfEndedRun(run.id);
        for (const session of yield* rows.listLiveInRun(run.id)) {
          // A session's run and step are written together, when it is created.
          if (session.stepId === null) {
            return yield* Effect.die(`session ${session.id} has a run and no step`);
          }
          // Each stop is the run's, at the step that started the session, so
          // its audit entry names the run rather than whoever ended it.
          const actor = buildRunActor(run, session.stepId);
          yield* Effect.provideService(
            sendAfterCommit(
              "Could not stop a session of an ended run",
              Effect.flatMap(live.stopSession(session), (stopped) =>
                stopped === "unreachable"
                  ? Effect.logWarning(
                      "A session of an ended run was not stopped: its runner is not connected",
                      { sessionId: session.id, runId: run.id, runnerId: session.runnerId },
                    )
                  : Effect.void,
              ),
            ),
            CurrentActor,
            actor,
          );
        }
      }),
  };
});
