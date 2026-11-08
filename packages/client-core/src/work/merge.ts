/**
 * The words and the board change for merging two cards. The app holds a merge
 * back for the undo line before it sends `task.merge` (`pending-intents.ts` in
 * the desktop renderer); these functions turn what it holds into what the board
 * draws and says.
 */
import type { TaskMergeCheck, WorkCard } from "@hercule/contract";
import { dropClosingFullStops, cutWithEllipsis } from "../text";
import { shortenTitle } from "./card-title";
import type { WorkInitiative } from "./lanes";

/** The most characters of a title that the label on the card to merge into shows before it is cut. */
const MOST_LABEL_TITLE_CHARACTERS = 22;

/**
 * What the user is told stays when two cards merge. The card that is merged
 * into keeps its own title, stage, Project and place, and its Initiative:
 * - Both cards are in the same Initiative, or the card merged away is in none:
 *   nothing changes, so the words only name the title, stage and place.
 * - Both are in different Initiatives: the card merged into keeps its own, and
 *   the words name it.
 * - Only the card merged away is in an Initiative: the card merged into takes
 *   it, even a closed one, and the words name it.
 *
 * An Initiative is named when `initiatives` lists it. The list holds the open
 * ones, so a closed Initiative is described without its name.
 */
export const describeMergeKeeps = (
  into: Pick<WorkCard, "initiativeId">,
  away: Pick<WorkCard, "initiativeId">,
  initiatives: readonly Pick<WorkInitiative, "id" | "name">[],
): string => {
  const findInitiativeName = (id: string): string | undefined =>
    initiatives.find((initiative) => initiative.id === id)?.name;
  if (away.initiativeId === undefined || away.initiativeId === into.initiativeId) {
    return "Keeps its title, stage and place";
  }
  if (into.initiativeId === undefined) {
    const name = findInitiativeName(away.initiativeId);
    return name === undefined
      ? "Keeps its title, stage and place, and takes the other card's initiative"
      : `Keeps its title, stage and place, and takes the initiative ${cutWithEllipsis(name, MOST_LABEL_TITLE_CHARACTERS)}`;
  }
  const name = findInitiativeName(into.initiativeId);
  return name === undefined
    ? "Keeps its title, stage, place and initiative"
    : `Keeps its title, stage, place and initiative ${cutWithEllipsis(name, MOST_LABEL_TITLE_CHARACTERS)}`;
};

/**
 * What the controller said when asked whether a merge would go ahead
 * (`task.checkMerge`), or that it could not be asked:
 * - `allowed`: the controller found nothing against the merge.
 * - `refused`: the controller would refuse it, for the reason in `refusal`.
 * - `unchecked`: the question failed (offline, an error). This never means
 *   safe: the merge itself decides.
 */
export type MergeCheckResult =
  | { readonly kind: "allowed" }
  | { readonly kind: "refused"; readonly refusal: string }
  | { readonly kind: "unchecked" };

/** A merge check that has not answered yet, or its result. */
export type MergeCheckState = { readonly kind: "checking" } | MergeCheckResult;

/** Returns the result of a merge check from the controller's answer. */
export const readMergeCheck = (answer: TaskMergeCheck): MergeCheckResult =>
  answer.refusal === undefined ? { kind: "allowed" } : { kind: "refused", refusal: answer.refusal };

/** What the undo line asks while the user picks the card to merge into by key. */
export const MERGE_PICK_WORDS = "Pick the card to merge this into. Return merges, Esc cancels.";

/** The most characters of a refusal that the label on the card to merge into shows before it is cut. */
const MOST_LABEL_REFUSAL_CHARACTERS = 56;

/**
 * Returns the label on the top edge of the card to merge into, by what the
 * merge check found:
 * - allowed or unchecked: `Merge into Serve smaller…` (a long title is cut).
 * - checking: `Checking merge into Serve smaller…`, which promises nothing.
 * - refused: `Cannot merge: ` and the controller's reason, cut to fit.
 */
export const describeMergeTarget = (title: string, check: MergeCheckState): string => {
  const cutTitle = cutWithEllipsis(title, MOST_LABEL_TITLE_CHARACTERS);
  switch (check.kind) {
    case "checking":
      return `Checking merge into ${cutTitle}`;
    case "refused":
      return cutWithEllipsis(
        `Cannot merge: ${dropClosingFullStops(check.refusal)}`,
        MOST_LABEL_REFUSAL_CHARACTERS,
      );
    case "allowed":
    case "unchecked":
      return `Merge into ${cutTitle}`;
  }
};

/**
 * Returns the label on the bottom edge of the card to merge into, or
 * `undefined` for none: what stays (`keeps`) when the merge is allowed, that
 * the check could not be made, or that nothing will be merged. A check that is
 * still running says nothing yet.
 */
export const describeMergeNote = (check: MergeCheckState, keeps: string): string | undefined => {
  switch (check.kind) {
    case "checking":
      return undefined;
    case "refused":
      return "Nothing will be merged";
    case "unchecked":
      return "Could not check this merge first";
    case "allowed":
      return keeps;
  }
};

/**
 * Returns what the undo line says when a merge is not sent because the check
 * showed the controller would refuse it. The card has not left the board.
 */
export const describeMergeRefused = (sourceTitle: string, refusal: string): string =>
  `"${shortenTitle(sourceTitle)}" was not merged: ${dropClosingFullStops(refusal)}.`;

/** Returns what the undo line says after a merge: `Merged into "Serve smaller checkout".` A long title is cut. */
export const describeMergedInto = (targetTitle: string): string =>
  `Merged into "${shortenTitle(targetTitle)}".`;

/**
 * Returns what the undo line says after a merge that went ahead without the
 * controller's answer to the merge check (it failed or did not come in time).
 * The merge itself is still decided by the controller, and its refusal comes
 * back on this line.
 */
export const describeMergedWithoutCheck = (targetTitle: string): string =>
  `Merged into "${shortenTitle(targetTitle)}". It could not be checked first.`;

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
