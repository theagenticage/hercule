/**
 * Agent steps: the parts of the run engine (`engine.ts`) that only an agent
 * step has.
 *
 * An agent step is a workspace step, so the engine pins its run to a runner
 * as it does for a workspace action. What differs is how the step starts and
 * how it ends:
 *
 * - It starts by opening a session: the step's prompt, rendered for this
 *   iteration, becomes the first input of a new session of the step's
 *   Agent, or the next input of the session an earlier iteration ran in.
 *   The step record stores the session's id. The runner reports the turn
 *   that answers the prompt as the step's result.
 * - It ends with that result, whose output the runner has already checked
 *   against the step's `outputSchema`, or with a failure whose code names
 *   why: the turn's output did not match the schema, or the session ended
 *   before the turn did.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { isSqlError } from "effect/unstable/sql/SqlError";
import type { StepError, WorkflowDefinition } from "@hercule/contract";
import type { WorkspaceStepFailureCode } from "@hercule/protocol";
import { buildRunActor, CurrentActor } from "../actor";
import { agentRepository } from "../agents";
import { afterCommit, nowIso, withTransaction } from "../db";
import { renderTemplate } from "../expressions";
import { isLoggedIn, providerRepository } from "../providers";
import type { PlacementCandidate } from "../runners";
import { inputRepository, type StoredSession } from "../sessions";
import { RunExecutor } from "./executor";
import { runRepository, type ExecutionFailureReason, type StoredRun } from "./repository";
import { buildRunContext } from "./run-context";
import type { StepRecordKey } from "./step";
import { isUnfinished } from "./step-records";
import { WorkspaceSteps, type AgentStep, type OpenedStepSession } from "./workspace-steps";

/**
 * Returns the agent step of a run's plan with this id, or `undefined` when
 * the step with this id is not an agent step.
 */
export const findAgentStep = (plan: WorkflowDefinition, stepId: string): AgentStep | undefined => {
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  return step?.kind === "agent" ? step : undefined;
};

/**
 * Returns the session an agent step's next iteration continues: the session
 * of the step's latest record that has one. Returns `undefined` when the
 * step has `freshSession` set, or no earlier record has a session, so the
 * iteration starts a new session.
 */
const findPreviousStepSession = (run: StoredRun, step: AgentStep): string | undefined => {
  if (step.freshSession === true) return undefined;
  let latest: StoredRun["steps"][number] | undefined;
  for (const record of run.steps) {
    if (record.stepId !== step.id || record.sessionId === undefined) continue;
    if (latest === undefined || record.iteration > latest.iteration) latest = record;
  }
  return latest?.sessionId;
};

/**
 * Decides the reason a run fails with when one of its agent steps failed
 * with `code`, a code the runner reported:
 *
 * - `schema_failure`: the turn's output did not match the step's
 *   `outputSchema`, so the run fails with `schema-failure`;
 * - `session_failed`, or `interrupted` because the runner restarted while
 *   the turn ran: the session ended before the turn did, so the run fails
 *   with `session-failed`;
 * - any other code fails the run with `step-failed`. Those codes belong to
 *   workspace actions, and a runner sends none of them for an agent step.
 */
export const decideAgentStepFailureReason = (
  code: WorkspaceStepFailureCode,
): ExecutionFailureReason => {
  switch (code) {
    case "schema_failure":
      return "schema-failure";
    case "session_failed":
    case "interrupted":
      return "session-failed";
    case "action_failed":
    case "timeout":
    case "unsupported_action":
      return "step-failed";
  }
};

/** A step record, or its run, that ended in the transaction that tried to start it. */
export const ENDED = { _tag: "ended" } as const;

/** A step record that stays pending, because no runner can take its run now. */
export const WAITS_FOR_RUNNER = { _tag: "waitsForRunner" } as const;

/**
 * Where a workspace step of a run is to run, or why it does not start now:
 *
 * - `placed`: on this runner, in this workspace of the run, or in none for a
 *   run whose plan has no workspace;
 * - `ended`: the step and its run have failed;
 * - `waitsForRunner`: no runner can take the run now, and the step stays
 *   pending.
 *
 * The run engine decides it (`placeWorkspaceStep` in `engine.ts`), for an
 * action step and for an agent step alike.
 */
export type WorkspaceStepPlacement =
  | { readonly _tag: "placed"; readonly runnerId: string; readonly workspaceId: string | null }
  | typeof ENDED
  | typeof WAITS_FOR_RUNNER;

/**
 * What starting an agent step did:
 *
 * - `sessionOpened`: the record is `running` with its session, and `send`
 *   starts the session or delivers its prompt once the transaction commits;
 * - `ended`: the step and its run have failed;
 * - `waitsForRunner`: no runner can take the run now, and the record stays
 *   pending.
 */
export type AgentStepStartOutcome =
  | { readonly _tag: "sessionOpened"; readonly send: OpenedStepSession["send"] }
  | typeof ENDED
  | typeof WAITS_FOR_RUNNER;

/** The fields of a session that name the agent step it runs, if any. */
type SessionOfStep = Pick<StoredSession, "id" | "runId">;

/** What starting an agent step needs from the run engine. */
interface AgentStepNeeds {
  /** Fails a step record and its run, inside the caller's transaction. */
  readonly writeStepFailure: (
    runId: string,
    attempt: StepRecordKey,
    error: StepError,
    failureReason: ExecutionFailureReason,
    at: string,
  ) => Effect.Effect<void, SqlError>;
  /**
   * Pins the run to a runner, unless it is pinned already, and opens the
   * run's workspace there when its plan has one.
   */
  readonly placeOnRunner: (
    run: StoredRun,
    record: StepRecordKey,
    at: string,
  ) => Effect.Effect<WorkspaceStepPlacement, SqlError>;
}

/**
 * Builds the run engine's agent step operations:
 *
 * - `startAgentStep` starts an agent step's pending record;
 * - `filterAgentHosts` narrows the runners a run can be pinned to;
 * - `failStepsOfEndedSessions` and `failStepWithDroppedPrompt` fail a
 *   running agent step whose turn no runner will report.
 */
export const makeAgentSteps = ({ writeStepFailure, placeOnRunner }: AgentStepNeeds) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runs = yield* runRepository;
    const inputs = yield* inputRepository;
    const executor = yield* RunExecutor;
    const agents = yield* agentRepository;
    const providers = yield* providerRepository;
    const workspaceSteps = yield* WorkspaceSteps;

    /**
     * Returns the Agent's name and the ids of the runners that can host it:
     * those signed in to the Agent's provider instance. Returns `undefined`
     * when the Agent no longer exists. Placing the step's session refuses a
     * deleted Agent, with a message that says so.
     */
    const listAgentHosts = (
      agentId: string,
    ): Effect.Effect<
      { readonly agentName: string; readonly runnerIds: ReadonlySet<string> } | undefined,
      SqlError
    > =>
      Effect.gen(function* () {
        const agent = yield* agents.read(agentId);
        if (Option.isNone(agent)) return undefined;
        // The controller wrote every snapshot row itself, so one that does
        // not decode is a bug.
        const snapshots = yield* Effect.catchTag(
          providers.listSnapshots(agent.value.instanceId),
          "SchemaError",
          Effect.die,
        );
        return {
          agentName: agent.value.name,
          runnerIds: new Set(snapshots.filter(isLoggedIn).map((snapshot) => snapshot.runnerId)),
        };
      });

    /**
     * Returns the running record of the agent step that runs in `session`,
     * with its run's id. Returns `undefined` when no agent step started the
     * session, when the step's run has ended, or when no record of the step
     * is running in the session.
     */
    const findRunningStepOfSession = (
      session: SessionOfStep,
    ): Effect.Effect<
      { readonly runId: string; readonly record: StepRecordKey } | undefined,
      SqlError
    > =>
      Effect.gen(function* () {
        if (session.runId === null) return undefined;
        const run = yield* runs.read(session.runId);
        if (Option.isNone(run) || !isUnfinished(run.value.status)) return undefined;
        const record = run.value.steps.find(
          (candidate) => candidate.status === "running" && candidate.sessionId === session.id,
        );
        return record === undefined ? undefined : { runId: run.value.id, record };
      });

    /**
     * Fails a running agent step record with `session_failed`, and its run
     * with `session-failed`, inside the caller's transaction. Once the
     * transaction has committed, the Run Executor stops the run's execution,
     * which may still carry out a parallel controller step.
     */
    const failStepOfSession = (
      { runId, record }: { readonly runId: string; readonly record: StepRecordKey },
      message: string,
      at: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        yield* writeStepFailure(
          runId,
          record,
          { code: "session_failed", message },
          "session-failed",
          at,
        );
        yield* afterCommit(() => executor.stop([runId]));
      });

    return {
      /**
       * Fails the running agent step of each session in `ended`, sessions
       * the controller has just ended itself, with `message` as the step's
       * error. No runner saw those sessions end, so no runner will report
       * their steps' turns. Joins the caller's transaction, which ended the
       * sessions. A session that runs no agent step, or whose step has no
       * record running in it, is skipped.
       */
      failStepsOfEndedSessions: (
        ended: ReadonlyArray<SessionOfStep>,
        message: string,
      ): Effect.Effect<void, SqlError> =>
        Effect.gen(function* () {
          const at = yield* nowIso;
          for (const session of ended) {
            const step = yield* findRunningStepOfSession(session);
            if (step !== undefined) yield* failStepOfSession(step, message, at);
          }
        }),

      /**
       * Fails the running agent step of `session` with `message` as the
       * step's error, when the step's prompt was cancelled before a runner
       * took it: no runner saw the prompt, so none will report its turn.
       * Does nothing when the session runs no agent step, when its step has
       * no record running in it, or when the prompt was not cancelled. Joins
       * the caller's transaction as a savepoint.
       */
      failStepWithDroppedPrompt: (
        session: SessionOfStep,
        message: string,
      ): Effect.Effect<void, SqlError> =>
        withTransaction(
          sql,
          Effect.gen(function* () {
            const step = yield* findRunningStepOfSession(session);
            if (step === undefined) return;
            const prompt = yield* inputs.readStepInput(session.id, step.record.iteration);
            if (Option.isNone(prompt) || prompt.value.status !== "cancelled") return;
            yield* failStepOfSession(step, message, yield* nowIso);
          }),
        ),

      /**
       * Returns the runners among `candidates` that can host every agent
       * step of `plan`: those signed in to the provider instance of each
       * Agent the steps name. A plan with no agent step keeps every
       * candidate. Returns `noHost`, with a message for the user, when
       * `candidates` is not empty and none of them can: the message names
       * the Agents that no candidate can host, or every Agent of the plan
       * when each one has a host but no candidate hosts them all.
       *
       * A runner signed in to an instance stays a host while it is offline,
       * so a run whose host is offline waits for it rather than failing.
       */
      filterAgentHosts: (
        plan: WorkflowDefinition,
        candidates: ReadonlyArray<PlacementCandidate>,
      ): Effect.Effect<
        | { readonly _tag: "hosts"; readonly candidates: ReadonlyArray<PlacementCandidate> }
        | { readonly _tag: "noHost"; readonly message: string },
        SqlError
      > =>
        Effect.gen(function* () {
          const agentIds = [
            ...new Set(plan.steps.flatMap((step) => (step.kind === "agent" ? [step.agent] : []))),
          ];
          const hosts = (yield* Effect.forEach(agentIds, listAgentHosts)).filter(
            (agentHosts) => agentHosts !== undefined,
          );
          const hosting = candidates.filter((candidate) =>
            hosts.every(({ runnerIds }) => runnerIds.has(candidate.id)),
          );
          if (candidates.length === 0 || hosting.length > 0) {
            return { _tag: "hosts", candidates: hosting } as const;
          }
          const hostedByNone = hosts.filter(({ runnerIds }) =>
            candidates.every((candidate) => !runnerIds.has(candidate.id)),
          );
          const named = (hostedByNone.length > 0 ? hostedByNone : hosts).map(
            ({ agentName }) => agentName,
          );
          return {
            _tag: "noHost",
            message: `No runner that can take this run is signed in to the provider of ${named.join(" and ")}; sign a runner in, then start the run again.`,
          } as const;
        }),

      /**
       * Starts a pending record of an agent step, inside the caller's
       * transaction:
       *
       * 1. renders the step's prompt against the run's context;
       * 2. pins the run to a runner, if it is not pinned yet;
       * 3. opens the step's session on that runner (see
       *    `WorkspaceSteps.openSession`), as the run: a new session, or the
       *    next input of the session the step's latest iteration ran in;
       * 4. moves the record to `running` with the session's id.
       *
       * A prompt that cannot be rendered fails the step with
       * `expression_error`, and a session that cannot be opened fails it
       * with `session_failed`; the run fails with them. Fails with
       * `StepRecordEnded` when the record is no longer pending.
       */
      startAgentStep: (run: StoredRun, record: StepRecordKey, step: AgentStep, at: string) =>
        Effect.gen(function* () {
          const rendered = yield* Effect.result(renderTemplate(step.prompt, buildRunContext(run)));
          if (Result.isFailure(rendered)) {
            yield* writeStepFailure(
              run.id,
              record,
              {
                code: "expression_error",
                message: `The prompt of this step could not be rendered: ${rendered.failure.message}`,
              },
              "expression-error",
              at,
            );
            return ENDED satisfies AgentStepStartOutcome;
          }
          // A prompt that is exactly one expression renders to the
          // expression's value, which is text only when the value is.
          const prompt =
            typeof rendered.success === "string"
              ? rendered.success
              : JSON.stringify(rendered.success);
          const placed = yield* placeOnRunner(run, record, at);
          if (placed._tag !== "placed") return placed satisfies AgentStepStartOutcome;
          const opened = yield* Effect.result(
            Effect.provideService(
              workspaceSteps.openSession({
                step: { runId: run.id, stepId: record.stepId, iteration: record.iteration },
                definition: step,
                runnerId: placed.runnerId,
                workspaceId: placed.workspaceId,
                prompt,
                previousSessionId: findPreviousStepSession(run, step),
              }),
              CurrentActor,
              buildRunActor(run, record.stepId),
            ),
          );
          if (Result.isFailure(opened)) {
            if (isSqlError(opened.failure)) return yield* Effect.fail(opened.failure);
            yield* writeStepFailure(
              run.id,
              record,
              { code: "session_failed", message: opened.failure.message },
              "session-failed",
              at,
            );
            return ENDED satisfies AgentStepStartOutcome;
          }
          yield* runs.startStep(run.id, record, { sessionId: opened.success.sessionId }, at);
          return {
            _tag: "sessionOpened",
            send: opened.success.send,
          } satisfies AgentStepStartOutcome;
        }),
    };
  });
