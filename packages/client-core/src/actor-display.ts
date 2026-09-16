/**
 * How an actor stamp reads on screen.
 *
 * Every mutation carries one: `user`, `system` or `session:<id>`. A screen shows
 * the person and the thing in plain words - "you", "system", "session 7c82ebeb"
 * - and a session stamp also hands back its id, so the screen can link to the
 * thread that made the record. Reading the stamp is a reading of the domain, so
 * it lives here with a test rather than inside a component.
 */
import { idTail } from "./id-tail";

export interface ActorReading {
  /** What to print. */
  readonly label: string;
  /** The session that acted, when one did: what a screen links to. */
  readonly sessionId: string | undefined;
}

/** What one actor stamp says on screen. */
export const actorReading = (actor: string): ActorReading => {
  if (actor === "user") return { label: "you", sessionId: undefined };
  if (actor.startsWith("session:")) {
    const sessionId = actor.slice("session:".length);
    return { label: `session ${idTail(sessionId)}`, sessionId };
  }
  // `system` - and anything a later widening of the stamps adds - reads as it
  // arrived.
  return { label: actor, sessionId: undefined };
};
