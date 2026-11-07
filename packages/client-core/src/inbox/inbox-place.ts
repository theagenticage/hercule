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
  type AncestorRow,
  type OpenPlaceRow,
  type PlaceRow,
  readAncestorRows,
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

/** Where one card lies. */
export type InboxPlace =
  | {
      readonly _tag: "surfaces";
      /** The card is drawn in full on the first and as a plain pointer on each other. Never empty. */
      readonly heads: readonly SurfaceHead[];
    }
  | {
      readonly _tag: "request";
      /** The title of the card's first home that has one, or `undefined`. */
      readonly homeName: string | undefined;
    };

/** What every placement of one Inbox reads, built once. */
export interface PlaceContext {
  readonly placeByRef: ReadonlyMap<string, EntityPlace>;
  /** The refs a ref is directly part of, in the order of the edges. */
  readonly parentsOf: ReadonlyMap<string, readonly string[]>;
  /** The caption of each kind of place that has one. */
  readonly captionOfKind: ReadonlyMap<string, string>;
  readonly inbox: Inbox;
  /** The heads already built, so a place that many cards lie on is read once. */
  readonly headByRef: Map<string, SurfaceHead>;
}

export const buildPlaceContext = (inbox: Inbox): PlaceContext => {
  const parentsOf = new Map<string, string[]>();
  for (const edge of inbox.edges) {
    parentsOf.set(edge.fromRef, [...(parentsOf.get(edge.fromRef) ?? []), edge.toRef]);
  }
  const captionOfKind = new Map<string, string>();
  for (const place of inbox.places) {
    if (place.caption !== undefined) captionOfKind.set(place.kind, place.caption);
  }
  return {
    placeByRef: new Map(inbox.places.map((place) => [place.ref, place])),
    parentsOf,
    captionOfKind,
    inbox,
    headByRef: new Map(),
  };
};

/** Returns the places above `card` that the reply holds, nearest first. */
export const listAncestorPlaces = (card: InboxCard, context: PlaceContext): EntityPlace[] =>
  card.ancestors.flatMap((ref) => context.placeByRef.get(ref) ?? []);

const readPlaceHead = (place: EntityPlace, context: PlaceContext): SurfaceHead => {
  const known = context.headByRef.get(place.ref);
  if (known !== undefined) return known;
  const head: SurfaceHead = {
    _tag: "place",
    id: place.ref,
    row: buildPlaceRow(place),
    above: readAncestorRows(place.ref, context.inbox),
  };
  context.headByRef.set(place.ref, head);
  return head;
};

/** Returns the places above `card` of the kind its record names as `home`. */
export const listHomes = (card: InboxCard, context: PlaceContext): EntityPlace[] => {
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
  for (const ref of context.parentsOf.get(card.ref) ?? []) {
    const place = context.placeByRef.get(ref);
    if (place === undefined || ref === surfaceId) continue;
    if (place.kind !== card.home && place.kind !== card.section) continue;
    const row = buildPlaceRow(place);
    if (!row.isLocked) near.push(row);
  }
  return near;
};

/**
 * Decides where `card` lies. A rich card lies on the surface of each of its
 * homes, the first in full and the others as a plain pointer, so it is counted
 * once. With no home it lies on a surface named for its plugin. A compact card
 * lies in Requests, under its home's name. `grouping` is what the page is
 * grouped by: `HOME_GROUPING` (the default), `STATUS_GROUPING`, or the word of a
 * kind of place.
 */
export const decideInboxPlace = (
  card: InboxCard,
  inbox: Inbox,
  grouping: string = HOME_GROUPING,
): InboxPlace => {
  const context = buildPlaceContext(inbox);
  return card.card === "compact"
    ? { _tag: "request", homeName: findHomeName(card, context) }
    : { _tag: "surfaces", heads: findSurfaceHeads(card, context, grouping) };
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
