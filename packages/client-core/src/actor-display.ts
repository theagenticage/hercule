/**
 * How an actor stamp is shown on screen.
 *
 * Every mutation is stamped with an actor: `user`, `system`, `session:<id>`
 * or `run:<id>`. A screen shows it in plain words ("you", "system", "session
 * 7c82ebeb", "run 1f3a9c2e"). For a session or a run stamp it also returns
 * the id, so the screen can link to the thread or the run that made the
 * change. The rule lives here with a test rather than inside a component.
 */
import { toIdTail } from "./id-tail";

export interface ActorReading {
  /** What to print. */
  readonly label: string;
  /** The session that made the change, if a session did. A screen links to it. */
  readonly sessionId: string | undefined;
  /** The run that made the change, if a run's step did. A screen links to it. */
  readonly runId: string | undefined;
}

/**
 * Returns the label a screen shows for an actor stamp, and the session id or
 * the run id for a session or a run stamp.
 */
export const describeActor = (actor: string): ActorReading => {
  if (actor === "user") return { label: "you", sessionId: undefined, runId: undefined };
  if (actor.startsWith("session:")) {
    const sessionId = actor.slice("session:".length);
    return { label: `session ${toIdTail(sessionId)}`, sessionId, runId: undefined };
  }
  if (actor.startsWith("run:")) {
    const runId = actor.slice("run:".length);
    return { label: `run ${toIdTail(runId)}`, sessionId: undefined, runId };
  }
  // `system`, and any actor kind added later, is shown as it is.
  return { label: actor, sessionId: undefined, runId: undefined };
};
