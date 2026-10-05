/**
 * The runs domain's implementation of the sessions domain's `SessionObserver`
 * port. It fails an agent step whose prompt no runner saw, so the step's run
 * does not wait for a result that never comes. The step fails with
 * `session_failed`, and its run with `session-failed`.
 *
 * A runner reports the step's turn whenever it saw the step's prompt, even
 * when the session ends in the middle of the turn. So the observer fails the
 * step only when the sessions domain lists the step's iteration among the
 * prompts it cancelled before they left the controller. A prompt that was
 * sent but never answered is not in that list: the runner may have taken it,
 * so the step waits for the runner's report.
 *
 * A session the controller ends itself, because its runner was lost
 * (`runner_lost`) or retired (`runner_retired`), is not handled here: the
 * controller daemon fails those steps with `RunService.failStepsOfEndedSessions`
 * after ending the sessions, with a message that names the runner's fate.
 */
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { SessionObserver, type StoredSession } from "../sessions";

/** What the runs domain's observer needs from the run service. */
interface RunSessionObserverNeeds {
  /** `RunService.failStepWithDroppedPrompt`. */
  readonly failStepWithDroppedPrompt: (
    session: StoredSession,
    droppedIterations: ReadonlyArray<number>,
    message: string,
  ) => Effect.Effect<void, SqlError>;
}

/**
 * Checks whether the controller ended a session itself, because its runner
 * was lost or retired, rather than a runner reporting the exit.
 */
const isEndedByController = (reason: string): boolean =>
  reason === "runner_lost" || reason === "runner_retired";

/**
 * Builds the runs domain's observer. Boot combines it with the other
 * domains' observers (see `combineSessionObservers`).
 */
export const makeRunSessionObserver = ({
  failStepWithDroppedPrompt,
}: RunSessionObserverNeeds): SessionObserver["Service"] =>
  SessionObserver.of({
    sessionReported: () => Effect.void,
    sessionExited: ({ session, reason, droppedStepIterations }) =>
      isEndedByController(reason)
        ? Effect.void
        : failStepWithDroppedPrompt(
            session,
            droppedStepIterations,
            `The step's session exited (${reason}) before it took the step's prompt.`,
          ),
    inputsDropped: ({ session, refusal, droppedStepIterations }) =>
      failStepWithDroppedPrompt(
        session,
        droppedStepIterations,
        `The step's prompt could not be sent to its session: ${refusal}`,
      ),
  });
