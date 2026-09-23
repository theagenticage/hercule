/**
 * How an actor stamp is shown on screen.
 *
 * Every mutation is stamped with an actor: `user`, `system` or `session:<id>`.
 * A screen shows it in plain words ("you", "system", "session 7c82ebeb"). For a
 * session stamp it also returns the session id, so the screen can link to the
 * thread that made the change. The rule lives here with a test rather than
 * inside a component.
 */
import { toIdTail } from "./id-tail";

export interface ActorReading {
  /** What to print. */
  readonly label: string;
  /** The session that made the change, if a session did. A screen links to it. */
  readonly sessionId: string | undefined;
}

/** Returns the label a screen shows for an actor stamp, and the session id for a session stamp. */
export const describeActor = (actor: string): ActorReading => {
  if (actor === "user") return { label: "you", sessionId: undefined };
  if (actor.startsWith("session:")) {
    const sessionId = actor.slice("session:".length);
    return { label: `session ${toIdTail(sessionId)}`, sessionId };
  }
  // `system`, and any actor kind added later, is shown as it is.
  return { label: actor, sessionId: undefined };
};
