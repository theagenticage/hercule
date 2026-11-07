/**
 * What rides on a card of the Inbox and what is said under it. A lead (a card
 * of lasting work) carries the small things that ride on it as parts, set in
 * under its title, and quiet lines for what it is linked to and does not carry.
 * Every card can carry hint lines: a reference found in text, which joins
 * nothing until the user links the two.
 *
 * Which card rides on which is decided by the controller (`InboxCard.ridesOn`).
 * The visit holds that for its length (`HeldCard.ridesOn`, and the user's own
 * Links and Unlinks that wait for an answer), so a read never moves a card the
 * user has seen; `decideDrawnRiding` turns what is held into what the page
 * draws. A bundle built again keeps the identity of the one it equals, so a
 * row that draws the same is not drawn again. Nothing here knows a kind by
 * name.
 */
import type { EntityHint, EntityLink, EntityPeer, InboxCard } from "@hercule/contract";
import { replaceEqualDeep } from "@tanstack/query-core";
import { readEntityPluginId } from "../desk/entity-words";
import { isLinkBetween, nameLinkedThing, readOtherRef } from "../desk/link-ends";
import { findHomeName, type PlaceContext } from "./inbox-place";
import { readRidesOn, type VisitPlacement } from "./visit-placement";

/** Who says two things are linked: the firmest claim of the pair. */
export type LinkClaim = EntityLink["claim"];

/**
 * A card that rides on its lead and asks something of the user, such as a pull
 * request on its ticket. It is a card of its own, with its own moves, and the
 * page draws it under the lead. `homeName` is the title of its first home, which
 * follows its identifier.
 */
export interface AskingPart {
  readonly _tag: "asking";
  readonly card: InboxCard;
  readonly homeName: string | undefined;
  /** What the link between it and the lead says. `undefined` when the read holds no such link. */
  readonly claim: LinkClaim | undefined;
}

/**
 * A line for something that is linked to the lead and asks nothing of the user
 * here: a card that rides on another lead, a second lasting thing, a card a Task
 * holds, or a thing that has no card of its own (a peer).
 */
export interface QuietPart {
  readonly _tag: "quiet";
  readonly ref: string;
  /** The id of its card, when it has one on the Inbox. */
  readonly cardId: string | undefined;
  /** The id a click opens: its card's, or its record's. `undefined` when there is nothing to open. */
  readonly openId: string | undefined;
  readonly pluginId: string;
  readonly noun: string;
  readonly title: string;
  /** The status word, or "You took it on" for a card a Task holds. */
  readonly statusWords: string | undefined;
  /** What the link between it and the lead says. `undefined` for a rider whose link the read does not hold. */
  readonly claim: LinkClaim | undefined;
}

/** A line for a linked thing the user cannot read: its noun, never its title. */
export interface LockedPart {
  readonly _tag: "locked";
  readonly ref: string;
  /** The qualified kind word, such as `sentry/issue`. */
  readonly kind: string;
  readonly pluginId: string;
  readonly noun: string;
  readonly claim: LinkClaim;
}

export type TuckedPart = AskingPart | QuietPart | LockedPart;

/**
 * A reference found in the text of one of two things, which joins nothing
 * until the user links them: "Mentions OPS-47" under the thing whose text holds
 * the reference, "Mentioned in #6263" under the thing it points at.
 */
export interface MentionHint {
  readonly _tag: "mention";
  readonly word: "Mentions" | "Mentioned in";
  /** How the other end is named in the line: its identifier. */
  readonly reference: string;
  /** The ref of the thing at the other end of the link from the card the line lies under. */
  readonly otherRef: string;
  /** The end whose text holds the reference. */
  readonly fromRef: string;
  readonly toRef: string;
  /** Which text holds the reference, such as "description", when the read says. */
  readonly evidenceKey: string | undefined;
}

/** A line under a request that says what it is linked to: "Linked to #6263". */
export interface PeerLine {
  readonly _tag: "peer";
  readonly reference: string;
  readonly otherRef: string;
  /** The id a click opens, or `undefined` when the other end cannot be opened. */
  readonly openId: string | undefined;
  readonly claim: LinkClaim;
}

export type TuckedLine = MentionHint | PeerLine;

/** What a card carries: its parts, the lines under them, and the cards that ride on it. */
export interface CardBundle {
  readonly parts: readonly TuckedPart[];
  readonly lines: readonly TuckedLine[];
  /** The cards drawn riding on this one, whether they ask or a Task holds them. Dismissing the lead sets each free. */
  readonly riders: readonly InboxCard[];
}

/** A card that carries nothing. One value, so a card whose bundle is empty compares equal by identity. */
export const EMPTY_BUNDLE: CardBundle = { parts: [], lines: [], riders: [] };

/**
 * Returns the lead each riding card is drawn under, as its ref, by card id.
 * A card rides when the visit holds it on the Requests side with a lead (the
 * place `readRidesOn` gives, with the user's unanswered moves played), and
 * that lead is a card the visit holds on the wide side. A lead that is gone
 * (dismissed, or a card that has since got a Task) lets what rode on it stand
 * alone, and rides again when it comes back.
 */
export const decideDrawnRiding = (
  cards: readonly InboxCard[],
  placement: VisitPlacement,
): ReadonlyMap<string, string> => {
  const leads = new Set(
    cards
      .filter((card) => (placement.cards.get(card.id)?.side ?? card.side) === "ongoing")
      .map((card) => card.ref),
  );
  const riding = new Map<string, string>();
  for (const card of cards) {
    const held = placement.cards.get(card.id);
    if (held === undefined || held.side !== "requests") continue;
    const ridesOn = readRidesOn(placement, card);
    if (ridesOn !== undefined && leads.has(ridesOn)) riding.set(card.id, ridesOn);
  }
  return riding;
};

/** What `buildCardBundle` reads, indexed once for every card of a read. Build it with `indexBundleSources`. */
export interface BundleSources {
  readonly cardByRef: ReadonlyMap<string, InboxCard>;
  readonly peerByRef: ReadonlyMap<string, EntityPeer>;
  /** Every link by each of its two ends. */
  readonly linksByRef: ReadonlyMap<string, readonly EntityLink[]>;
  /** Every hint by each of its two ends. */
  readonly hintsByRef: ReadonlyMap<string, readonly EntityHint[]>;
  /** The riding cards of each lead, by the lead's ref, in the order of the visit. */
  readonly ridersByLead: ReadonlyMap<string, readonly InboxCard[]>;
  /** The bundles of the layout before this one, by card id. A bundle that comes out equal keeps its identity. */
  readonly previousBundles: Readonly<Record<string, CardBundle>>;
  readonly context: PlaceContext;
}

/** Returns `pairs` by each of their two ends, so a pair is found from either thing. */
const indexByEnds = <Pair extends { readonly fromRef: string; readonly toRef: string }>(
  pairs: readonly Pair[],
): ReadonlyMap<string, readonly Pair[]> => {
  const byRef = new Map<string, Pair[]>();
  for (const pair of pairs) {
    for (const ref of [pair.fromRef, pair.toRef]) {
      const known = byRef.get(ref);
      if (known === undefined) byRef.set(ref, [pair]);
      else known.push(pair);
    }
  }
  return byRef;
};

/**
 * Returns the lookups `buildCardBundle` reads. `riding` is `decideDrawnRiding`'s
 * answer and `readRank` gives each card's place in the order of the visit, which
 * orders the cards that ride on one lead. `previousBundles` are the bundles
 * the layout before this read drew, by card id.
 */
export const indexBundleSources = (
  inbox: {
    readonly cards: readonly InboxCard[];
    readonly links: readonly EntityLink[];
    readonly hints: readonly EntityHint[];
    readonly peers: readonly EntityPeer[];
  },
  riding: ReadonlyMap<string, string>,
  readRank: (cardId: string) => number,
  context: PlaceContext,
  previousBundles: Readonly<Record<string, CardBundle>>,
): BundleSources => {
  const ridersByLead = new Map<string, InboxCard[]>();
  for (const card of inbox.cards) {
    const lead = riding.get(card.id);
    if (lead === undefined) continue;
    const known = ridersByLead.get(lead);
    if (known === undefined) ridersByLead.set(lead, [card]);
    else known.push(card);
  }
  for (const riders of ridersByLead.values())
    riders.sort((a, b) => readRank(a.id) - readRank(b.id));
  return {
    cardByRef: new Map(inbox.cards.map((card) => [card.ref, card])),
    peerByRef: new Map(inbox.peers.map((peer) => [peer.ref, peer])),
    linksByRef: indexByEnds(inbox.links),
    hintsByRef: indexByEnds(inbox.hints),
    ridersByLead,
    previousBundles,
    context,
  };
};

/** Compares two strings the way the page orders names. */
const compareNames = (a: string, b: string): number => a.localeCompare(b, "en");

/** The words a card a Task holds says in place of its status. */
const TAKEN_WORDS = "You took it on";

const buildQuietPartOfCard = (card: InboxCard, claim: LinkClaim | undefined): QuietPart => ({
  _tag: "quiet",
  ref: card.ref,
  cardId: card.id,
  openId: card.id,
  pluginId: readEntityPluginId(card.kind),
  noun: card.noun,
  title: card.title,
  statusWords: card.taskId === undefined ? card.status?.label : TAKEN_WORDS,
  claim,
});

const buildQuietPartOfPeer = (peer: EntityPeer, claim: LinkClaim): QuietPart => ({
  _tag: "quiet",
  ref: peer.ref,
  cardId: undefined,
  openId: peer.id,
  pluginId: readEntityPluginId(peer.kind),
  noun: peer.noun,
  title: peer.title ?? peer.noun,
  statusWords: peer.status?.label,
  claim,
});

/** Returns the part for a confirmed link from the lead to `otherRef`, or `undefined` when the read holds nothing at that end. */
const buildPartOfLink = (
  sources: BundleSources,
  otherRef: string,
  claim: LinkClaim,
): QuietPart | LockedPart | undefined => {
  const card = sources.cardByRef.get(otherRef);
  if (card !== undefined) return buildQuietPartOfCard(card, claim);
  const peer = sources.peerByRef.get(otherRef);
  if (peer === undefined) return undefined;
  if (peer.restricted) {
    return {
      _tag: "locked",
      ref: peer.ref,
      kind: peer.kind,
      pluginId: readEntityPluginId(peer.kind),
      noun: peer.noun,
      claim,
    };
  }
  return buildQuietPartOfPeer(peer, claim);
};

/** Returns the line's words, which orders the lines under a card. */
const describeLine = (line: TuckedLine): string =>
  line._tag === "mention" ? `${line.word} ${line.reference}` : `Linked to ${line.reference}`;

/**
 * Returns what `lead` carries.
 *
 * - The cards drawn riding on it come first, in the order of the visit. One
 *   that asks (no Task holds it) is an `asking` part with its own moves; one a
 *   Task holds is a quiet part that says "You took it on".
 * - On a card of lasting work, every other direct link (a `source` or `person`
 *   claim) is a quiet part: a card that rides elsewhere, a second lasting thing
 *   or a peer with no card. One the user cannot read is a locked part. Quiet
 *   parts come by title, locked ones last.
 * - On a request, a direct link is a line "Linked to ...", unless the thing is
 *   one the user cannot read, which a request does not name.
 * - A hint (`Inbox.hints`) is a line on either card: "Mentions ..." under the
 *   card whose text holds the reference, "Mentioned in ..." under the one it
 *   points at. A hint never makes a part and never changes what rides.
 * - A link whose other end the read does not hold draws nothing.
 *
 * Returns `EMPTY_BUNDLE` itself for a card that carries nothing. Returns the
 * bundle `sources.previousBundles` holds for `lead` itself when the new one
 * equals it, and shares every part and line that did not change with it.
 */
export const buildCardBundle = (lead: InboxCard, sources: BundleSources): CardBundle => {
  const riders = sources.ridersByLead.get(lead.ref) ?? [];
  const links = sources.linksByRef.get(lead.ref) ?? [];
  const hints = sources.hintsByRef.get(lead.ref) ?? [];
  if (riders.length === 0 && links.length === 0 && hints.length === 0) return EMPTY_BUNDLE;
  const findClaimToward = (otherRef: string): LinkClaim | undefined =>
    links.find((link) => isLinkBetween(link, lead.ref, otherRef))?.claim;

  const asking: AskingPart[] = [];
  const quiet: QuietPart[] = [];
  const locked: LockedPart[] = [];
  const lines: TuckedLine[] = [];
  const seen = new Set<string>();

  for (const card of riders) {
    seen.add(card.ref);
    const claim = findClaimToward(card.ref);
    if (card.taskId === undefined) {
      asking.push({
        _tag: "asking",
        card,
        homeName: findHomeName(card, sources.context),
        claim,
      });
    } else {
      quiet.push(buildQuietPartOfCard(card, claim));
    }
  }

  for (const hint of hints) {
    const otherRef = readOtherRef(hint, lead.ref);
    if (seen.has(otherRef)) continue;
    seen.add(otherRef);
    const card = sources.cardByRef.get(otherRef);
    const peer = sources.peerByRef.get(otherRef);
    const farEnd = card ?? peer;
    if (peer?.restricted === true || farEnd === undefined) continue;
    lines.push({
      _tag: "mention",
      word: hint.fromRef === lead.ref ? "Mentions" : "Mentioned in",
      reference: nameLinkedThing(farEnd),
      otherRef,
      fromRef: hint.fromRef,
      toRef: hint.toRef,
      evidenceKey: hint.evidenceKey,
    });
  }

  for (const link of links) {
    const otherRef = readOtherRef(link, lead.ref);
    if (seen.has(otherRef)) continue;
    seen.add(otherRef);
    if (lead.card === "compact") {
      const card = sources.cardByRef.get(otherRef);
      const peer = sources.peerByRef.get(otherRef);
      const farEnd = card ?? peer;
      if (peer?.restricted === true || farEnd === undefined) continue;
      lines.push({
        _tag: "peer",
        reference: nameLinkedThing(farEnd),
        otherRef,
        openId: card?.id ?? peer?.id,
        claim: link.claim,
      });
    } else {
      const part = buildPartOfLink(sources, otherRef, link.claim);
      if (part?._tag === "locked") locked.push(part);
      else if (part !== undefined) quiet.push(part);
    }
  }

  quiet.sort((a, b) => compareNames(a.title, b.title) || compareNames(a.ref, b.ref));
  locked.sort((a, b) => compareNames(a.noun, b.noun) || compareNames(a.ref, b.ref));
  lines.sort((a, b) => compareNames(describeLine(a), describeLine(b)));
  if (asking.length + quiet.length + locked.length + lines.length === 0) return EMPTY_BUNDLE;
  const built: CardBundle = { parts: [...asking, ...quiet, ...locked], lines, riders };
  const previous = sources.previousBundles[lead.id];
  return previous === undefined ? built : replaceEqualDeep(previous, built);
};

/**
 * Returns the ids of the cards a row draws: `card` first, then the card of
 * each part of `bundle` that has one (an asking part, or a quiet part of a
 * card on the Inbox). A peer or a locked part has no card and adds nothing.
 */
export const listBundleCardIds = (card: InboxCard, bundle: CardBundle): readonly string[] => [
  card.id,
  ...bundle.parts.flatMap((part) => {
    if (part._tag === "asking") return [part.card.id];
    return part._tag === "quiet" && part.cardId !== undefined ? [part.cardId] : [];
  }),
];
