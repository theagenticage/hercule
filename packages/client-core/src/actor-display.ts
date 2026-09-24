/**
 * How an actor stamp is shown on screen.
 *
 * Every mutation is stamped with an actor: `user`, `system`, `session:<id>`
 * or `run:<id>`. A screen shows it in plain words ("you", "system", "session
 * 7c82ebeb", "run 1f3a9c2e"). For a session or a run stamp the reading also
 * holds what to link to, so the screen can open the thread or the run that
 * made the change. The rule lives here with a test rather than inside a component.
 */
import { toIdTail } from "./id-tail";

/** What an actor's label links to: nothing, a session's thread, or a run's page. */
export type ActorTarget =
  | { readonly kind: "none" }
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "run"; readonly runId: string };

export interface ActorReading {
  /** What to print. */
  readonly label: string;
  readonly link: ActorTarget;
}

/** Returns the label a screen shows for an actor stamp, and what the label links to. */
export const describeActor = (actor: string): ActorReading => {
  if (actor === "user") return { label: "you", link: { kind: "none" } };
  if (actor.startsWith("session:")) {
    const sessionId = actor.slice("session:".length);
    return { label: `session ${toIdTail(sessionId)}`, link: { kind: "session", sessionId } };
  }
  if (actor.startsWith("run:")) {
    const runId = actor.slice("run:".length);
    return { label: `run ${toIdTail(runId)}`, link: { kind: "run", runId } };
  }
  // `system`, and any actor kind added later, is shown as it is.
  return { label: actor, link: { kind: "none" } };
};
