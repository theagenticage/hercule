/**
 * Where a card lies on the Inbox page. Lasting work (a rich card) lies on the
 * raised surface of each place it is part of. A small request (a compact card)
 * lies in the Requests column, under its home's name. No code here knows a
 * kind: the places come from the replies' places and edges, and the kind
 * table's `home` and `section` words come from the plugin catalog.
 */
import type { EntityPlace, EntityStatus, Inbox, InboxCard } from "@hercule/contract";
import { readEntityPluginId } from "../desk/entity-words";
import {
  buildPlaceRow,
  indexRelationGraph,
  readAncestorRows,
  type AncestorRow,
  type OpenPlaceRow,
  type PlaceRow,
  type RelationIndex,
} from "../desk/relation-rows";

/** The grouping id for the usual place of each kind. */
export const HOME_GROUPING = "home";

/** The grouping id for status. */
export const STATUS_GROUPING = "status";

/**
 * The head of one surface on the wide side: a place, the source of a card that
 * has no place, or a plain title (a status, or "No <kind of place>").
 */
export type SurfaceHead =
  | {
      readonly _tag: "place";
      /** The place's ref. */
      readonly id: string;
      readonly row: PlaceRow;
      /** Every place above this one, each once, nearest first. */
      readonly above: readonly AncestorRow[];
    }
  | {
      readonly _tag: "source";
      readonly id: string;
      /** The surface is named for this plugin. */
      readonly pluginId: string;
    }
  | {
      readonly _tag: "plain";
      readonly id: string;
      readonly title: string;
      /** The tone of the status the surface is named for. It orders status groups, and is absent otherwise. */
      readonly tone?: EntityStatus["tone"];
    };

/** What every placement of one Inbox reads, built once. */
export interface PlaceContext {
  /** The places of the reply by ref, and the refs each ref is directly part of in the order of the edges. */
  readonly index: RelationIndex;
  /** The caption of each kind of place that has one. */
  readonly captionOfKind: ReadonlyMap<string, string>;
  readonly inbox: Inbox;
  /** The heads already built, so a place that many cards lie on is read once. */
  readonly headByRef: Map<string, SurfaceHead>;
}

/** Returns what every placement of `inbox` reads, so a place that many cards lie on is read once. */
export const buildPlaceContext = (inbox: Inbox): PlaceContext => {
  const captionOfKind = new Map<string, string>();
  for (const place of inbox.places) {
    if (place.caption !== undefined) captionOfKind.set(place.kind, place.caption);
  }
  return {
    index: indexRelationGraph(inbox),
    captionOfKind,
    inbox,
    headByRef: new Map(),
  };
};

/** Returns the places above `card` that the reply holds, nearest first. */
const listAncestorPlaces = (card: InboxCard, context: PlaceContext): EntityPlace[] =>
  card.ancestors.flatMap((ref) => context.index.placeByRef.get(ref) ?? []);

const readPlaceHead = (place: EntityPlace, context: PlaceContext): SurfaceHead => {
  const known = context.headByRef.get(place.ref);
  if (known !== undefined) return known;
  const head: SurfaceHead = {
    _tag: "place",
    id: place.ref,
    row: buildPlaceRow(place),
    above: readAncestorRows(place.ref, context.inbox, context.index),
  };
  context.headByRef.set(place.ref, head);
  return head;
};

/**
 * Returns `head` as `context` describes it now. A place head is read again, so
 * a surface held for the visit still shows the place's current status and
 * progress. A head the reply no longer holds, and a head that is not a place,
 * come back as they were.
 */
export const refreshSurfaceHead = (head: SurfaceHead, context: PlaceContext): SurfaceHead => {
  if (head._tag !== "place") return head;
  const place = context.index.placeByRef.get(head.id);
  return place === undefined ? head : readPlaceHead(place, context);
};

/** Returns the places above `card` of the kind its record names as `home`. */
const listHomes = (card: InboxCard, context: PlaceContext): EntityPlace[] => {
  return listAncestorPlaces(card, context).filter((place) => place.kind === card.home);
};

const decideStatusHead = (card: InboxCard): SurfaceHead =>
  card.status === undefined
    ? { _tag: "plain", id: "status:none", title: "No status" }
    : {
        _tag: "plain",
        id: `status:${card.status.tone}:${card.status.label}`,
        title: card.status.label,
        tone: card.status.tone,
      };

/**
 * Returns the heads of the surfaces `card` lies on for one grouping, the first
 * being where it is drawn in full:
 *
 * - `status`: one head, named for the card's status;
 * - `home`: each home of the card, or a head named for the card's plugin when
 *   it has none;
 * - the word of a kind of place: each place above the card of that kind, or
 *   "No <caption>" when it has none.
 */
export const findSurfaceHeads = (
  card: InboxCard,
  context: PlaceContext,
  grouping: string,
): readonly SurfaceHead[] => {
  if (grouping === STATUS_GROUPING) return [decideStatusHead(card)];
  const places =
    grouping === HOME_GROUPING
      ? listHomes(card, context)
      : listAncestorPlaces(card, context).filter((place) => place.kind === grouping);
  if (places.length > 0) return places.map((place) => readPlaceHead(place, context));
  if (grouping === HOME_GROUPING) {
    const pluginId = readEntityPluginId(card.kind);
    return [{ _tag: "source", id: `source:${pluginId}`, pluginId }];
  }
  const caption = context.captionOfKind.get(grouping);
  return [
    {
      _tag: "plain",
      id: `none:${grouping}`,
      title: caption === undefined ? "No place" : `No ${caption}`,
    },
  ];
};

/** Returns the title of the first home of `card` that has one. */
export const findHomeName = (card: InboxCard, context: PlaceContext): string | undefined =>
  listHomes(card, context).find((place) => place.title !== undefined)?.title;

/**
 * Returns the places a row shows beside its title: the places the card is
 * directly part of, other than the surface it lies on, that are of its kind's
 * `home` or `section` level (a milestone, say). Restricted places are left out.
 */
export const listNearPlaces = (
  card: InboxCard,
  surfaceId: string,
  context: PlaceContext,
): readonly OpenPlaceRow[] => {
  const near: OpenPlaceRow[] = [];
  for (const ref of context.index.parents.get(card.ref) ?? []) {
    const place = context.index.placeByRef.get(ref);
    if (place === undefined || ref === surfaceId) continue;
    if (place.kind !== card.home && place.kind !== card.section) continue;
    const row = buildPlaceRow(place);
    if (!row.isLocked) near.push(row);
  }
  return near;
};

const TONE_ORDER: Readonly<Record<EntityStatus["tone"], number>> = {
  bad: 0,
  attention: 1,
  active: 2,
  quiet: 3,
  good: 4,
};

/** Returns the sort key of a head: places and statuses first, then heads named for a source or for nothing. */
const rankHead = (head: SurfaceHead): readonly [number, number, number, string] => {
  if (head._tag === "source") return [1, 1, Infinity, head.pluginId];
  if (head._tag === "plain") {
    return head.tone === undefined
      ? [1, 0, Infinity, head.title]
      : [0, TONE_ORDER[head.tone], Infinity, head.title];
  }
  if (head.row.isLocked) return [0, 3, Infinity, ""];
  // A place in trouble comes first, then one that needs watching, then the rest by date.
  const trouble =
    head.row.status?.tone === "bad" ? 0 : head.row.status?.tone === "attention" ? 1 : 2;
  const due = head.row.targetDate === undefined ? Infinity : Date.parse(head.row.targetDate);
  return [0, trouble, due, head.row.title];
};

/**
 * Compares two surface heads: places in trouble (status tone `bad`, then
 * `attention`) first, then by `targetDate` with undated places last, then by
 * name. Heads named for a status are ordered by tone. Heads named for a source
 * or for nothing come last.
 */
export const compareSurfaceHeads = (a: SurfaceHead, b: SurfaceHead): number => {
  const [bucketA, toneA, dueA, nameA] = rankHead(a);
  const [bucketB, toneB, dueB, nameB] = rankHead(b);
  return (
    bucketA - bucketB ||
    toneA - toneB ||
    (dueA === dueB ? 0 : dueA < dueB ? -1 : 1) ||
    nameA.localeCompare(nameB, "en")
  );
};
