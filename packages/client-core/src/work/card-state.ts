/**
 * What a card has to say beyond its stage, and the words for a card that
 * waits on another Task. The card's look (quiet when blocked), the bead an
 * Initiative's line draws for it and its screen reader name all read the same
 * state, so they cannot disagree about it.
 */
import type { WorkCard } from "@hercule/contract";
import { shortenTitle } from "./card-title";

/**
 * What a card has to say beyond its stage, most important first:
 *
 * - `failed`: a run on it failed, whatever else is true of it;
 * - `question`: a Thread of it has an open question;
 * - `landed`: it is finished;
 * - `blocked`: another Task that has not landed holds it back;
 * - `open`: none of these.
 */
export type CardState = "failed" | "question" | "landed" | "blocked" | "open";

/**
 * Returns the state of `card`. A failure outranks everything: a failed card
 * shows as a failed card even in Landed and even while blocked, because the
 * run needs the user either way. A card at Landed is never blocked, whatever it
 * waits on.
 */
export const decideCardState = (card: WorkCard): CardState => {
  if (card.failure !== undefined) return "failed";
  if (card.openQuestion !== undefined) return "question";
  if (card.stage === "landed") return "landed";
  return card.blockedByCount > 0 ? "blocked" : "open";
};

/** What a blocked card says about what it waits on. */
export interface CardBlockers {
  /** For example "Waits on Add a refund button", or "Waits on Add a refund button and 2 more". */
  readonly words: string;
  /** The Task a line from the card runs to when the user points at it. */
  readonly firstBlockerId: string;
}

/**
 * Returns what a blocked card waits on, or `null` when the card is not in the
 * `blocked` state (see `decideCardState`). The words name the first blocker,
 * with its title cut, and count the others.
 *
 * A card lists at most `MAX_CARD_BLOCKERS` blockers, so the count of the
 * others comes from `blockedByCount`, not from the list.
 */
export const describeCardBlockers = (card: WorkCard): CardBlockers | null => {
  const [first] = card.blockedBy;
  if (first === undefined || decideCardState(card) !== "blocked") return null;
  const others = card.blockedByCount - 1;
  return {
    words: `Waits on ${shortenTitle(first.title)}${others > 0 ? ` and ${String(others)} more` : ""}`,
    firstBlockerId: first.id,
  };
};
