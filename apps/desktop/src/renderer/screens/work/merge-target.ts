import { describeMergeTarget, MERGE_KEEPS_WORDS } from "@hercule/client-core/work";
import { trackBody } from "../../app/motion";

/** How much bigger the card that is merged into is while it is picked. */
const MERGE_TARGET_SCALE = 1.02;

/**
 * Marks `card`, the element of a card on the board, as the one a merge goes
 * into: it swells on `hand`, takes a ring, and shows a label on its top edge
 * with its title ("Merge into Serve smaller…") and one on its bottom edge with
 * what stays ("Keeps its title, stage and place"). The marks are data
 * attributes and a scale outside React, which never rewrites them.
 */
export const markMergeTarget = (card: HTMLElement, title: string): void => {
  card.dataset["mergeTarget"] = "";
  card.dataset["mergeLabel"] = describeMergeTarget(title);
  card.dataset["mergeKeeps"] = MERGE_KEEPS_WORDS;
  trackBody(card).to({ s: MERGE_TARGET_SCALE }, "hand");
};

/** Takes the marks of `markMergeTarget` off `card`, and lets it settle back to its size on `hand`. */
export const unmarkMergeTarget = (card: HTMLElement): void => {
  delete card.dataset["mergeTarget"];
  delete card.dataset["mergeLabel"];
  delete card.dataset["mergeKeeps"];
  const body = trackBody(card);
  body.to({ s: 1 }, "hand", {
    done: () => {
      body.clear();
    },
  });
};
