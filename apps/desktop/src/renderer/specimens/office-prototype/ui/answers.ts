/**
 * PROTOTYPE - the answers the user gave in the office, by colleague id, and
 * the colleagues as the scene's sim holds them now.
 *
 * The sim decides what an answer changes: the colleague works again, in the
 * counts, on the dossier card and in Tab's cycle. The panels remember only
 * what the user answered, for the dossier card's activity.
 */
import { sendOfficeCommand } from "../office-store";
import type { ColleagueState } from "../engine/contracts";
import type { Colleague } from "../world/types";

let answers: ReadonlyMap<string, string> = new Map();
const listeners = new Set<() => void>();

/** Returns the answers given so far, by colleague id. The same map until an answer is added. */
export function readAnswers(): ReadonlyMap<string, string> {
  return answers;
}

/** Calls `listener` after every answer. Returns the function that unsubscribes. */
export function subscribeAnswers(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Answers the request `colleague` waits on with `answer`: tells the scene,
 * and remembers the answer. The scene's sim then sets the colleague working
 * again, and the page writes that into the sidebar's sessions.
 */
export function sendAnswer(colleague: Colleague, answer: string): void {
  sendOfficeCommand({ kind: "answer", colleagueId: colleague.id, answer });
  answers = new Map(answers).set(colleague.id, answer);
  for (const listener of listeners) listener();
}

/** Returns `colleague` with the pose, request and state label the sim holds for it now, in `states`. */
export function applyColleagueState(
  colleague: Colleague,
  states: ReadonlyMap<string, ColleagueState>,
): Colleague {
  const live = states.get(colleague.id);
  return live === undefined ? colleague : { ...colleague, ...live };
}
