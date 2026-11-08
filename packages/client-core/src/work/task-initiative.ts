/**
 * What the details pane says and does about the Initiative a Task is on: which
 * Initiative the pane names, what a pick in its menu means, and the words of
 * the change on the undo line.
 */
import type { WorkCard } from "@hercule/contract";
import { shortenTitle } from "./card-title";
import type { WorkInitiative } from "./lanes";

/** The id of the menu's row that takes the Task off its Initiative. */
export const NO_INITIATIVE_CHOICE_ID = "no-initiative";

/** The id of the menu's last row, which starts a new Initiative. */
export const NEW_INITIATIVE_CHOICE_ID = "new-initiative";

/** What a pick in the Initiative menu does. */
export type InitiativePick =
  /** Writes the Task's `initiativeId`: an Initiative's id, or `null` to take it off. */
  | { readonly kind: "set"; readonly initiativeId: string | null }
  /** Opens the sheet that makes a new Initiative. The Task is not changed. */
  | { readonly kind: "create" }
  /** The Task is on that Initiative already, so nothing is sent. */
  | { readonly kind: "keep" };

/**
 * Returns the open Initiative that `card` is on, or `undefined` when it is on
 * none or on one that is closed, which the board draws as no Initiative.
 */
export const findCardInitiative = (
  card: Pick<WorkCard, "initiativeId"> | undefined,
  initiatives: readonly WorkInitiative[],
): WorkInitiative | undefined =>
  card?.initiativeId === undefined
    ? undefined
    : initiatives.find((initiative) => initiative.id === card.initiativeId);

/**
 * Returns what picking the menu row `choiceId` does for `card`.
 *
 * - The "New initiative" row opens the sheet.
 * - A row for the Initiative the card is on already changes nothing.
 * - "No initiative" takes the card off its Initiative. It sends `null`
 *   whenever the card has an `initiativeId` at all, including one that names
 *   a closed Initiative the menu does not list, so the user can clear it.
 */
export const decideInitiativePick = (
  choiceId: string,
  card: Pick<WorkCard, "initiativeId">,
): InitiativePick => {
  if (choiceId === NEW_INITIATIVE_CHOICE_ID) return { kind: "create" };
  if (choiceId === NO_INITIATIVE_CHOICE_ID) {
    return card.initiativeId === undefined ? { kind: "keep" } : { kind: "set", initiativeId: null };
  }
  return choiceId === card.initiativeId
    ? { kind: "keep" }
    : { kind: "set", initiativeId: choiceId };
};

/**
 * Returns the words of the gesture, in the past tense, as the undo line shows
 * them and Undo reports them. `initiativeName` is the Initiative the Task was
 * put on, or `null` when it was taken off its Initiative.
 */
export const describeInitiativeGesture = (
  taskTitle: string,
  initiativeName: string | null,
): string =>
  initiativeName === null
    ? `Took ${shortenTitle(taskTitle)} off its initiative`
    : `Put ${shortenTitle(taskTitle)} on ${initiativeName}`;

/** Returns the sentence for a change the user asked for, which the undo line says when they act. */
export const describeInitiativeDone = (taskTitle: string, initiativeName: string | null): string =>
  `${describeInitiativeGesture(taskTitle, initiativeName)}.`;

/** Returns the sentence for a change the controller refused, with its `reason` and what to do. */
export const describeInitiativeFailure = (
  taskTitle: string,
  initiativeName: string | null,
  reason: string,
): string =>
  initiativeName === null
    ? `${shortenTitle(taskTitle)} was not taken off its initiative: ${reason}. Try again.`
    : `${shortenTitle(taskTitle)} was not put on ${initiativeName}: ${reason}. Try again.`;
