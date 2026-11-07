/**
 * The rules of the Inbox page, applied to one read. The wide side (Ongoing)
 * holds lasting work as rows on the surface of each place. The narrow column
 * holds Requests, with "With someone else" at its foot. Nothing folds, and
 * nothing the user did not ask for changes place: the order never reads
 * activity, only when a card was first observed and when it joined the visit.
 */
import type { Inbox, InboxCard, InboxSide } from "@hercule/contract";
import { filterItems, type Filter } from "../desk/filter";
import type { OpenPlaceRow } from "../desk/relation-rows";
import { buildInboxFacets } from "./facets";
import {
  buildPlaceContext,
  compareSurfaceHeads,
  findHomeName,
  listNearPlaces,
  refreshSurfaceHead,
  type PlaceContext,
  type SurfaceHead,
} from "./inbox-place";
import {
  placeInboxCards,
  type PlacementChoice,
  type RequestsOrder,
  type VisitPlacement,
} from "./visit-placement";

/** What the user chose on the toolbar. Where cards lie is held apart, by `placeInboxCards`. */
export interface InboxView extends PlacementChoice {
  readonly filter: Filter;
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

/** One raised surface and the work on it in the order it joined the visit, then the pointers. */
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
  /** What the visit holds after this read. Pass it as `held` to the layout of the next read. */
  readonly placement: VisitPlacement;
  /** The grouping in use. It is `HOME_GROUPING` when the one asked for has no place left to offer. */
  readonly grouping: string;
  readonly ongoing: ColumnState & { readonly surfaces: readonly InboxSurface[] };
  readonly requests: ColumnState & {
    readonly groups: readonly RequestGroup[];
    /**
     * How many requests wait on the user, as the controller counts them: all
     * of them, not only the cards the page holds, and not those a filter
     * leaves. A card just taken keeps its place for the visit, but the
     * controller no longer counts it. It is the small number beside the heading.
     */
    readonly awaitingCount: number;
  };
  readonly withSomeoneElse: { readonly rows: readonly ColumnRow[] };
}

const buildColumnRow = (card: InboxCard, context: PlaceContext): ColumnRow => ({
  card,
  homeName: findHomeName(card, context),
});

/** Returns the Requests groups. Cards come in the order given; a group lies where `placement` ranks its key. */
const groupRequests = (
  cards: readonly InboxCard[],
  order: RequestsOrder,
  context: PlaceContext,
  placement: VisitPlacement,
): readonly RequestGroup[] => {
  const byKey = new Map<string, ColumnRow[]>();
  for (const card of cards) {
    const key = placement.cards.get(card.id)?.requestGroup ?? "";
    const rows = byKey.get(key);
    const row = buildColumnRow(card, context);
    if (rows === undefined) byKey.set(key, [row]);
    else rows.push(row);
  }
  const groups = [...byKey]
    .sort(
      ([a], [b]) =>
        (placement.groupRank.get(a) ?? Infinity) - (placement.groupRank.get(b) ?? Infinity) ||
        a.localeCompare(b, "en"),
    )
    .map(([key, rows]) => ({ key, rows }));
  // Only "by place" draws a label for each group; the other orders draw one list.
  return order === "place"
    ? groups.map(({ key, rows }) => ({ label: key, rows }))
    : groups.length === 0
      ? []
      : [{ rows: groups.flatMap((group) => group.rows) }];
};

const buildSurfaces = (
  cards: readonly InboxCard[],
  context: PlaceContext,
  placement: VisitPlacement,
): readonly InboxSurface[] => {
  const surfaces = new Map<
    string,
    { head: SurfaceHead; full: OngoingRow[]; pointers: OngoingRow[] }
  >();
  for (const card of cards) {
    const heads = placement.cards.get(card.id)?.heads ?? [];
    const [first, ...others] = heads.map((head) => refreshSurfaceHead(head, context));
    if (first === undefined) continue;
    for (const [index, head] of [first, ...others].entries()) {
      const surface = surfaces.get(head.id) ?? { head, full: [], pointers: [] };
      surfaces.set(head.id, surface);
      if (index === 0) surface.full.push({ card, near: listNearPlaces(card, head.id, context) });
      else surface.pointers.push({ card, alsoIn: first, near: [] });
    }
  }
  return [...surfaces.values()]
    .sort(
      (a, b) =>
        (placement.surfaceRank.get(a.head.id) ?? Infinity) -
          (placement.surfaceRank.get(b.head.id) ?? Infinity) || compareSurfaceHeads(a.head, b.head),
    )
    .map(({ head, full, pointers }) => ({ head, rows: [...full, ...pointers] }));
};

const decideColumnState = (shown: number, beforeFilter: number): ColumnState => ({
  isEmpty: shown === 0,
  isEmptiedByFilter: shown === 0 && beforeFilter > 0,
});

/**
 * Lays out the page for one read of the Inbox. `held` is what the visit has
 * held from the reads before this one (`NO_PLACEMENT` at the start of a visit).
 * It says which column, surface and group each card lies in, and in what
 * order the surfaces and groups come. The read decides what is written in
 * them, and where a card that is new to the visit lies (`placeInboxCards`).
 * The layout returns what the visit holds now, as `placement`, to pass as `held`
 * with the next read.
 *
 * - A card lies in the column of its held side.
 * - Ongoing: a surface for each place, grouped as the held grouping says.
 *   The surfaces keep the order they joined the visit in, and so does each
 *   card's surface. On a surface the cards come in the order they joined the
 *   visit, then the pointers to cards drawn in full elsewhere.
 * - Requests: in that order, or yours first (still in that order within each
 *   half), or by place with a label for each place. Each request keeps its group.
 * - With someone else: in that order, at the foot of the column.
 *
 * The order the cards join the visit in is oldest first for the first read,
 * and a card that arrives later comes after them, so nothing a reader is
 * looking at moves.
 * - The filter narrows all three. It changes no number the sidebar shows.
 */
export const layOutInbox = (inbox: Inbox, view: InboxView, held: VisitPlacement): InboxLayout => {
  const context = buildPlaceContext(inbox);
  const placement = placeInboxCards(inbox, view, held, context);
  // Every list keeps the order its cards joined the visit in: oldest first at the start, then arrivals.
  const inVisitOrder = inbox.cards.toSorted(
    (a, b) => (placement.cards.get(a.id)?.rank ?? 0) - (placement.cards.get(b.id)?.rank ?? 0),
  );
  const shown = new Set(
    filterItems(inVisitOrder, view.filter, buildInboxFacets(inbox)).map((card) => card.id),
  );
  const cardsOn = (side: InboxSide, onlyShown: boolean): InboxCard[] =>
    inVisitOrder.filter(
      (card) =>
        (placement.cards.get(card.id)?.side ?? card.side) === side &&
        (!onlyShown || shown.has(card.id)),
    );

  const ongoing = cardsOn("ongoing", true);
  const requests = cardsOn("requests", true);
  return {
    placement,
    grouping: placement.grouping.id,
    ongoing: {
      surfaces: buildSurfaces(ongoing, context, placement),
      ...decideColumnState(ongoing.length, cardsOn("ongoing", false).length),
    },
    requests: {
      groups: groupRequests(requests, view.requestsOrder, context, placement),
      awaitingCount: inbox.counts.requests,
      ...decideColumnState(requests.length, cardsOn("requests", false).length),
    },
    withSomeoneElse: {
      rows: cardsOn("with-someone-else", true).map((card) => buildColumnRow(card, context)),
    },
  };
};
