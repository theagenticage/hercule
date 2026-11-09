/**
 * The Inbox page for the length of a visit. Nothing on the page moves unless
 * the user moves it, so what the screen draws is not the latest read but what
 * the visit lets through: `advanceInboxVisit` takes each read in turn and
 * returns the page to draw, with the cards that wait, the Group by menu and
 * what the user's own move emptied.
 *
 * - The visit's own first reply is drawn whole. From then on, a card the visit
 *   has not drawn is an arrival: it is held back until the caller releases it
 *   (the caller waits for a still hand), and it joins the end of its list.
 * - A card the user dismissed and put back is not an arrival. The visit drew
 *   it before, and it lies where it did.
 * - Where cards lie is held by `placeInboxCards`: a read changes the words on
 *   the page, never the place of a card the user has seen.
 * - What rides on what is held there too. The user's own Link and Unlink are
 *   the one thing that moves it. Each is a gesture the visit follows from
 *   its start to the controller's answer (`advanceLinkGesture`), so the visit
 *   is the only place that knows where a card rides.
 * - A signal that lands on a card is the visit's too (`recordLandedSignals`).
 *   When a fresh read brings a card a newer latest signal, the visit draws the
 *   card with its old words, tells the screen to play the landing
 *   (`InboxVisit.landing`), and draws the new words when the screen reports
 *   that the drop has landed. The card is fresh until the user reaches it
 *   (`advanceLanding`).
 */
import type { EntityUnlinkResult, Inbox } from "@hercule/contract";
import { replaceEqualDeep } from "@tanstack/query-core";
import type { CardBundle } from "./card-bundles";
import {
  keepHeldGrouping,
  listInboxGroupings,
  PLACE_GROUPING,
  type InboxGrouping,
} from "./groupings";
import { layOutInbox, type InboxLayout, type InboxView } from "./lay-out";
import {
  listShownFreshIds,
  NO_LANDINGS,
  reachLandedCard,
  recordLandedSignals,
  releaseLandedCards,
  showHeldCards,
  type SignalLanding,
  type SignalLandings,
} from "./landed-signals";
import {
  hasPlacedCards,
  NO_PLACEMENT,
  refuseRidingMove,
  settleRidingMove,
  startRidingMove,
  type RidingMove,
  type VisitPlacement,
} from "./visit-placement";

/** Whether a column shows cards, and when it shows none, whether the user's own move took the last one. */
type Emptiness = "filled" | "empty" | "emptied by move";

/**
 * What the visit remembers between two reads. Start from `START_OF_VISIT`, and
 * pass back the `history` that `advanceInboxVisit` returns.
 */
export interface VisitHistory {
  /**
   * Where the cards lie, and the Links and Unlinks that wait for an answer.
   * It holds no card (`hasPlacedCards` is false) until the visit's own first
   * reply has been placed.
   */
  readonly placement: VisitPlacement;
  /** The bundle each card of the last fresh reply carried, so a bundle that did not change keeps its identity. */
  readonly bundles: Readonly<Record<string, CardBundle>>;
  /** The whole page: no card at all. */
  readonly everything: Emptiness;
  /** The Requests column. */
  readonly requests: Emptiness;
  /** The signals that landed on the cards, the cards held for their drop, and the cards that are fresh. */
  readonly landings: SignalLandings;
}

/** A visit that has read nothing yet. */
export const START_OF_VISIT: VisitHistory = {
  placement: NO_PLACEMENT,
  bundles: {},
  everything: "empty",
  requests: "empty",
  landings: NO_LANDINGS,
};

/** One read of the Inbox, and what the caller knows about it. */
export interface VisitStep {
  /** The Inbox as read, with the user's pending edits applied, or `undefined` until the first read ends. */
  readonly received: Inbox | undefined;
  /** What the user chose on the toolbar. */
  readonly view: InboxView;
  /** The ids of the arrivals whose wait for a still hand is over. */
  readonly released: ReadonlySet<string>;
  /**
   * False while `received` is a copy kept from an earlier visit, which stands
   * in until this visit's own reply comes. That copy is laid out but never
   * held and has no arrivals: only the visit's own reply decides where cards
   * lie and which are new.
   */
  readonly isFresh: boolean;
  /**
   * True while `received` has moves of the user's own applied that the
   * controller has not answered yet. The cards that these moves took away are
   * not an accident: a column they leave empty is `emptiedByMove`.
   */
  readonly hasUserMove: boolean;
  /**
   * Asks whether the reader wants no movement. The visit asks only when a
   * signal lands, once for that landing, because the answer costs a style
   * lookup.
   */
  readonly isMotionReduced: () => boolean;
}

/** What the screen draws for one read. */
export interface InboxVisit {
  /** `received` without the arrivals that are held back, or `undefined` until the first read ends. */
  readonly inbox: Inbox | undefined;
  readonly layout: InboxLayout | undefined;
  /**
   * The rows of the Group by menu. It keeps a row for the grouping the page
   * is laid out with, also after a read stops offering it.
   */
  readonly groupings: readonly InboxGrouping[];
  /**
   * The ids of the cards of `received` that wait for a still hand. The page
   * must not count the read as shown while any waits, because the sidebar's
   * newest arrival covers those cards too.
   */
  readonly heldArrivals: readonly string[];
  /** Whether the user's own move took the last card of the whole page, or of the Requests column. */
  readonly emptiedByMove: { readonly everything: boolean; readonly requests: boolean };
  /**
   * The cards a signal landed on, which show the new mark until the user
   * reaches them (`advanceLanding`). A card whose drop is still falling is not
   * in it yet.
   */
  readonly freshIds: ReadonlySet<string>;
  /** What a screen reader says for the last signals that landed. Empty before any landed. */
  readonly announcement: string;
  /**
   * The last landing for the screen to play, or `undefined` before any. The
   * screen plays each landing (by its number) once, and reports back with
   * `advanceLanding` when the drop has landed. Under Reduce motion there is
   * nothing to report: the new words are drawn already.
   */
  readonly landing: SignalLanding | undefined;
}

const NO_ARRIVALS: readonly string[] = [];

/** The menu of a page that has not been read: Place alone, so the toolbar keeps its shape. */
const GROUPINGS_BEFORE_READ: readonly InboxGrouping[] = [PLACE_GROUPING];

/**
 * Returns the Inbox to draw and the ids of the cards it leaves out. Like
 * `holdBackBoardChanges` on the Work board, it leaves out what is new to
 * `shown` until its id is in `released`; everything else in `latest` is drawn
 * at once. Returns `latest` itself when nothing is held. With no `shown`, the
 * first reply of the visit, holds nothing.
 */
const holdBackArrivals = (
  shown: VisitPlacement | undefined,
  latest: Inbox,
  released: ReadonlySet<string>,
): { readonly inbox: Inbox; readonly held: readonly string[] } => {
  if (shown === undefined) return { inbox: latest, held: NO_ARRIVALS };
  const isHeld = (id: string): boolean => !shown.cards.has(id) && !released.has(id);
  const held = latest.cards.filter((card) => isHeld(card.id)).map((card) => card.id);
  if (held.length === 0) return { inbox: latest, held: NO_ARRIVALS };
  return { inbox: { ...latest, cards: latest.cards.filter((card) => !isHeld(card.id)) }, held };
};

/**
 * Returns the emptiness of a column after a read. A column the user's own
 * move leaves empty stays "emptied by move" until it fills again. A column
 * that was empty already, or that something else emptied, is only "empty".
 */
const advanceEmptiness = (before: Emptiness, isEmpty: boolean, hasUserMove: boolean): Emptiness => {
  if (!isEmpty) return "filled";
  return before === "emptied by move" || (hasUserMove && before === "filled")
    ? "emptied by move"
    : "empty";
};

/**
 * Returns what the screen draws for the next read of the visit, and what the
 * visit remembers from now on. Call it on every draw with the last `history`
 * and keep the `history` it returns, which is `history` itself when the read
 * adds nothing to it.
 *
 * Only a fresh reply (`step.isFresh`) is held in `history`: a copy kept from
 * an earlier visit is laid out and drawn but leaves no trace in it.
 */
export const advanceInboxVisit = (
  history: VisitHistory,
  step: VisitStep,
): { readonly visit: InboxVisit; readonly history: VisitHistory } => {
  const { received, view, released, isFresh, hasUserMove, isMotionReduced } = step;
  if (received === undefined) {
    return {
      visit: {
        inbox: undefined,
        layout: undefined,
        groupings: GROUPINGS_BEFORE_READ,
        heldArrivals: NO_ARRIVALS,
        emptiedByMove: { everything: false, requests: false },
        freshIds: history.landings.freshIds,
        announcement: history.landings.announcement,
        landing: history.landings.landing,
      },
      history,
    };
  }
  // A copy kept from an earlier visit says nothing about which signals landed in this one.
  const landings = isFresh
    ? recordLandedSignals(history.landings, received, isMotionReduced)
    : history.landings;
  const known = isFresh && hasPlacedCards(history.placement) ? history.placement : undefined;
  const { inbox, held } = holdBackArrivals(
    known,
    showHeldCards(received, landings.holds),
    released,
  );
  // A copy kept from an earlier visit holds nothing in place, but the user's moves that wait still show.
  const placementToLayOut = isFresh
    ? history.placement
    : { ...NO_PLACEMENT, pendingMoves: history.placement.pendingMoves };
  const layout = layOutInbox(inbox, view, placementToLayOut, history.bundles);

  const everything = advanceEmptiness(history.everything, inbox.cards.length === 0, hasUserMove);
  const requests = advanceEmptiness(
    history.requests,
    // A filter that hides every request is not the user finishing them: only a column with no request at all counts.
    layout.requests.isEmpty && !layout.requests.isEmptiedByFilter,
    hasUserMove,
  );
  const placement = isFresh ? layout.placement : history.placement;
  // The bundles keep their identity already, so this is cheap, and the history is the same object when none changed.
  const bundles = isFresh ? replaceEqualDeep(history.bundles, layout.bundles) : history.bundles;
  const isUnchanged =
    placement === history.placement &&
    bundles === history.bundles &&
    everything === history.everything &&
    requests === history.requests &&
    landings === history.landings;
  return {
    visit: {
      inbox,
      layout,
      groupings: keepHeldGrouping(listInboxGroupings(inbox), layout.placement.grouping),
      heldArrivals: held,
      emptiedByMove: {
        everything: everything === "emptied by move",
        requests: requests === "emptied by move",
      },
      freshIds: listShownFreshIds(landings),
      announcement: landings.announcement,
      landing: landings.landing,
    },
    history: isUnchanged ? history : { placement, bundles, everything, requests, landings },
  };
};

/**
 * One step in the life of a Link or Unlink the user made. The visit keeps the
 * gesture from its start until the controller answers it. Undo is no step of
 * its own: it is a new gesture in the other direction, started when Undo is
 * pressed, which the visit follows like any other.
 *
 * - `start`: the user made the gesture. Its `move` shows at once.
 * - `settle`: the controller accepted it. `remaining` is the answer of an
 *   Unlink: the firmest claim that still joins the pair.
 * - `refuse`: the controller refused it, or it changed nothing. The move is
 *   dropped, and the gestures made after it are played again on what is settled.
 */
export type LinkGestureStep =
  | { readonly _tag: "start"; readonly gesture: number; readonly move: RidingMove }
  | {
      readonly _tag: "settle";
      readonly gesture: number;
      readonly remaining: EntityUnlinkResult["remaining"];
    }
  | { readonly _tag: "refuse"; readonly gesture: number };

/**
 * Returns the history after `step`, or `history` itself when the step changes
 * nothing, as for a gesture that has no move waiting (one that planned none).
 * Call it when the user makes a Link or Unlink and when the controller answers
 * it. The next `advanceInboxVisit` draws the result.
 */
export const advanceLinkGesture = (history: VisitHistory, step: LinkGestureStep): VisitHistory => {
  const { placement } = history;
  const next =
    step._tag === "start"
      ? startRidingMove(placement, step.gesture, step.move)
      : step._tag === "settle"
        ? settleRidingMove(placement, step.gesture, step.remaining)
        : refuseRidingMove(placement, step.gesture);
  return next === placement ? history : { ...history, placement: next };
};

/**
 * One step in the life of a landing. The screen reports the first, and the user
 * causes the second.
 *
 * - `dropLanded`: the drop of landing `landing` has landed. The cards it holds
 *   draw their new words from the next draw on.
 * - `cardReached`: the user reached the card `id` with the pointer or the
 *   keys, or opened it. Its new mark goes.
 */
export type LandingStep =
  | { readonly _tag: "dropLanded"; readonly landing: number }
  | { readonly _tag: "cardReached"; readonly id: string };

/**
 * Returns the history after `step`, and the ids of the cards that draw their
 * new words because of it (only `dropLanded` releases any). A card that a later
 * landing took over is not among them. Returns `history` itself when the step
 * changes nothing. Call it when the screen reports that a drop has landed and
 * when the user reaches a card. The next `advanceInboxVisit` draws the result.
 */
export const advanceLanding = (
  history: VisitHistory,
  step: LandingStep,
): { readonly history: VisitHistory; readonly released: readonly string[] } => {
  const { landings } = history;
  const { landings: next, released } =
    step._tag === "dropLanded"
      ? releaseLandedCards(landings, step.landing)
      : { landings: reachLandedCard(landings, step.id), released: NO_ARRIVALS };
  return { history: next === landings ? history : { ...history, landings: next }, released };
};
