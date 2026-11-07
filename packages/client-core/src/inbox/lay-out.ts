/**
 * The rules of the Inbox page, applied to one read. The wide side (Ongoing)
 * holds lasting work as rows on the surface of each place. The narrow column
 * holds Requests, with "With someone else" at its foot. Nothing folds, and
 * nothing the user did not ask for changes place: the order never reads
 * activity, only when a card was first observed.
 */
import type { Inbox, InboxCard, InboxSide } from "@hercule/contract";
import { filterItems, type Filter } from "../desk/filter";
import type { OpenPlaceRow } from "../desk/relation-rows";
import { buildInboxFacets } from "./facets";
import { listInboxGroupings } from "./groupings";
import {
  buildPlaceContext,
  compareSurfaceHeads,
  findHomeName,
  findSurfaceHeads,
  HOME_GROUPING,
  listNearPlaces,
  type PlaceContext,
  type SurfaceHead,
} from "./inbox-place";

/** How the Requests column is ordered. */
export type RequestsOrder = "oldest" | "mine" | "place";

/** What the user chose on the toolbar, and what the visit holds in place. */
export interface InboxView {
  /** `HOME_GROUPING`, `STATUS_GROUPING`, or the word of a kind of place. See `listInboxGroupings`. */
  readonly grouping: string;
  readonly filter: Filter;
  readonly requestsOrder: RequestsOrder;
  /**
   * The side each card was first seen on during this visit, by card id, from
   * `holdInboxSides`. A card that gets a Task keeps its place until the next
   * visit: the server already puts it under "With someone else", the page does
   * not.
   */
  readonly heldSides: ReadonlyMap<string, InboxSide>;
}

/** A card on a surface. */
export interface OngoingRow {
  readonly card: InboxCard;
  /**
   * Set when the card lies on this surface only as a plain pointer ("Also in
   * ..."): it is drawn in full on this other surface.
   */
  readonly alsoIn?: SurfaceHead;
  /** The places the row names beside its title, such as its milestone. */
  readonly near: readonly OpenPlaceRow[];
}

/** One raised surface and the work on it: oldest first, then the pointers. */
export interface InboxSurface {
  readonly head: SurfaceHead;
  readonly rows: readonly OngoingRow[];
}

/** A card in the narrow column. */
export interface ColumnRow {
  readonly card: InboxCard;
  /** The title of the card's first home that has one. */
  readonly homeName: string | undefined;
}

/** Requests, in one group, or one group for each place when ordered by place. */
export interface RequestGroup {
  /** The place's title, or "Elsewhere". Absent unless ordered by place. */
  readonly label?: string;
  readonly rows: readonly ColumnRow[];
}

/** What a column shows, and why it may show nothing. */
export interface ColumnState {
  readonly isEmpty: boolean;
  /** True when the column is empty only because the filter hides every card in it. */
  readonly isEmptiedByFilter: boolean;
}

/** The whole page, ready to map over. */
export interface InboxLayout {
  /** The grouping in use. It is `HOME_GROUPING` when the one asked for has no place left to offer. */
  readonly grouping: string;
  readonly ongoing: ColumnState & { readonly surfaces: readonly InboxSurface[] };
  readonly requests: ColumnState & { readonly groups: readonly RequestGroup[] };
  readonly withSomeoneElse: { readonly rows: readonly ColumnRow[] };
}

/**
 * Returns `held` with the side of each card it does not hold yet, taken from
 * the read. The screen calls it on every read of a visit and keeps the result,
 * so a card that gets a Task after the page drew it stays on its side.
 */
export const holdInboxSides = (
  held: ReadonlyMap<string, InboxSide>,
  inbox: Inbox,
): ReadonlyMap<string, InboxSide> => {
  const next = new Map(held);
  for (const card of inbox.cards) {
    if (!next.has(card.id)) next.set(card.id, card.side);
  }
  return next;
};

/** Sorts oldest first by when the card was first observed, then by id, so the order never depends on activity. */
const compareOldestFirst = (a: InboxCard, b: InboxCard): number =>
  Date.parse(a.firstObservedAt) - Date.parse(b.firstObservedAt) || a.id.localeCompare(b.id, "en");

const buildColumnRow = (card: InboxCard, context: PlaceContext): ColumnRow => ({
  card,
  homeName: findHomeName(card, context),
});

const ELSEWHERE = "Elsewhere";

/** Returns the Requests groups. Cards come oldest first. */
const groupRequests = (
  cards: readonly InboxCard[],
  order: RequestsOrder,
  context: PlaceContext,
): readonly RequestGroup[] => {
  if (cards.length === 0) return [];
  const rows = cards.map((card) => buildColumnRow(card, context));
  if (order === "oldest") return [{ rows }];
  if (order === "mine") {
    return [
      { rows: [...rows.filter((row) => row.card.yours), ...rows.filter((row) => !row.card.yours)] },
    ];
  }
  const byPlace = new Map<string, ColumnRow[]>();
  for (const row of rows) {
    const label = row.homeName ?? ELSEWHERE;
    byPlace.set(label, [...(byPlace.get(label) ?? []), row]);
  }
  return [...byPlace]
    .sort(([a], [b]) => (a === ELSEWHERE ? 1 : b === ELSEWHERE ? -1 : a.localeCompare(b, "en")))
    .map(([label, grouped]) => ({ label, rows: grouped }));
};

const buildSurfaces = (
  cards: readonly InboxCard[],
  grouping: string,
  context: PlaceContext,
): readonly InboxSurface[] => {
  const surfaces = new Map<
    string,
    { head: SurfaceHead; full: OngoingRow[]; pointers: OngoingRow[] }
  >();
  for (const card of cards) {
    const [first, ...others] = findSurfaceHeads(card, context, grouping);
    if (first === undefined) continue;
    for (const [index, head] of [first, ...others].entries()) {
      const surface = surfaces.get(head.id) ?? { head, full: [], pointers: [] };
      surfaces.set(head.id, surface);
      if (index === 0) surface.full.push({ card, near: listNearPlaces(card, head.id, context) });
      else surface.pointers.push({ card, alsoIn: first, near: [] });
    }
  }
  return [...surfaces.values()]
    .sort((a, b) => compareSurfaceHeads(a.head, b.head))
    .map(({ head, full, pointers }) => ({ head, rows: [...full, ...pointers] }));
};

const decideColumnState = (shown: number, beforeFilter: number): ColumnState => ({
  isEmpty: shown === 0,
  isEmptiedByFilter: shown === 0 && beforeFilter > 0,
});

/**
 * Lays out the page for one read of the Inbox.
 *
 * - A card lies in the column of its held side (`view.heldSides`), else of the
 *   side the server put it on.
 * - Ongoing: a surface for each place, grouped as `view.grouping` says. Places
 *   in trouble come first, then by `targetDate`, then by name. On a surface the
 *   cards come oldest first, then the pointers to cards drawn in full elsewhere.
 * - Requests: oldest first, or yours first (still oldest first within each
 *   half), or by place with a label for each place, ordered by name.
 * - With someone else: oldest first, at the foot of the column.
 * - The filter narrows all three. It changes no number the sidebar shows.
 *
 * A grouping that `listInboxGroupings` no longer offers falls back
 * to `HOME_GROUPING`, and the layout says so in `grouping`.
 */
export const layOutInbox = (inbox: Inbox, view: InboxView): InboxLayout => {
  const grouping = listInboxGroupings(inbox).some((offered) => offered.id === view.grouping)
    ? view.grouping
    : HOME_GROUPING;
  const context = buildPlaceContext(inbox);
  const sideOf = (card: InboxCard): InboxSide => view.heldSides.get(card.id) ?? card.side;
  const oldestFirst = [...inbox.cards].sort(compareOldestFirst);
  const shown = new Set(
    filterItems(oldestFirst, view.filter, buildInboxFacets(inbox)).map((card) => card.id),
  );
  const cardsOn = (side: InboxSide, onlyShown: boolean): InboxCard[] =>
    oldestFirst.filter((card) => sideOf(card) === side && (!onlyShown || shown.has(card.id)));

  const ongoing = cardsOn("ongoing", true);
  const requests = cardsOn("requests", true);
  return {
    grouping,
    ongoing: {
      surfaces: buildSurfaces(ongoing, grouping, context),
      ...decideColumnState(ongoing.length, cardsOn("ongoing", false).length),
    },
    requests: {
      groups: groupRequests(requests, view.requestsOrder, context),
      ...decideColumnState(requests.length, cardsOn("requests", false).length),
    },
    withSomeoneElse: {
      rows: cardsOn("with-someone-else", true).map((card) => buildColumnRow(card, context)),
    },
  };
};
