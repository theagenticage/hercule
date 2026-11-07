/**
 * Which cards a signal landed on between two reads of one visit, and what the
 * page keeps back for the moment of the landing. The small new mark on a card
 * and the moment of the landing both start from the list of landed cards. In
 * that moment the cause shows first: a card keeps its old words until the
 * drop that stands for the signal has fallen onto it, so the page holds each
 * landed card as it was, and lets it go when the drop has landed.
 */
import type { EntityReason, Inbox, InboxCard } from "@hercule/contract";
import { decideAskingSentence, decideCardFace } from "./card-face";

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

/** A card the page keeps as it was while the drop of its signal falls, and the landing it waits for. */
export interface HeldCard {
  readonly card: InboxCard;
  /** The number of the landing that holds the card, so a later landing on the same card takes over its hold. */
  readonly landing: number;
}

/**
 * Returns `held` with the cards `landed` added, each as it was in `before`,
 * the read the page last drew, and each held by `landing`. A card that is
 * held already keeps the version it was held with, which is what the page
 * still draws, and passes to `landing`. Returns `held` itself when nothing
 * is added.
 */
export const holdLandedCards = (
  held: ReadonlyMap<string, HeldCard>,
  before: Inbox,
  landed: readonly string[],
  landing: number,
): ReadonlyMap<string, HeldCard> => {
  const cardsBefore = new Map(before.cards.map((card) => [card.id, card]));
  const next = new Map(held);
  for (const id of landed) {
    const card = held.get(id)?.card ?? cardsBefore.get(id);
    if (card !== undefined) next.set(id, { card, landing });
  }
  return next.size === held.size && landed.every((id) => held.get(id)?.landing === landing)
    ? held
    : next;
};

/**
 * Returns `inbox` with each held card in place of its newer version. Returns
 * `inbox` itself when nothing is held, and keeps the order and everything
 * else the read says.
 */
export const showHeldCards = (inbox: Inbox, held: ReadonlyMap<string, HeldCard>): Inbox =>
  held.size === 0
    ? inbox
    : { ...inbox, cards: inbox.cards.map((card) => held.get(card.id)?.card ?? card) };

/**
 * Returns `held` without the cards that `landing` holds. A card that a later
 * landing took over stays held. Returns `held` itself when `landing` holds
 * none.
 */
export const releaseHeldCards = (
  held: ReadonlyMap<string, HeldCard>,
  landing: number,
): ReadonlyMap<string, HeldCard> => {
  const kept = [...held].filter(([, each]) => each.landing !== landing);
  return kept.length === held.size ? held : new Map(kept);
};

/** What a landed signal says: its tone, which colors the drop and the rim, and the words for a screen reader. */
export interface LandedWords {
  readonly tone: EntityReason["tone"];
  /** The card's noun and identifier, then its new sentence: "Pull request #6238: Omar commented". */
  readonly announcement: string;
}

/**
 * Returns what the signal that landed on `card` says. The sentence is the one
 * the card draws now: a card that rides on another (`ridesOn`) draws as a
 * part, which words it by what it asks. A card with no sentence is announced
 * by its name alone, with the tone `plain`.
 */
export const describeLanding = (card: InboxCard): LandedWords => {
  const face = decideCardFace(card);
  const sentence = card.ridesOn === undefined ? face.sentence : decideAskingSentence(card);
  const name = [face.noun, face.identifier].filter((part) => part !== "").join(" ");
  return {
    tone: sentence?.tone ?? "plain",
    announcement: sentence === undefined ? name : `${name}: ${sentence.text}`,
  };
};
