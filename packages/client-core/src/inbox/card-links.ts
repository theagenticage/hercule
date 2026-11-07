/**
 * Linking two things from the Inbox, and taking a link back. The user's own
 * Link and Unlink show on the page before the controller answers, so each is an
 * edit to the Inbox the screen holds (`SetLinkEdit`): it changes the pair's
 * link and, when the link makes a request ride on a ticket, what rides on what.
 * `planLink` and `planUnlink` work out the edit. Undo is a Link or Unlink in
 * the other direction, planned when Undo is pressed, so it never replays an
 * edit planned earlier.
 */
import type { EntityLink, EntityUnlinkResult, Inbox, InboxCard } from "@hercule/contract";
import { isLinkBetween, nameLinkedThing } from "../desk/link-ends";
import type { LinkClaim } from "./card-bundles";
import {
  chooseLead,
  NO_RIDING_CHOICES,
  readChosenLead,
  type RidingChoices,
  type RidingMove,
} from "./riding-choices";

/**
 * The pair `fromRef` and `toRef` is joined by `claim` after this edit, or by
 * nothing when `claim` is `undefined`. `hasPersonClaim` says whether the user
 * has a claim on the pair too, which `claim` (the firmest) does not show when
 * a source reports the pair as well. `riding` puts the card `id` on the lead
 * `ridesOn`, or takes it off every lead when `ridesOn` is `undefined`.
 */
export interface SetLinkEdit {
  readonly kind: "set-link";
  readonly fromRef: string;
  readonly toRef: string;
  readonly claim: LinkClaim | undefined;
  readonly hasPersonClaim: boolean;
  readonly riding?: { readonly id: string; readonly ridesOn: string | undefined };
}

/** What a Link or Unlink does to the page: the edit, and what it does to riding. */
export interface LinkPlan {
  readonly edit: SetLinkEdit;
  /** What the move does to the card that can ride on the other end, when one end is such a card. */
  readonly riding?: RidingMove;
}

/** A link a person made: the user's own claim. */
const PERSON_CLAIM: LinkClaim = { type: "person", actor: "user" };

/** Returns the link between two things, whichever way it points, or `undefined`. */
const findLink = (inbox: Inbox, fromRef: string, toRef: string): EntityLink | undefined =>
  inbox.links.find((link) => isLinkBetween(link, fromRef, toRef));

/**
 * Returns the ref of the lead `card` rides on as the visit holds it: the
 * user's choice when there is one, else what the card says (`ridesOn`), or
 * `undefined` when it stands alone. The held place is the one a Link or Unlink
 * starts from, because a read may say otherwise while a choice waits for the
 * controller's answer.
 */
const readHeldLead = (card: InboxCard, choices: RidingChoices): string | undefined => {
  const choice = choices.get(card.id);
  return choice === undefined ? card.ridesOn : readChosenLead(choice);
};

/**
 * Returns the card that can ride on a lead if these two things are linked,
 * and that lead, or `undefined`. A request joins a card of lasting work that
 * waits on the Inbox. Two cards of lasting work never ride. The card may
 * ride on another lead already, which `readHeldLead` tells.
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
 * Returns the edit that links `fromRef` and `toRef`. A pair a source already
 * reports keeps that claim, which is firmer than a person's: linking it again
 * changes nothing on the page but the user's own claim. A pair held by a
 * reference found in text becomes the user's. A request with no lead joins the
 * card of lasting work it is linked to; one that rides on a lead already keeps
 * it. `choices` is where the visit holds each card (see `readHeldLead`).
 */
export const planLink = (
  inbox: Inbox,
  fromRef: string,
  toRef: string,
  choices: RidingChoices = NO_RIDING_CHOICES,
): LinkPlan => {
  const existing = findLink(inbox, fromRef, toRef);
  const claim = existing?.claim.type === "source" ? existing.claim : PERSON_CLAIM;
  const rides = findRiderAndLead(inbox, fromRef, toRef);
  const heldLead = rides === undefined ? undefined : readHeldLead(rides.card, choices);
  return {
    edit: {
      kind: "set-link",
      fromRef,
      toRef,
      claim,
      hasPersonClaim: true,
      ...(rides === undefined || heldLead !== undefined
        ? {}
        : { riding: { id: rides.card.id, ridesOn: rides.lead.ref } }),
    },
    ...(rides === undefined
      ? {}
      : {
          riding: {
            kind: "link",
            cardId: rides.card.id,
            lead: rides.lead.ref,
            before: chooseLead(heldLead),
          },
        }),
  };
};

/**
 * Returns the edit that takes back the user's own claim on the link between
 * `fromRef` and `toRef`, or `undefined` when the user made no claim on it.
 * `choices` is where the visit holds each card (see `readHeldLead`). What
 * stays depends on the firmest claim:
 *
 * - If it is the user's, the pair is left with no link on the page. The edit
 *   assumes that nothing else joins the pair; the next read shows a hint that
 *   is left. A card that rode on the other end is set free.
 * - If it is a source's, the pair stays joined by that claim, and nothing
 *   rides differently.
 */
export const planUnlink = (
  inbox: Inbox,
  fromRef: string,
  toRef: string,
  choices: RidingChoices = NO_RIDING_CHOICES,
): LinkPlan | undefined => {
  const link = findLink(inbox, fromRef, toRef);
  if (link === undefined || !link.hasPersonClaim) return undefined;
  const staysLinked = link.claim.type === "source";
  let ridden: { readonly card: InboxCard; readonly lead: string } | undefined;
  for (const card of inbox.cards) {
    const lead = readHeldLead(card, choices);
    if (lead !== undefined && isLinkBetween({ fromRef: card.ref, toRef: lead }, fromRef, toRef)) {
      ridden = { card, lead };
      break;
    }
  }
  const freed = staysLinked ? undefined : ridden;
  return {
    edit: {
      kind: "set-link",
      fromRef: link.fromRef,
      toRef: link.toRef,
      claim: staysLinked ? link.claim : undefined,
      hasPersonClaim: false,
      ...(freed === undefined ? {} : { riding: { id: freed.card.id, ridesOn: undefined } }),
    },
    ...(freed === undefined
      ? {}
      : {
          riding: {
            kind: "unlink",
            cardId: freed.card.id,
            lead: freed.lead,
            before: chooseLead(freed.lead),
          },
        }),
  };
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
 * Returns `inbox` with `edit` made: the pair's link replaced (or removed), and
 * the card on its lead (or off it) when the edit says so. Returns `inbox` itself
 * when nothing changes.
 */
export const applySetLink = (inbox: Inbox, edit: SetLinkEdit): Inbox => {
  const isPair = (link: EntityLink): boolean => isLinkBetween(link, edit.fromRef, edit.toRef);
  const known = inbox.links.find(isPair);
  const { claim, hasPersonClaim } = edit;
  const links =
    claim === undefined
      ? inbox.links.filter((link) => !isPair(link))
      : known === undefined
        ? [...inbox.links, { fromRef: edit.fromRef, toRef: edit.toRef, claim, hasPersonClaim }]
        : inbox.links.map((link) => (link === known ? { ...link, claim, hasPersonClaim } : link));
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

/** Returns how a move names the thing at `ref`: its identifier, else its title, else its noun. */
export const nameLinkEnd = (inbox: Inbox, ref: string): string => {
  const thing =
    inbox.cards.find((each) => each.ref === ref) ?? inbox.peers.find((each) => each.ref === ref);
  return thing === undefined ? ref : nameLinkedThing(thing);
};
