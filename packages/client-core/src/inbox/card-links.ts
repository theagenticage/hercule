/**
 * Linking two things from the Inbox, and taking a link back. The user's own
 * Link and Unlink show on the page before the controller answers, so each is an
 * edit to the Inbox the screen holds (`SetLinkEdit`): it changes the pair's
 * link and, when the link makes a request ride on a ticket, what rides on what.
 * `planLink` and `planUnlink` work out the edit and the one that undoes it.
 */
import type { EntityLink, Inbox, InboxCard } from "@hercule/contract";
import type { LinkClaim } from "./card-bundles";

/**
 * The pair `fromRef` and `toRef` is joined by `claim` after this edit, or by
 * nothing when `claim` is `undefined`. `riding` puts the card `id` on the lead
 * `ridesOn`, or takes it off every lead when `ridesOn` is `undefined`.
 */
export interface SetLinkEdit {
  readonly kind: "set-link";
  readonly fromRef: string;
  readonly toRef: string;
  readonly claim: LinkClaim | undefined;
  readonly riding?: { readonly id: string; readonly ridesOn: string | undefined };
}

/** A link a person made: the user's own claim. */
const PERSON_CLAIM: LinkClaim = { type: "person", actor: "user" };

/** Returns the link between two things, whichever way it points, or `undefined`. */
const findLink = (inbox: Inbox, fromRef: string, toRef: string): EntityLink | undefined =>
  inbox.links.find(
    (link) =>
      (link.fromRef === fromRef && link.toRef === toRef) ||
      (link.fromRef === toRef && link.toRef === fromRef),
  );

/**
 * Returns the card that rides on a lead if these two things are linked, or
 * `undefined`. A request with no lead joins a card of lasting work that waits
 * on the Inbox. Anything else stays as it is: a request that rides on a lead
 * already keeps it, and two cards of lasting work never ride.
 */
const findCardThatRides = (
  inbox: Inbox,
  fromRef: string,
  toRef: string,
): { readonly card: InboxCard; readonly lead: InboxCard } | undefined => {
  const ends = [fromRef, toRef].map((ref) => inbox.cards.find((card) => card.ref === ref));
  const card = ends.find((end) => end?.card === "compact" && end.ridesOn === undefined);
  const lead = ends.find((end) => end?.card === "rich" && end.side === "ongoing");
  return card === undefined || lead === undefined ? undefined : { card, lead };
};

/**
 * Returns the edit that links `fromRef` and `toRef` and the edit that undoes
 * it. A pair a source already reports keeps that claim, which is firmer than a
 * person's: linking it again changes nothing on the page. A pair held by a
 * reference found in text becomes the user's, and the undo puts the hint back.
 */
export const planLink = (
  inbox: Inbox,
  fromRef: string,
  toRef: string,
): { readonly edit: SetLinkEdit; readonly undo: SetLinkEdit } => {
  const before = findLink(inbox, fromRef, toRef)?.claim;
  const claim = before?.type === "source" ? before : PERSON_CLAIM;
  const rides = findCardThatRides(inbox, fromRef, toRef);
  return {
    edit: {
      kind: "set-link",
      fromRef,
      toRef,
      claim,
      ...(rides === undefined ? {} : { riding: { id: rides.card.id, ridesOn: rides.lead.ref } }),
    },
    undo: {
      kind: "set-link",
      fromRef,
      toRef,
      claim: before,
      ...(rides === undefined ? {} : { riding: { id: rides.card.id, ridesOn: undefined } }),
    },
  };
};

/**
 * Returns the edit that takes back the user's link between `fromRef` and
 * `toRef` and the edit that undoes it, or `undefined` when the user made no link
 * between them: only a person's claim can be taken back. The edit assumes that
 * nothing else joins the pair; the next read shows a source's claim or a hint
 * that is left. A card that rode on the other end of the link is set free.
 */
export const planUnlink = (
  inbox: Inbox,
  fromRef: string,
  toRef: string,
): { readonly edit: SetLinkEdit; readonly undo: SetLinkEdit } | undefined => {
  const link = findLink(inbox, fromRef, toRef);
  const before = link?.claim;
  if (link === undefined || before?.type !== "person") return undefined;
  const ridden = inbox.cards.find(
    (card) =>
      (card.ref === fromRef && card.ridesOn === toRef) ||
      (card.ref === toRef && card.ridesOn === fromRef),
  );
  return {
    edit: {
      kind: "set-link",
      fromRef: link.fromRef,
      toRef: link.toRef,
      claim: undefined,
      ...(ridden === undefined ? {} : { riding: { id: ridden.id, ridesOn: undefined } }),
    },
    undo: {
      kind: "set-link",
      fromRef: link.fromRef,
      toRef: link.toRef,
      claim: before,
      ...(ridden === undefined ? {} : { riding: { id: ridden.id, ridesOn: ridden.ridesOn } }),
    },
  };
};

/**
 * Returns `inbox` with `edit` made: the pair's link replaced (or removed), and
 * the card on its lead (or off it) when the edit says so. Returns `inbox` itself
 * when nothing changes.
 */
export const applySetLink = (inbox: Inbox, edit: SetLinkEdit): Inbox => {
  const isPair = (link: EntityLink): boolean =>
    (link.fromRef === edit.fromRef && link.toRef === edit.toRef) ||
    (link.fromRef === edit.toRef && link.toRef === edit.fromRef);
  const known = inbox.links.find(isPair);
  const links =
    edit.claim === undefined
      ? inbox.links.filter((link) => !isPair(link))
      : known === undefined
        ? [...inbox.links, { fromRef: edit.fromRef, toRef: edit.toRef, claim: edit.claim }]
        : inbox.links.map((link) => (link === known ? { ...link, claim: edit.claim! } : link));
  const { riding } = edit;
  const cards =
    riding === undefined
      ? inbox.cards
      : inbox.cards.map((card) => {
          if (card.id !== riding.id) return card;
          const { ridesOn: before, ...rest } = card;
          void before;
          return riding.ridesOn === undefined ? rest : { ...rest, ridesOn: riding.ridesOn };
        });
  return { ...inbox, links, cards };
};

/** Returns how a move names the thing at `ref`: its identifier, else its title, else the ref. */
export const nameLinkEnd = (inbox: Inbox, ref: string): string => {
  const card = inbox.cards.find((each) => each.ref === ref);
  if (card !== undefined) return card.identifier;
  const peer = inbox.peers.find((each) => each.ref === ref);
  return peer?.identifier ?? peer?.title ?? ref;
};
