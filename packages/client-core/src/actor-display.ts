/**
 * How an actor stamp reads on screen.
 *
 * Every mutation carries one: `user`, `system`, `session:<id>`, `run:<id>` or
 * `plugin:<id>`. A screen shows the person and the thing in plain words - "you",
 * "system", "session 7c82ebeb" - and a session stamp also hands back its id, so
 * the screen can link to the thread that made the record. Reading the stamp is
 * a reading of the domain, so it lives here with a test rather than inside a
 * component.
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
  if (actor.startsWith("run:")) {
    return { label: `run ${idTail(actor.slice("run:".length))}`, sessionId: undefined };
  }
  // A plugin id is a slug its author chose, not an id nobody reads, so it is
  // shown whole. `system` - and anything a later widening adds - reads as it
  // arrived.
  if (actor.startsWith("plugin:")) {
    return { label: `plugin ${actor.slice("plugin:".length)}`, sessionId: undefined };
  }
  return { label: actor, sessionId: undefined };
};
