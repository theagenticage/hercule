/**
 * How an actor stamp is shown on screen.
 *
 * Every mutation is stamped with an actor: `user`, `system`, `session:<id>`
 * or `run:<id>`. A screen shows it in plain words ("you", "system", "session
 * 7c82ebeb", "run 1f3a9c2e"). For a session or a run stamp the reading also
 * holds what to link to, so the screen can open the thread or the run that
 * made the change. The rule lives here with a test rather than inside a component.
 */
import { toIdTail } from "@hercule/contract";

/**
 * What the label of whoever made a change links to: nothing, a session's
 * thread, a run's page, or an assistant's page. An actor stamp never names an
 * assistant; the `assistant` target is for the agent that sent a message,
 * when it answers an assistant's conversation (see `describeSender`).
 */
export type ActorTarget =
  | { readonly kind: "none" }
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "assistant"; readonly assistantId: string };

export interface ActorReading {
  /** What to print. */
  readonly label: string;
  readonly link: ActorTarget;
}

/** Which kind of actor a stamp names: the user, a session, a run, or any other (`system`, `plugin:<id>`). */
export type ActorKind = "user" | "session" | "run" | "other";

/** An actor stamp's reading, with the kind of actor it names and its name as it reads on its own. */
export interface ActorDescription extends ActorReading {
  readonly kind: ActorKind;
  /**
   * The actor's name as it reads on its own, as in a table cell: "You",
   * "run 1f3a9c2e". It differs from `label`, which reads inside a sentence,
   * only for the user.
   */
  readonly name: string;
}

/**
 * Returns the id of the session an actor stamp names, or `undefined` when the
 * actor is not a session. A Discussion's Post links to its author's thread
 * through this id.
 */
export const readActorSessionId = (actor: string): string | undefined =>
  actor.startsWith("session:") ? actor.slice("session:".length) : undefined;

/**
 * Returns what a screen shows for an actor stamp: the kind of actor, its
 * label and name, and what the label links to.
 */
export const describeActor = (actor: string): ActorDescription => {
  if (actor === "user") return { kind: "user", label: "you", name: "You", link: { kind: "none" } };
  const sessionId = readActorSessionId(actor);
  if (sessionId !== undefined) {
    const label = `session ${toIdTail(sessionId)}`;
    return { kind: "session", label, name: label, link: { kind: "session", sessionId } };
  }
  if (actor.startsWith("run:")) {
    const runId = actor.slice("run:".length);
    const label = `run ${toIdTail(runId)}`;
    return { kind: "run", label, name: label, link: { kind: "run", runId } };
  }
  // `system`, and any actor kind added later, is shown as it is.
  return { kind: "other", label: actor, name: actor, link: { kind: "none" } };
};
