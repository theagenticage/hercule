/**
 * What the open card of the Inbox shows for a place: what it says about itself,
 * what is above it, the places inside it that hold cards on this page, and the
 * cards that lie under it. It is worked out from the Inbox read alone, so
 * walking to a place needs no new read.
 */
import type { Inbox, InboxCard } from "@hercule/contract";
import {
  buildPlaceRow,
  readAncestorRows,
  type AncestorRow,
  type PlaceRow,
} from "../desk/relation-rows";

/** A place inside the open place, with the cards that lie under it. */
export interface InnerPlace {
  readonly row: PlaceRow;
  readonly cards: readonly InboxCard[];
}

/** What the open card draws for a place. */
export interface PlaceView {
  /** The place itself. */
  readonly row: PlaceRow;
  /** Every place above it, on every path, each once, nearest first. */
  readonly above: readonly AncestorRow[];
  /** The places directly inside it that hold cards, in the order the Inbox lists places. */
  readonly inner: readonly InnerPlace[];
  /** The cards under it that lie under none of its inner places. */
  readonly cards: readonly InboxCard[];
}

/**
 * Returns the view of the place `ref`, or `undefined` when the Inbox read
 * holds no record for it. A card under two inner places is listed under both,
 * and one under none of them is in `cards`.
 */
export const readPlaceView = (ref: string, inbox: Inbox): PlaceView | undefined => {
  const place = inbox.places.find((each) => each.ref === ref);
  if (place === undefined) return undefined;
  const innerRefs = new Set(
    inbox.edges.filter((edge) => edge.toRef === ref).map((edge) => edge.fromRef),
  );
  const underPlace = inbox.cards.filter((card) => card.ancestors.includes(ref));
  const inner = inbox.places
    .filter((each) => innerRefs.has(each.ref))
    .map((each) => ({
      row: buildPlaceRow(each),
      cards: underPlace.filter((card) => card.ancestors.includes(each.ref)),
    }));
  const inInner = new Set(inner.flatMap((each) => each.cards.map((card) => card.id)));
  return {
    row: buildPlaceRow(place),
    above: readAncestorRows(ref, inbox),
    inner,
    cards: underPlace.filter((card) => !inInner.has(card.id)),
  };
};
