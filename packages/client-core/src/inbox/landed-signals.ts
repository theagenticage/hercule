/**
 * Which cards a signal landed on between two reads of one visit. Both the
 * small new mark on a card and the moment of the landing start from this list.
 */
import type { Inbox } from "@hercule/contract";

/**
 * Returns the ids of the cards whose latest signal is a different one in
 * `after` than in `before`, in the order of `after`. Only a card that both reads
 * hold counts: a card that is new to the page arrived, which is not a landing,
 * and a card that left has nothing to land on. A card whose latest signal ended
 * (it has none now) counts for nothing: nothing new happened.
 */
export const listLandedCards = (before: Inbox, after: Inbox): readonly string[] => {
  const latestBefore = new Map(before.cards.map((card) => [card.id, card.signals.latest?.id]));
  return after.cards
    .filter((card) => {
      if (!latestBefore.has(card.id)) return false;
      const latest = card.signals.latest?.id;
      return latest !== undefined && latest !== latestBefore.get(card.id);
    })
    .map((card) => card.id);
};
