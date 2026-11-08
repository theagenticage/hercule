/**
 * The words and the board change for merging two cards. The app holds a merge
 * back for the undo line before it sends `task.merge` (`pending-intents.ts` in
 * the desktop renderer); these functions turn what it holds into what the board
 * draws and says.
 */
import type { WorkCard } from "@hercule/contract";
import { dropClosingFullStops, cutWithEllipsis } from "../text";
import { shortenTitle } from "./card-title";

/** The most characters of a title that the label on the card to merge into shows before it is cut. */
const MOST_LABEL_TITLE_CHARACTERS = 22;

/**
 * What stays when two cards merge. It is said before the merge, on the card
 * that is picked, because the user cannot see it afterwards: the card that is
 * merged into keeps its own title, stage, Project and place.
 */
export const MERGE_KEEPS_WORDS = "Keeps its title, stage and place";

/** What the undo line asks while the user picks the card to merge into by key. */
export const MERGE_PICK_WORDS = "Pick the card to merge this into. Return merges, Esc cancels.";

/** Returns the label on the top edge of the card to merge into: `Merge into Serve smaller…`. A long title is cut. */
export const describeMergeTarget = (title: string): string =>
  `Merge into ${cutWithEllipsis(title, MOST_LABEL_TITLE_CHARACTERS)}`;

/** Returns what the undo line says after a merge: `Merged into "Serve smaller checkout".` A long title is cut. */
export const describeMergedInto = (targetTitle: string): string =>
  `Merged into "${shortenTitle(targetTitle)}".`;

/** Returns the words of a merge for the undo stack, in the past tense, like the words of a move: `Merged "A" into "B"`. */
export const describeMerge = (sourceTitle: string, targetTitle: string): string =>
  `Merged "${shortenTitle(sourceTitle)}" into "${shortenTitle(targetTitle)}"`;

/**
 * Returns what the undo line says when a merge did not go through. `message`
 * is the reason as the controller gave it (or that the app closed first). The
 * card is back on the board by then, so the line says so.
 */
export const describeMergeFailure = (sourceTitle: string, message: string): string =>
  `The merge did not happen, so "${shortenTitle(sourceTitle)}" is back on the board: ${dropClosingFullStops(message)}.`;

/** The Task of a merge the app holds, which merges into another Task. */
export interface HeldMerge {
  /** The Task that merges away. */
  readonly taskId: string;
}

/**
 * Returns `cards` without the card of each Task in `held`, so the board draws
 * the merge as done while the undo line is open. This is display only: a
 * merge counts as done when the controller accepts it, and a merge that fails
 * is no longer in `held`, so its card comes back.
 *
 * Returns the same array when no card is hidden, and the same objects for the
 * cards that stay, so a card that did not change does not draw again.
 */
export const hideHeldMergeSources = (
  cards: readonly WorkCard[],
  held: readonly HeldMerge[],
): readonly WorkCard[] => {
  if (held.length === 0) return cards;
  const hiddenIds = new Set(held.map((merge) => merge.taskId));
  return cards.some((card) => hiddenIds.has(card.id))
    ? cards.filter((card) => !hiddenIds.has(card.id))
    : cards;
};
