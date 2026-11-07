/**
 * Find on the Work board: the box that narrows the cards by title as the user
 * types, and the list of the best matches under it.
 */
import type { WorkCard } from "@hercule/contract";

/** The most matches the list under the Find box shows. */
const MOST_TOP_MATCHES = 8;

/** What a Find text leaves. */
export interface FoundCards {
  /** Every card whose title holds the text, in the order given. All cards when the text is empty. */
  readonly matches: readonly WorkCard[];
  /**
   * The list under the box: the first matches, those not in Landed before
   * those in Landed, since a card still in play is more likely what the user
   * means. Empty when the text is empty.
   */
  readonly topMatches: readonly WorkCard[];
}

/**
 * Returns the cards whose title holds `text`, ignoring case and the spaces at
 * either end of `text`, and the top matches among them.
 */
export const findCardsByTitle = (cards: readonly WorkCard[], text: string): FoundCards => {
  const needle = text.trim().toLowerCase();
  if (needle === "") return { matches: cards, topMatches: [] };
  const matches = cards.filter((card) => card.title.toLowerCase().includes(needle));
  const topMatches = [
    ...matches.filter((card) => card.stage !== "landed"),
    ...matches.filter((card) => card.stage === "landed"),
  ].slice(0, MOST_TOP_MATCHES);
  return { matches, topMatches };
};
