import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import {
  describeLanding,
  holdLandedCards,
  listLandedCards,
  releaseHeldCards,
  showHeldCards,
  type HeldCard,
} from "@hercule/client-core/inbox";
import type { Inbox } from "@hercule/contract";
import { isMotionReduced } from "../../app/motion";
import {
  findLandingElement,
  holdSentence,
  isShownOnPage,
  lightRim,
  playReaction,
  REACTION_DELAY_MS,
  startDrop,
  type LandingTone,
} from "./landing";

const NOTHING: ReadonlySet<string> = new Set();
const NOTHING_HELD: ReadonlyMap<string, HeldCard> = new Map();

/** Joins the ids of two sets, or returns `before` itself when `more` adds nothing. */
const addIds = (before: ReadonlySet<string>, more: readonly string[]): ReadonlySet<string> =>
  more.every((id) => before.has(id)) ? before : new Set([...before, ...more]);

/** Returns what a screen reader says for the cards `ids` of `inbox`, one sentence for each card the read holds. */
const announceCards = (inbox: Inbox, ids: readonly string[]): string => {
  const wanted = new Set(ids);
  return inbox.cards
    .filter((card) => wanted.has(card.id))
    .map((card) => describeLanding(card).announcement)
    .join(". ");
};

/** The signals that landed on the cards of one read: the ids of the cards, and whether the reader asked for no movement. */
interface Landing {
  readonly number: number;
  readonly ids: readonly string[];
  readonly isReduced: boolean;
}

/** What `useSignalLanding` returns. */
export interface SignalLanding {
  /** The read to draw: `received`, with each card a drop is still falling onto as it was. */
  readonly inbox: Inbox | undefined;
  /** The cards a signal landed on, which stay fresh until reached. A card whose drop is still falling is not in it yet. */
  readonly freshIds: ReadonlySet<string>;
  /** Marks the card `id` as reached: its new mark goes. */
  readonly clearFresh: (id: string) => void;
  /** What the last signals said, for a screen reader's polite region. Empty before any landed. */
  readonly announcement: string;
}

/**
 * Plays the landing of a signal on a card of the Inbox page, and keeps what
 * the page shows true to it. A signal lands only for a change made while the
 * page is open: a read of this visit that follows another read of this visit
 * and brings a card a newer latest signal (`listLandedCards`). The visit's
 * first read, and a copy kept from an earlier visit (`isFresh` false), land
 * nothing.
 *
 * - The cause shows first. For each landed card on the page, a drop falls onto
 *   its line while the card still shows its old words. The new words are
 *   drawn `REACTION_DELAY_MS` later, in the same frame as the knock, the roll
 *   and the rim (`playReaction`). Nothing changes place: only the card's own
 *   words are held back, and the order of the page is never touched.
 * - A landed card that is not on screen, or is not drawn, plays nothing and
 *   waits the same time, which no one sees.
 * - Under Reduce motion nothing is held: the words change in place, and the
 *   rim fades.
 * - A card a signal landed on is fresh (`freshIds`), from the moment its new
 *   words are drawn, until `clearFresh`. A card that is new to the page is an
 *   arrival, not fresh.
 *
 * `received` is the visit's read, and `scrollRef` the element that scrolls the
 * page. The timers it starts stop when the screen closes.
 */
export const useSignalLanding = ({
  received,
  isFresh,
  scrollRef,
}: {
  readonly received: Inbox | undefined;
  readonly isFresh: boolean;
  readonly scrollRef: RefObject<HTMLElement | null>;
}): SignalLanding => {
  // The last of the visit's own reads, to see which cards a signal landed on since. A copy kept from
  // an earlier visit says nothing about this one.
  const [lastRead, setLastRead] = useState<Inbox | undefined>(undefined);
  const [freshIds, setFreshIds] = useState(NOTHING);
  const [held, setHeld] = useState(NOTHING_HELD);
  const [landing, setLanding] = useState<Landing | undefined>(undefined);
  const [announcement, setAnnouncement] = useState("");

  // Set while drawing, so the draw that shows a new read already holds its landed cards.
  if (isFresh && received !== undefined && received !== lastRead) {
    setLastRead(received);
    if (lastRead !== undefined) {
      const landed = listLandedCards(lastRead, received);
      if (landed.length > 0) {
        const number = (landing?.number ?? 0) + 1;
        // Read once per landing, here and not later, because the words are held or not as it says.
        const isReduced = isMotionReduced();
        setLanding({ number, ids: landed, isReduced });
        setFreshIds((before) => addIds(before, landed));
        if (isReduced) setAnnouncement(announceCards(received, landed));
        else setHeld((before) => holdLandedCards(before, lastRead, landed, number));
      }
    }
  }

  const latest = useRef({ received, held });
  useLayoutEffect(() => {
    latest.current = { received, held };
  });
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const running = timers.current;
    return () => {
      for (const timer of running) clearTimeout(timer);
      running.clear();
    };
  }, []);

  // A landing starts once the page shows what it holds: the cards with the words they had.
  useLayoutEffect(() => {
    if (landing === undefined) return;
    const scroller = scrollRef.current;
    const read = latest.current.received;
    const cards = new Map(read?.cards.map((card) => [card.id, card]));
    const dropped = new Map<string, LandingTone>();
    for (const id of landing.ids) {
      const card = cards.get(id);
      const element = scroller === null ? null : findLandingElement(scroller, id);
      if (scroller === null || card === undefined || element === null) continue;
      if (!isShownOnPage(scroller, element)) continue;
      const { tone } = describeLanding(card);
      if (landing.isReduced) {
        lightRim(element, tone);
      } else {
        startDrop(scroller, element, tone);
        dropped.set(id, tone);
      }
    }
    if (landing.isReduced) return;

    /** Draws the new words of the cards this landing holds, and plays the reaction on those a drop fell on. */
    const letLand = (): void => {
      const { held: now, received: newest } = latest.current;
      const ids = [...now].filter(([, each]) => each.landing === landing.number).map(([id]) => id);
      if (ids.length === 0) return;
      // The old words are still on the page: keep a copy of each sentence, to roll it away.
      const reactions = ids.flatMap((id) => {
        const tone = dropped.get(id);
        const element =
          scroller === null || tone === undefined ? null : findLandingElement(scroller, id);
        return element === null || tone === undefined
          ? []
          : [{ element, tone, was: holdSentence(element) }];
      });
      flushSync(() => {
        setHeld((before) => releaseHeldCards(before, landing.number));
        if (newest !== undefined) setAnnouncement(announceCards(newest, ids));
      });
      for (const { element, tone, was } of reactions) playReaction(element, tone, was);
    };
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      letLand();
    }, REACTION_DELAY_MS);
    timers.current.add(timer);
  }, [landing, scrollRef]);

  const clearFresh = (id: string): void => {
    setFreshIds((before) =>
      before.has(id) ? new Set([...before].filter((each) => each !== id)) : before,
    );
  };

  // The visit asks whether the read it draws is the same one as before, so the same inputs must give the same read.
  const inbox = useMemo(
    () => (received === undefined ? undefined : showHeldCards(received, held)),
    [received, held],
  );
  const shownFreshIds = useMemo(
    () => (held.size === 0 ? freshIds : new Set([...freshIds].filter((id) => !held.has(id)))),
    [freshIds, held],
  );

  return {
    inbox,
    freshIds: shownFreshIds,
    clearFresh,
    announcement,
  };
};
