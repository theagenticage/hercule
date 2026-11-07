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
 */
import type { Inbox } from "@hercule/contract";
import {
  keepHeldGrouping,
  listInboxGroupings,
  PLACE_GROUPING,
  type InboxGrouping,
} from "./groupings";
import { layOutInbox, type InboxLayout, type InboxView } from "./lay-out";
import { NO_RIDING_CHOICES, type RidingChoices } from "./riding-choices";
import { NO_PLACEMENT, type VisitPlacement } from "./visit-placement";

/** Whether a column shows cards, and when it shows none, whether the user's own move took the last one. */
type Emptiness = "filled" | "empty" | "emptied by move";

/**
 * What the visit remembers between two reads. Start from `START_OF_VISIT`, and
 * pass back the `history` that `advanceInboxVisit` returns.
 */
export interface VisitHistory {
  /** Where the cards lie, or `undefined` until the visit's own first reply has been placed. */
  readonly placement: VisitPlacement | undefined;
  /** The whole page: no card at all. */
  readonly everything: Emptiness;
  /** The Requests column. */
  readonly requests: Emptiness;
}

/** A visit that has read nothing yet. */
export const START_OF_VISIT: VisitHistory = {
  placement: undefined,
  everything: "empty",
  requests: "empty",
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
   * What the user's own Link and Unlink put cards on or took them off in this
   * visit. Leave it out when none was made.
   */
  readonly riding?: RidingChoices;
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
  const { received, view, released, isFresh, hasUserMove } = step;
  if (received === undefined) {
    return {
      visit: {
        inbox: undefined,
        layout: undefined,
        groupings: GROUPINGS_BEFORE_READ,
        heldArrivals: NO_ARRIVALS,
        emptiedByMove: { everything: false, requests: false },
      },
      history,
    };
  }
  const known = isFresh ? history.placement : undefined;
  const { inbox, held } = holdBackArrivals(known, received, released);
  const layout = layOutInbox(inbox, view, known ?? NO_PLACEMENT, step.riding ?? NO_RIDING_CHOICES);

  const everything = advanceEmptiness(history.everything, inbox.cards.length === 0, hasUserMove);
  const requests = advanceEmptiness(history.requests, layout.requests.isEmpty, hasUserMove);
  const placement = isFresh ? layout.placement : history.placement;
  const isUnchanged =
    placement === history.placement &&
    everything === history.everything &&
    requests === history.requests;
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
    },
    history: isUnchanged ? history : { placement, everything, requests },
  };
};
