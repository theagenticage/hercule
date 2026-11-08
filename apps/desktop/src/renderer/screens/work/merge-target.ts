import {
  describeMergeNote,
  describeMergeTarget,
  type MergeCheckState,
} from "@hercule/client-core/work";
import { trackBody } from "../../app/motion";

/** How much bigger the card that is merged into is while it is picked. */
const MERGE_TARGET_SCALE = 1.02;

/** What the labels on the card to merge into say. */
export interface MergeTargetWords {
  /** The title of the card merged into. */
  readonly title: string;
  /** What stays after the merge (`describeMergeKeeps`), shown once the check allows it. */
  readonly keeps: string;
  /** What the merge check found so far. */
  readonly check: MergeCheckState;
}

/**
 * Writes the labels of a merge target onto `card` as data attributes: the
 * check's state, the label on the top edge, and the note on the bottom edge
 * (absent while the check runs). Safe to call again when the check answers.
 */
export const showMergeTargetWords = (card: HTMLElement, words: MergeTargetWords): void => {
  card.dataset["mergeCheck"] = words.check.kind;
  card.dataset["mergeLabel"] = describeMergeTarget(words.title, words.check);
  const note = describeMergeNote(words.check, words.keeps);
  if (note === undefined) delete card.dataset["mergeKeeps"];
  else card.dataset["mergeKeeps"] = note;
};

/**
 * Marks `card`, the element of a card on the board, as the one a merge goes
 * into: it swells on `hand`, takes a ring, and shows a label on its top edge
 * ("Merge into Serve smaller…", or the refusal) and one on its bottom edge
 * (what stays, "Keeps its title, stage and place"). The marks are data
 * attributes and a scale outside React, which never rewrites them.
 */
export const markMergeTarget = (card: HTMLElement, words: MergeTargetWords): void => {
  card.dataset["mergeTarget"] = "";
  showMergeTargetWords(card, words);
  trackBody(card).to({ s: MERGE_TARGET_SCALE }, "hand");
};

/** Takes the marks of `markMergeTarget` off `card`, and lets it settle back to its size on `hand`. */
export const unmarkMergeTarget = (card: HTMLElement): void => {
  delete card.dataset["mergeTarget"];
  delete card.dataset["mergeCheck"];
  delete card.dataset["mergeLabel"];
  delete card.dataset["mergeKeeps"];
  const body = trackBody(card);
  body.to({ s: 1 }, "hand", {
    done: () => {
      body.clear();
    },
  });
};
