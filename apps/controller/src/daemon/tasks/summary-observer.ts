/**
 * The tasks domain's implementation of the sessions domain's `SessionObserver`
 * port. It marks a Task's summary out of date when a turn of one of its
 * sessions ends, so the summary writer describes the Task again once it is
 * quiet.
 *
 * The turn counts in any state (completed, failed or interrupted), and also
 * when a queued input starts the next turn at once. So it watches the report
 * of the turn's end itself, and not the moment a session becomes idle, which
 * a queued input prevents. The port passes only the events of a session's own
 * agent, so a subagent's turn never marks anything.
 *
 * A Thread's question opening or closing is not watched here: a session
 * parked on a question stays busy and ends no turn, and a subagent's question
 * is not passed to this port. The sessions domain marks those where it
 * replaces the open Requests.
 *
 * The tasks domain cannot implement this itself: the sessions domain imports
 * it, and the port lives in the sessions domain.
 */
import * as Effect from "effect/Effect";
import { SessionObserver } from "../../sessions";
import { TaskService } from "../../tasks";

/** Builds the tasks domain's observer. Boot combines it with the other domains' observers. */
export const makeTaskSessionObserver = Effect.gen(function* () {
  const tasks = yield* TaskService;
  return SessionObserver.of({
    sessionReported: (session, event) =>
      // A late report of a session that has already exited changes nothing,
      // as for the turn the board shows as ended.
      event._tag === "turn.completed" && session.taskId !== null && session.status !== "exited"
        ? tasks.markSummaryDirty(session.taskId)
        : Effect.void,
    sessionExited: () => Effect.void,
    inputsDropped: () => Effect.void,
  });
});
