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
import {
  buildCardBundle,
  decideDrawnRiding,
  EMPTY_BUNDLE,
  indexBundleSources,
  type BundleSources,
  type CardBundle,
} from "./card-bundles";
import { listCardOffers, NO_OFFERS, type CardOffers } from "./card-hand-off";
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
  /** The workflows the card's Hand to move offers. None for a pointer. */
  readonly offers: CardOffers;
  /**
   * Set when the card lies on this surface only as a plain pointer ("Also in
   * ..."): it is drawn in full on this other surface.
   */
  readonly alsoIn?: SurfaceHead;
  /** The places the row names beside its title, such as its milestone. */
  readonly near: readonly OpenPlaceRow[];
  /** What rides on the card and the hints under it. Empty for a pointer. */
  readonly bundle: CardBundle;
}

/** One raised surface and the work on it in the order it joined the visit, then the pointers. */
export interface InboxSurface {
  readonly head: SurfaceHead;
  readonly rows: readonly OngoingRow[];
}

/** A card in the narrow column. */
export interface ColumnRow {
  readonly card: InboxCard;
  /** The workflows the card's Hand to move offers. */
  readonly offers: CardOffers;
  /** The title of the card's first home that has one. */
  readonly homeName: string | undefined;
  /** The lines under the card ("Mentions OPS-47", "Linked to #6263"). A request carries no parts. */
  readonly bundle: CardBundle;
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
  /** The bundle of each card that carries something, by card id. Pass it as `previousBundles` to the layout of the next read. */
  readonly bundles: Readonly<Record<string, CardBundle>>;
}

/** Builds the row of `card` in a column. Only a card of Requests carries lines: a card a Task holds is plain. */
const buildColumnRow = (
  card: InboxCard,
  context: PlaceContext,
  sources: BundleSources,
  side: InboxSide,
): ColumnRow => ({
  card,
  offers: listCardOffers(card, sources.offerSets),
  homeName: findHomeName(card, context),
  bundle: side === "requests" ? buildCardBundle(card, sources) : EMPTY_BUNDLE,
});

/** Returns the Requests groups. Cards come in the order given; a group lies where `placement` ranks its key. */
const groupRequests = (
  cards: readonly InboxCard[],
  order: RequestsOrder,
  context: PlaceContext,
  placement: VisitPlacement,
  sources: BundleSources,
): readonly RequestGroup[] => {
  const byKey = new Map<string, ColumnRow[]>();
  for (const card of cards) {
    const key = placement.cards.get(card.id)?.requestGroup ?? "";
    const rows = byKey.get(key);
    const row = buildColumnRow(card, context, sources, "requests");
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
  sources: BundleSources,
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
      if (index === 0) {
        surface.full.push({
          card,
          offers: listCardOffers(card, sources.offerSets),
          near: listNearPlaces(card, head.id, context),
          bundle: buildCardBundle(card, sources),
        });
      } else
        surface.pointers.push({
          card,
          offers: NO_OFFERS,
          alsoIn: first,
          near: [],
          bundle: EMPTY_BUNDLE,
        });
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

/** No bundle drawn before: the first layout of a visit. */
const NO_BUNDLES: Readonly<Record<string, CardBundle>> = {};

/** Returns the bundle of every card drawn in full that carries something, by card id. */
const indexBundles = (
  surfaces: readonly InboxSurface[],
  groups: readonly RequestGroup[],
): Readonly<Record<string, CardBundle>> => {
  const bundles: Record<string, CardBundle> = {};
  const rows = [
    ...surfaces.flatMap((surface) => surface.rows.filter((row) => row.alsoIn === undefined)),
    ...groups.flatMap((group) => group.rows),
  ];
  for (const { card, bundle } of rows) {
    if (bundle !== EMPTY_BUNDLE) bundles[card.id] = bundle;
  }
  return bundles;
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
 * with the next read, and the `bundles` it drew, to pass as `previousBundles`.
 * A bundle that has not changed keeps its identity, so what compares it by
 * identity does not draw it again. Each row, and each asking part of a
 * bundle, carries the offers of its own card (`offers`): cards of one offer
 * set share one object, so a change to one set redraws only its cards. The user's own Link and Unlink that wait for
 * an answer are in `held.pendingMoves`.
 *
 * - A card lies in the column of its held side.
 * - Ongoing: a surface for each place, grouped as the held grouping says.
 *   The surfaces keep the order they joined the visit in, and so does each
 *   card's surface. On a surface the cards come in the order they joined the
 *   visit, then the pointers to cards drawn in full elsewhere. A card carries
 *   the small things that ride on it, and the hints under it (`bundle`).
 * - Requests: in that order, or yours first (still in that order within each
 *   half), or by place with a label for each place. Each request keeps its group.
 *   A request that rides on a card of the wide side is drawn there, not here.
 * - With someone else: in that order, at the foot of the column.
 *
 * The order the cards join the visit in is oldest first for the first read,
 * and a card that arrives later comes after them, so nothing a reader is
 * looking at moves.
 * - The filter narrows all three. It changes no number the sidebar shows. A card
 *   of the wide side passes when it or any card that rides on it does, so a
 *   filter never tears a thing from what it rides on.
 */
export const layOutInbox = (
  inbox: Inbox,
  view: InboxView,
  held: VisitPlacement,
  previousBundles: Readonly<Record<string, CardBundle>> = NO_BUNDLES,
): InboxLayout => {
  const context = buildPlaceContext(inbox);
  const placement = placeInboxCards(inbox, view, held, context);
  const readRank = (id: string): number => placement.cards.get(id)?.rank ?? 0;
  // Every list keeps the order its cards joined the visit in: oldest first at the start, then arrivals.
  const inVisitOrder = inbox.cards.toSorted((a, b) => readRank(a.id) - readRank(b.id));
  const drawnRiding = decideDrawnRiding(inbox.cards, placement);
  const sources = indexBundleSources(inbox, drawnRiding, readRank, context, previousBundles);
  const shown = new Set(
    filterItems(inVisitOrder, view.filter, buildInboxFacets(inbox)).map((card) => card.id),
  );
  for (const [id, leadRef] of drawnRiding) {
    const lead = sources.cardByRef.get(leadRef);
    if (shown.has(id) && lead !== undefined) shown.add(lead.id);
  }
  const cardsOn = (side: InboxSide, onlyShown: boolean): InboxCard[] =>
    inVisitOrder.filter(
      (card) =>
        (placement.cards.get(card.id)?.side ?? card.side) === side &&
        !drawnRiding.has(card.id) &&
        (!onlyShown || shown.has(card.id)),
    );

  const ongoing = cardsOn("ongoing", true);
  const requests = cardsOn("requests", true);
  const surfaces = buildSurfaces(ongoing, context, placement, sources);
  const groups = groupRequests(requests, view.requestsOrder, context, placement, sources);
  return {
    placement,
    grouping: placement.grouping.id,
    ongoing: {
      surfaces,
      ...decideColumnState(ongoing.length, cardsOn("ongoing", false).length),
    },
    requests: {
      groups,
      awaitingCount: inbox.counts.requests,
      ...decideColumnState(requests.length, cardsOn("requests", false).length),
    },
    withSomeoneElse: {
      rows: cardsOn("with-someone-else", true).map((card) =>
        buildColumnRow(card, context, sources, "with-someone-else"),
      ),
    },
    bundles: indexBundles(surfaces, groups),
  };
};

/**
 * Returns the cards drawn riding on the card `cardId` in `layout`, or none when
 * it carries nothing or is not drawn in full. Dismissing the card lets them
 * stand alone.
 */
export const listRiders = (layout: InboxLayout, cardId: string): readonly InboxCard[] =>
  layout.ongoing.surfaces
    .flatMap((surface) => surface.rows)
    .find((row) => row.card.id === cardId && row.alsoIn === undefined)?.bundle.riders ?? [];
