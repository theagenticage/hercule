/** What the moves on an Inbox card say: the words of each move, and why one is refused. */
import type { InboxCard } from "@hercule/contract";
import { endSentence, lowerFirst } from "../text";
import { NO_OFFERS, type CardOffers } from "./card-hand-off";

/** The moves a card offers on the Inbox. */
export type InboxMove = "take" | "dismiss" | "see-task" | "hand";

/**
 * Returns why `move` does not apply to `card`, as a sentence for the undo
 * line, or `undefined` when it does.
 *
 * - Take and dismiss refuse a card that has a live Task: Take would only find
 *   that Task, and dismissing the card would hide work in progress.
 * - Seeing the Task refuses a card that has none.
 * - Handing off refuses a card that no workflow can take now, and never
 *   because of a Task: a hand-off continues the card's Task. `offers` are the
 *   card's (`listCardOffers`); without them nothing can take the card. The
 *   line gives the controller's reason for the first workflow that cannot, or
 *   says how to get a workflow that can.
 */
export const describeMoveRefusal = (
  card: Pick<InboxCard, "kind" | "noun" | "taskId">,
  move: InboxMove,
  offers: CardOffers = NO_OFFERS,
): string | undefined => {
  if (move === "hand") {
    if (offers.available.length > 0) return undefined;
    const [firstUnavailable] = offers.unavailable;
    return firstUnavailable?.unavailable === undefined
      ? `No workflow takes a ${lowerFirst(card.noun)}. Give a workflow an entity input for ${card.kind} to hand these off.`
      : `No workflow can take it now. ${endSentence(firstUnavailable.unavailable.message)}`;
  }
  if (move === "see-task") {
    return card.taskId === undefined
      ? "It has no Task yet. Press T to take it on, and G to see the Task."
      : undefined;
  }
  return card.taskId === undefined ? undefined : "It already has a Task. Press G to see it.";
};

/** Returns what to call `card` in a sentence about a move: its noun and identifier, such as "Pull request #87". */
export const nameCard = (card: Pick<InboxCard, "noun" | "identifier">): string =>
  `${card.noun} ${card.identifier}`;

/**
 * Returns what the undo line says when a hand-off is refused: "Pull request
 * #87 was not handed to Review PR. Review PR is already working on this." The
 * `reason` is the controller's own sentence, which already says whether to try
 * again.
 */
export const describeHandOffRefusal = (
  card: Pick<InboxCard, "noun" | "identifier">,
  workflowName: string,
  reason: string,
): string => `${nameCard(card)} was not handed to ${workflowName}. ${endSentence(reason)}`;
