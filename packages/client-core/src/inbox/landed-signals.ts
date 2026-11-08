/**
 * Which cards a signal landed on between two reads of one visit, and what the
 * visit keeps back for the moment of the landing. The small new mark on a card
 * and the moment of the landing both start from the list of landed cards. In
 * that moment the cause shows first: a card keeps its old words until the
 * drop that stands for the signal has fallen onto it, so the visit holds each
 * landed card as it was, and lets it go when the screen reports that the drop
 * has landed. The screen only measures and plays; what it shows and what is
 * fresh are decided here.
 */
import type { EntityReason, EntitySignalLine, Inbox, InboxCard } from "@hercule/contract";
import { decideAskingSentence, decideCardFace } from "./card-face";

/**
 * Checks whether the signal `a` comes after the signal `b`: it was raised
 * later, and when both were raised in the same moment, its id sorts after.
 * This is the order the controller picks a card's latest signal in.
 */
const isSignalAfter = (a: EntitySignalLine, b: EntitySignalLine): boolean => {
  const byTime = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  return byTime === 0 ? a.id > b.id : byTime > 0;
};

/**
 * Returns the ids of the cards whose latest signal moved forward from `before`
 * to `after`, in the order of `after`: it is a later signal than the one the
 * card had, or the card had none. A latest signal that moved backward is no
 * landing. That happens when the user answers the newest signal and an older
 * open one becomes the latest. Only a card that both reads hold counts: a card
 * that is new to the page arrived, which is not a landing, and a card that
 * left has nothing to land on. A card whose latest signal ended (it has none
 * now) counts for nothing: nothing new happened.
 */
export const listLandedCards = (before: Inbox, after: Inbox): readonly string[] => {
  const latestBefore = new Map(before.cards.map((card) => [card.id, card.signals.latest]));
  return after.cards
    .filter((card) => {
      if (!latestBefore.has(card.id)) return false;
      const latest = card.signals.latest;
      if (latest === undefined) return false;
      const earlier = latestBefore.get(card.id);
      return earlier === undefined || isSignalAfter(latest, earlier);
    })
    .map((card) => card.id);
};

/** A card the page keeps as it was while the drop of its signal falls, and the landing it waits for. */
export interface LandingHold {
  readonly card: InboxCard;
  /** The number of the landing that holds the card, so a later landing on the same card takes over its hold. */
  readonly landing: number;
}

/**
 * One landing of signals, as the screen is asked to play it: the cards the
 * signals landed on, in the order of the read, and what the screen needs to
 * play each. The screen plays a landing once, and reports back when the drop
 * has landed (`releaseLandedCards`).
 */
export interface SignalLanding {
  /** The number of the landing, counted from 1 over the visit. */
  readonly number: number;
  /**
   * Whether the reader asked for no movement, read once for the whole landing.
   * Then nothing is held: the new words are drawn at once and only a rim fades.
   */
  readonly isReduced: boolean;
  readonly cards: readonly { readonly id: string; readonly tone: EntityReason["tone"] }[];
}

/** What a visit keeps about the signals that landed on its cards. Start from `NO_LANDINGS`. */
export interface SignalLandings {
  /**
   * The last of the visit's own reads, to see which cards a signal landed on
   * since. A copy kept from an earlier visit says nothing about this one, so
   * it is never recorded here.
   */
  readonly lastRead: Inbox | undefined;
  /** How many landings there were, which is the number of the last. */
  readonly count: number;
  /** The cards that keep their old words until their drop has landed. */
  readonly holds: ReadonlyMap<string, LandingHold>;
  /** The cards a signal landed on, which stay fresh until reached, held or not. */
  readonly freshIds: ReadonlySet<string>;
  /** What a screen reader says for the signals that landed last. Empty before any landed. */
  readonly announcement: string;
  /** The last landing, or `undefined` before any. */
  readonly landing: SignalLanding | undefined;
}

/** A visit in which no signal has landed yet. */
export const NO_LANDINGS: SignalLandings = {
  lastRead: undefined,
  count: 0,
  holds: new Map(),
  freshIds: new Set(),
  announcement: "",
  landing: undefined,
};

/** Returns what a screen reader says for the cards `ids` of `inbox`, one sentence for each card the read holds. */
const announceCards = (inbox: Inbox, ids: readonly string[]): string => {
  const wanted = new Set(ids);
  return inbox.cards
    .filter((card) => wanted.has(card.id))
    .map((card) => describeLanding(card).announcement)
    .join(". ");
};

/**
 * Returns `held` with the cards `landed` added, each as it was in `before`,
 * the read the page last drew, and each held by `landing`. A card that is
 * held already keeps the version it was held with, which is what the page
 * still draws, and passes to `landing`. Returns `held` itself when nothing
 * is added.
 */
const holdLandedCards = (
  held: ReadonlyMap<string, LandingHold>,
  before: Inbox,
  landed: readonly string[],
  landing: number,
): ReadonlyMap<string, LandingHold> => {
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
export const showHeldCards = (inbox: Inbox, held: ReadonlyMap<string, LandingHold>): Inbox =>
  held.size === 0
    ? inbox
    : { ...inbox, cards: inbox.cards.map((card) => held.get(card.id)?.card ?? card) };

/**
 * Returns the landings after the visit reads `received`, which must be one of
 * its own reads. A signal lands on a card when this read follows another read
 * of this visit and brings the card a newer latest signal (`listLandedCards`).
 * The first read of the visit lands nothing. Returns `landings` itself when
 * `received` is the read it already holds.
 *
 * A landing makes the landed cards fresh and is the one to play (`landing`).
 * Unless the reader asked for no movement (`isMotionReduced`, asked once and
 * only when a signal landed), each landed card is held as it was and the
 * screen reader hears nothing yet. Under Reduce motion nothing is held and the
 * screen reader hears the new words at once.
 */
export const recordLandedSignals = (
  landings: SignalLandings,
  received: Inbox,
  isMotionReduced: () => boolean,
): SignalLandings => {
  const { lastRead } = landings;
  if (received === lastRead) return landings;
  const afterRead = { ...landings, lastRead: received };
  if (lastRead === undefined) return afterRead;
  const landed = listLandedCards(lastRead, received);
  if (landed.length === 0) return afterRead;
  const isReduced = isMotionReduced();
  const number = landings.count + 1;
  const isLanded = new Set(landed);
  const landing: SignalLanding = {
    number,
    isReduced,
    cards: received.cards
      .filter((card) => isLanded.has(card.id))
      .map((card) => ({ id: card.id, tone: describeLanding(card).tone })),
  };
  const freshIds = new Set([...landings.freshIds, ...landed]);
  return isReduced
    ? {
        ...afterRead,
        count: number,
        freshIds,
        landing,
        announcement: announceCards(received, landed),
      }
    : {
        ...afterRead,
        count: number,
        freshIds,
        landing,
        holds: holdLandedCards(landings.holds, lastRead, landed, number),
      };
};

/**
 * Returns the landings after the drop of landing `number` has landed, and the
 * ids of the cards that now draw their new words. A card that a later landing
 * took over stays held and is not among them. The screen reader hears the new
 * words of the cards released. Returns `landings` itself, with no ids, when the
 * landing holds no card.
 */
export const releaseLandedCards = (
  landings: SignalLandings,
  number: number,
): { readonly landings: SignalLandings; readonly released: readonly string[] } => {
  const { holds, lastRead } = landings;
  const released = [...holds].filter(([, hold]) => hold.landing === number).map(([id]) => id);
  if (released.length === 0) return { landings, released };
  return {
    landings: {
      ...landings,
      holds: new Map([...holds].filter(([, hold]) => hold.landing !== number)),
      announcement:
        lastRead === undefined ? landings.announcement : announceCards(lastRead, released),
    },
    released,
  };
};

/** Returns the landings after the user reached the card `id`, which is then no longer fresh. Returns `landings` itself when it was not. */
export const reachLandedCard = (landings: SignalLandings, id: string): SignalLandings =>
  landings.freshIds.has(id)
    ? { ...landings, freshIds: new Set([...landings.freshIds].filter((each) => each !== id)) }
    : landings;

/** Returns the cards that are fresh and drawn with their new words: a card still held for its drop is not fresh yet. */
export const listShownFreshIds = (landings: SignalLandings): ReadonlySet<string> =>
  landings.holds.size === 0
    ? landings.freshIds
    : new Set([...landings.freshIds].filter((id) => !landings.holds.has(id)));

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
