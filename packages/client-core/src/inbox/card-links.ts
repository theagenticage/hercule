/**
 * Linking two things from the Inbox, and taking a link back. The user's own
 * Link and Unlink show on the page before the controller answers. Each is two
 * things: an edit to the Inbox the screen holds (`SetLinkEdit`), which changes
 * the pair's link and nothing else, and, when a card can ride on one end, a
 * `RidingMove`, which the visit holds until the controller answers
 * (`startRidingMove`). `planLink` and `planUnlink` work out both; an Unlink
 * reads where the card is drawn from the placement the visit holds. Undo is a Link or
 * Unlink in the other direction, planned when Undo is pressed, so it never
 * replays a plan made earlier.
 */
import type { EntityLink, EntityUnlinkResult, Inbox, InboxCard } from "@hercule/contract";
import { isLinkBetween, nameLinkedThing } from "../desk/link-ends";
import type { LinkClaim } from "./card-bundles";
import { readRidesOn, type RidingMove, type VisitPlacement } from "./visit-placement";

/**
 * The pair `fromRef` and `toRef` is joined by `claim` after this edit, or by
 * nothing when `claim` is `undefined`. `hasPersonClaim` says whether the user
 * has a claim on the pair too, which `claim` (the firmest) does not show when
 * a source reports the pair as well.
 */
export interface SetLinkEdit {
  readonly kind: "set-link";
  readonly fromRef: string;
  readonly toRef: string;
  readonly claim: LinkClaim | undefined;
  readonly hasPersonClaim: boolean;
}

/** What a Link or Unlink does to the page: the edit, and what it does to the card that rides. */
export interface LinkPlan {
  readonly edit: SetLinkEdit;
  /** What the move does to the card that can ride on the other end, when one end is such a card. */
  readonly ridingMove?: RidingMove;
}

/** A link a person made: the user's own claim. */
const PERSON_CLAIM: LinkClaim = { type: "person", actor: "user" };

/** Returns the link between two things, whichever way it points, or `undefined`. */
const findLink = (inbox: Inbox, fromRef: string, toRef: string): EntityLink | undefined =>
  inbox.links.find((link) => isLinkBetween(link, fromRef, toRef));

/**
 * Returns the card that can ride on a lead if these two things are linked,
 * and that lead, or `undefined`. A request joins a card of lasting work that
 * waits on the Inbox. Two cards of lasting work never ride. The card may
 * ride on another lead already, which `readRidesOn` tells.
 */
const findRiderAndLead = (
  inbox: Inbox,
  fromRef: string,
  toRef: string,
): { readonly card: InboxCard; readonly lead: InboxCard } | undefined => {
  const ends = [fromRef, toRef].map((ref) => inbox.cards.find((card) => card.ref === ref));
  const card = ends.find((end) => end?.card === "compact");
  const lead = ends.find((end) => end?.card === "rich" && end.side === "ongoing");
  return card === undefined || lead === undefined ? undefined : { card, lead };
};

/**
 * Returns the edit that links `fromRef` and `toRef`, and the move that puts a
 * request on the card of lasting work it is linked to. A pair a source already
 * reports keeps that claim, which is firmer than a person's: linking it again
 * changes nothing on the page but the user's own claim. A pair held by a
 * reference found in text becomes the user's. The move is planned also for a
 * request that rides on a lead already, because that move may be refused: the
 * visit plays it on the place it holds, and a request that rides on a lead
 * keeps it (`readRidesOn`).
 */
export const planLink = (inbox: Inbox, fromRef: string, toRef: string): LinkPlan => {
  const existing = findLink(inbox, fromRef, toRef);
  const claim = existing?.claim.type === "source" ? existing.claim : PERSON_CLAIM;
  const rides = findRiderAndLead(inbox, fromRef, toRef);
  return {
    edit: { kind: "set-link", fromRef, toRef, claim, hasPersonClaim: true },
    ...(rides === undefined
      ? {}
      : {
          ridingMove: {
            direction: "link",
            cardId: rides.card.id,
            leadRef: rides.lead.ref,
          },
        }),
  };
};

/**
 * Returns the edit that takes back the user's own claim on the link between
 * `fromRef` and `toRef`, or `undefined` when the user made no claim on it.
 * `placement` is the place the visit holds. What stays depends on the firmest
 * claim:
 *
 * - If it is the user's, the pair is left with no link on the page. The edit
 *   assumes that nothing else joins the pair; the next read shows a hint that
 *   is left. A card that is drawn riding on the other end is set free (the
 *   move).
 * - If it is a source's, the pair stays joined by that claim, and nothing
 *   rides differently.
 */
export const planUnlink = (
  inbox: Inbox,
  fromRef: string,
  toRef: string,
  placement: VisitPlacement,
): LinkPlan | undefined => {
  const link = findLink(inbox, fromRef, toRef);
  if (link === undefined || !link.hasPersonClaim) return undefined;
  const staysLinked = link.claim.type === "source";
  const edit: SetLinkEdit = {
    kind: "set-link",
    fromRef: link.fromRef,
    toRef: link.toRef,
    claim: staysLinked ? link.claim : undefined,
    hasPersonClaim: false,
  };
  if (staysLinked) return { edit };
  for (const card of inbox.cards) {
    const leadRef = readRidesOn(placement, card);
    if (
      leadRef !== undefined &&
      isLinkBetween({ fromRef: card.ref, toRef: leadRef }, fromRef, toRef)
    ) {
      return { edit, ridingMove: { direction: "unlink", cardId: card.id, leadRef } };
    }
  }
  return { edit };
};

/**
 * Returns the sentence that says what still joins a pair after the user's
 * link was removed, as the controller's answer says (`remaining`): a claim of
 * a source, or a reference found in text. Returns `undefined` when nothing
 * does. The user's own claim is what a removal takes, so `person` is never
 * left and reads like nothing.
 */
export const describeLinkRemaining = (
  remaining: EntityUnlinkResult["remaining"],
): string | undefined => {
  switch (remaining) {
    case "source":
      return "The source still reports the link.";
    case "text":
      return "A reference in text still mentions it.";
    case "person":
    case undefined:
      return undefined;
  }
};

/** Returns the sentence for a removed link, with what still joins the pair (`describeLinkRemaining`). */
export const describeLinkRemoved = (remaining: EntityUnlinkResult["remaining"]): string => {
  const rest = describeLinkRemaining(remaining);
  return rest === undefined ? "Link removed." : `Link removed. ${rest}`;
};

/**
 * Returns `inbox` with `edit` made: the pair's link replaced, added or removed.
 * A pair that gets a link is no longer a hint. A removed link leaves no hint
 * behind: the next read shows one if text still mentions the pair. What rides
 * on what is not part of an edit: the visit holds it.
 */
export const applySetLink = (inbox: Inbox, edit: SetLinkEdit): Inbox => {
  const isPair = (pair: Pick<EntityLink, "fromRef" | "toRef">): boolean =>
    isLinkBetween(pair, edit.fromRef, edit.toRef);
  const known = inbox.links.find(isPair);
  const { claim, hasPersonClaim } = edit;
  const links =
    claim === undefined
      ? inbox.links.filter((link) => !isPair(link))
      : known === undefined
        ? [...inbox.links, { fromRef: edit.fromRef, toRef: edit.toRef, claim, hasPersonClaim }]
        : inbox.links.map((link) => (link === known ? { ...link, claim, hasPersonClaim } : link));
  const hints = claim === undefined ? inbox.hints : inbox.hints.filter((hint) => !isPair(hint));
  return { ...inbox, links, hints };
};

/** Returns how a move names the thing at `ref`: its identifier, else its title, else its noun. */
export const nameLinkEnd = (inbox: Inbox, ref: string): string => {
  const thing =
    inbox.cards.find((each) => each.ref === ref) ?? inbox.peers.find((each) => each.ref === ref);
  return thing === undefined ? ref : nameLinkedThing(thing);
};
