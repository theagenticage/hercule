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
  | {
      readonly kind: "set";
      /** The Initiative's id to write, or `null` to take the Task off its Initiative. */
      readonly initiativeId: string | null;
      /**
       * Whether Undo can put the Task back on the Initiative it is on now. It
       * cannot when that one is closed, because the controller refuses to put
       * a Task on a closed Initiative. The change is then made without an Undo.
       */
      readonly canPutBack: boolean;
    }
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
 * - A change away from a closed Initiative cannot be undone (`canPutBack`).
 *
 * `openInitiatives` are the Initiatives the menu lists. An `initiativeId` that
 * is not among them is a closed one.
 */
export const decideInitiativePick = (
  choiceId: string,
  card: Pick<WorkCard, "initiativeId">,
  openInitiatives: readonly WorkInitiative[],
): InitiativePick => {
  if (choiceId === NEW_INITIATIVE_CHOICE_ID) return { kind: "create" };
  const canPutBack =
    card.initiativeId === undefined || findCardInitiative(card, openInitiatives) !== undefined;
  if (choiceId === NO_INITIATIVE_CHOICE_ID) {
    return card.initiativeId === undefined
      ? { kind: "keep" }
      : { kind: "set", initiativeId: null, canPutBack };
  }
  return choiceId === card.initiativeId
    ? { kind: "keep" }
    : { kind: "set", initiativeId: choiceId, canPutBack };
};

/**
 * Returns the words of the gesture, in the past tense, as the undo line shows
 * them and Undo reports them. `initiativeName` is the Initiative the Task was
 * put on, or `null` when it was taken off its Initiative. `wasClosed` says
 * the Initiative it was taken off is closed, which the words then name,
 * because the closed Initiative's name is not known to the pane.
 */
export const describeInitiativeGesture = (
  taskTitle: string,
  initiativeName: string | null,
  wasClosed: boolean,
): string =>
  initiativeName === null
    ? `Took ${shortenTitle(taskTitle)} off its ${wasClosed ? "closed " : ""}initiative`
    : `Put ${shortenTitle(taskTitle)} on ${initiativeName}`;
