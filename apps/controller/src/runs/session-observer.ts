/**
 * The runs domain's implementation of the sessions domain's `SessionObserver`
 * port. It fails an agent step whose turn no runner will ever report, so the
 * step's run does not wait for a result that never comes. The step fails
 * with `session_failed`, and its run with `session-failed`.
 *
 * A runner reports the step's turn whenever it saw the step's prompt, even
 * when the session ends in the middle of the turn. So the step fails here
 * only when no runner saw the session end, or no runner saw the prompt:
 *
 * - the controller ended the session itself, because its runner was lost
 *   (`runner_lost`) or retired (`runner_retired`);
 * - the session exited, or could not be resumed, and the step's prompt was
 *   cancelled before a runner took it.
 *
 * Anything else is left alone, an idle unload between two iterations
 * included: the next iteration's prompt resumes the session.
 *
 * The run engine fails the step, but this observer cannot reach the engine
 * directly. The engine opens step sessions through the session service, and
 * the session service is built with this observer, so their layers would
 * need each other. Instead, the engine registers its handler in
 * `StepSessionFailures` when it is built, and the observer calls that. Boot
 * builds every layer before any session can change, so the handler is
 * registered by the time the observer needs it.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { inputRepository, SessionObserver, type StoredSession } from "../sessions";
import { runRepository } from "./repository";
import type { StepRecordKey } from "./step";
import { isUnfinished } from "./step-records";

/** A running agent step record to fail, because no runner will report its turn. */
export interface StepToFail {
  readonly runId: string;
  readonly record: StepRecordKey;
  /** Why the step fails, for the step's error. */
  readonly message: string;
}

/** Fails a running agent step record, and its run, inside the caller's transaction. */
type FailStep = (step: StepToFail) => Effect.Effect<void, SqlError>;

/** Where the run engine registers how it fails an agent step whose turn will never be reported. */
export class StepSessionFailures extends Context.Service<
  StepSessionFailures,
  {
    /** Registers the run engine's handler. The engine calls this once, when it is built. */
    readonly register: (failStep: FailStep) => void;
    /**
     * Fails the step through the registered handler. Dies when no handler is
     * registered, which only a controller built without its run engine can
     * cause.
     */
    readonly failStep: FailStep;
  }
>()("hercule/controller/runs/StepSessionFailures") {}

export const StepSessionFailuresLayer: Layer.Layer<StepSessionFailures> = Layer.sync(
  StepSessionFailures,
)(() => {
  let registered: FailStep | undefined;
  return {
    register: (failStep) => {
      registered = failStep;
    },
    failStep: (step) =>
      Effect.suspend(() =>
        registered === undefined
          ? Effect.die(
              `Step ${step.record.stepId} of run ${step.runId} has to fail, but no run engine is registered to fail it`,
            )
          : registered(step),
      ),
  };
});

/** Explains why the step of a session the controller ended fails, or `undefined` for an exit a runner reported. */
const explainControllerEnding = (reason: string): string | undefined => {
  switch (reason) {
    case "runner_lost":
      return "The step's session ended because its runner was not heard from for longer than the session's absolute timeout.";
    case "runner_retired":
      return "The step's session ended because its runner was retired.";
    default:
      return undefined;
  }
};

/**
 * Builds the runs domain's observer. It is exported so boot can combine it
 * with the other domains' observers (see `combineSessionObservers`).
 */
export const makeRunSessionObserver: Effect.Effect<
  SessionObserver["Service"],
  never,
  StepSessionFailures | SqlClient.SqlClient
> = Effect.gen(function* () {
  const failures = yield* StepSessionFailures;
  const runs = yield* runRepository;
  const inputs = yield* inputRepository;

  /**
   * Fails the running record of the agent step that started `session`, when
   * no runner will report its turn: always when `controllerEnding` explains
   * an ending the controller decided, and otherwise only when the record's
   * prompt was cancelled before a runner took it, with `promptDropped` as
   * the step's error message. Does nothing for a session
   * no agent step started, or whose step has no record running in it.
   */
  const failStepOfSession = (
    session: StoredSession,
    controllerEnding: string | undefined,
    promptDropped: string,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      if (session.runId === null) return;
      const run = yield* runs.read(session.runId);
      if (Option.isNone(run) || !isUnfinished(run.value.status)) return;
      const record = run.value.steps.find(
        (candidate) =>
          candidate.stepId === session.stepId &&
          candidate.status === "running" &&
          candidate.sessionId === session.id,
      );
      if (record === undefined) return;
      let message = controllerEnding;
      if (message === undefined) {
        const prompt = yield* inputs.readStepInput(session.id, record.iteration);
        if (Option.isNone(prompt) || prompt.value.status !== "cancelled") return;
        message = promptDropped;
      }
      yield* failures.failStep({ runId: run.value.id, record, message });
    });

  return SessionObserver.of({
    sessionReported: () => Effect.void,
    sessionExited: ({ session, reason }) =>
      failStepOfSession(
        session,
        explainControllerEnding(reason),
        `The step's session exited (${reason}) before it took the step's prompt.`,
      ),
    inputsDropped: ({ session, refusal }) =>
      failStepOfSession(
        session,
        undefined,
        `The step's prompt could not be sent to its session: ${refusal}`,
      ),
  });
});
