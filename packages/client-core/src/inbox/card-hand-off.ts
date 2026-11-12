/**
 * What handing a card to a workflow says and draws: the offers a card has, what
 * a click on one would end, what the card looks like once it is handed, and
 * the undo line after a hand-off is taken back.
 *
 * The colleague who has a card is a fact the controller reports on the card
 * (`InboxThing.liveWorkflows`), so a card drawn after leaving the Inbox and
 * coming back still shows who has it.
 */
import type {
  ActingConnection,
  EntitySignalLine,
  ExternalEntityDetail,
  HandOffUndo,
  InboxAsk,
  InboxPage,
  InboxThing,
  LiveWorkflow,
  WorkflowOffer,
} from "@hercule/contract";
import { nameSignalKind } from "../intake";
import { formatNameList } from "../name-list";
import { endSentence } from "../text";

/** The workflows a card can be handed to, and the ones it could be if something changed. */
export interface CardOffers {
  /** In the order the controller gave them. */
  readonly available: readonly WorkflowOffer[];
  /** Each says why in `unavailable.message`. */
  readonly unavailable: readonly WorkflowOffer[];
}

/** A card with no offers. */
export const NO_OFFERS: CardOffers = { available: [], unavailable: [] };

/** Returns `offers` split into the ones that can take the card now and the ones that cannot. */
export const partitionOffers = (offers: readonly WorkflowOffer[]): CardOffers => ({
  available: offers.filter((offer) => offer.unavailable === undefined),
  unavailable: offers.filter((offer) => offer.unavailable !== undefined),
});

/** The split of each offer set already made, so one set is split once and every card of it shares the result. */
const partitionedSets = new WeakMap<readonly WorkflowOffer[], CardOffers>();

/**
 * Returns the offers of `card`, read from the set the Inbox holds under its
 * `offerSetId`. A card whose set is missing has no offers.
 *
 * The same set always gives the same `CardOffers` object, so a card that
 * compares its offers by identity draws again only when its own set changed.
 */
export const listCardOffers = (
  card: Pick<InboxThing, "offerSetId">,
  offerSets: Readonly<Record<string, readonly WorkflowOffer[]>>,
): CardOffers => {
  const set = offerSets[card.offerSetId];
  if (set === undefined) return NO_OFFERS;
  let offers = partitionedSets.get(set);
  if (offers === undefined) {
    offers = partitionOffers(set);
    partitionedSets.set(set, offers);
  }
  return offers;
};

/**
 * The Hand to move of a card on hover:
 *
 * - `none`: no workflow can take the card now.
 * - `one`: a click hands the card to that workflow at once, and the move is
 *   named after it.
 * - `several`: the move is named "Hand to…" and a click opens the menu.
 */
export type HandMove =
  | { readonly kind: "none" }
  | { readonly kind: "one"; readonly offer: WorkflowOffer }
  | { readonly kind: "several" };

/** Returns the Hand to move of a card with these offers. Offers that cannot take the card do not count. */
export const decideHandMove = ({ available }: CardOffers): HandMove => {
  const [first] = available;
  if (first === undefined) return { kind: "none" };
  return available.length === 1 ? { kind: "one", offer: first } : { kind: "several" };
};

const listKindLabels = (kinds: readonly string[]): string =>
  formatNameList(kinds.map(nameSignalKind), "and");

/**
 * Returns the line under an offer in the menu, which says what a click ends
 * and what it leaves: "Ends Review requested. Mentioned stays open."
 *
 * `openKinds` are the kinds of the signals the card holds open, snoozed ones
 * included (`card.signals.kinds`, or the kinds of the open card's open signals).
 */
export const describeHandOffEnds = (
  offer: Pick<WorkflowOffer, "answers">,
  openKinds: readonly string[],
): string => {
  const ended = [...new Set(openKinds.filter((kind) => offer.answers.includes(kind)))];
  const left = [...new Set(openKinds.filter((kind) => !offer.answers.includes(kind)))];
  const ends = ended.length === 0 ? "Ends nothing." : `Ends ${listKindLabels(ended)}.`;
  return left.length === 0
    ? ends
    : `${ends} ${listKindLabels(left)} ${left.length === 1 ? "stays" : "stay"} open.`;
};

/**
 * Returns the distinct kinds of the open signals among `lines`, snoozed ones
 * included, in the order they first appear. These are the `openKinds` of
 * `describeHandOffEnds` for an open card, which reads its signals as lines
 * (`ExternalEntityDetail.signals`) where a card in the list has them as
 * `signals.kinds`.
 */
export const listOpenSignalKinds = (
  lines: readonly Pick<EntitySignalLine, "kind" | "status">[],
): readonly string[] => [
  ...new Set(lines.filter((line) => line.status === "open").map((line) => line.kind)),
];

/**
 * Returns the sentence a handed card draws: "Agent review has it", in a plain
 * tone. The card's colleague names itself with the same words.
 */
export const decideHandedSentence = (
  workflow: LiveWorkflow,
): { readonly text: string; readonly tone: "plain" } => ({
  text: `${workflow.name} has it`,
  tone: "plain",
});

/** Who stands where a card's wait was: the workflow working on it, or the user, who holds its Task. */
export type CardHolder =
  | { readonly kind: "colleague"; readonly workflow: LiveWorkflow }
  | { readonly kind: "you" };

/**
 * Returns who holds `card`: the first of its live workflows, which is the one
 * with the newest run, else the user when a Task holds it, else nobody.
 */
export const decideCardHolder = (
  card: Pick<InboxThing, "taskId" | "liveWorkflows">,
): CardHolder | undefined => {
  const [workflow] = card.liveWorkflows;
  if (workflow !== undefined) return { kind: "colleague", workflow };
  return card.taskId === undefined ? undefined : { kind: "you" };
};

/**
 * What the open card can be handed to and what a hand-off would end: the
 * offers, the accounts it could act as, and the kinds of its open signals.
 */
export interface OpenCardHandOff {
  readonly offers: CardOffers;
  readonly actingConnections: readonly ActingConnection[];
  readonly openKinds: readonly string[];
}

/**
 * Returns the hand-off facts of an open card. The read of the card
 * (`detail`) is the source once it has answered. Until then they come from
 * the card as the Inbox lists it (`listed`), and from the Inbox's offer sets.
 * A card whose kind is not available, or an Inbox that has not answered, has
 * no offers.
 */
export const readOpenCardHandOff = (
  detail:
    | Pick<ExternalEntityDetail, "kindAvailable" | "offers" | "actingConnections" | "signals">
    | undefined,
  listed: Pick<InboxThing, "offerSetId" | "actingConnections" | "openKinds"> | undefined,
  inbox: Pick<InboxPage, "offerSets"> | undefined,
): OpenCardHandOff => {
  const readOffers = (): CardOffers => {
    if (inbox === undefined || detail?.kindAvailable === false) return NO_OFFERS;
    if (detail !== undefined) return partitionOffers(detail.offers);
    return listed === undefined ? NO_OFFERS : listCardOffers(listed, inbox.offerSets);
  };
  return {
    offers: readOffers(),
    actingConnections: detail?.actingConnections ?? listed?.actingConnections ?? [],
    openKinds:
      detail === undefined ? (listed?.openKinds ?? []) : listOpenSignalKinds(detail.signals),
  };
};

/**
 * Returns the undo line after a hand-off is taken back, and never says more
 * than happened:
 *
 * - `undone`: "Took back Review PR. Nothing had started."
 * - `stopped`: "Asked Review PR to stop. Anything it already did stays." and
 *   the controller's reason, when it gave one. It never says the run stopped,
 *   because only the run's own report can.
 * - `too-late`: "Review PR already finished."
 *
 * `endedKinds` are the signal kinds the hand-off ended. They stay ended in
 * every case, and the line says so. A restored failure is named too.
 */
export const describeHandOffUndo = (
  undo: HandOffUndo,
  workflowName: string,
  endedKinds: readonly string[],
): string => {
  const lines: string[] = [];
  switch (undo.outcome) {
    case "undone":
      lines.push(`Took back ${workflowName}. Nothing had started.`);
      break;
    case "stopped":
      lines.push(`Asked ${workflowName} to stop. Anything it already did stays.`);
      if (undo.reason !== undefined) lines.push(endSentence(undo.reason));
      break;
    case "too-late":
      lines.push(`${workflowName} already finished.`);
      break;
  }
  if (undo.failureRestored) lines.push("The earlier failure is back.");
  const ended = [...new Set(endedKinds)];
  if (ended.length > 0) {
    lines.push(`${listKindLabels(ended)} ${ended.length === 1 ? "stays" : "stay"} ended.`);
  }
  return lines.join(" ");
};

/**
 * Checks whether the card plays backwards after an undo: only when the
 * hand-off was fully taken back. A stopped run or a finished one leaves the
 * card as it is, because showing a reversal that did not happen would be a lie.
 */
export const isHandOffTakenBack = (undo: HandOffUndo): boolean => undo.outcome === "undone";

/** How well a workflow's hand-off fits the open asks of a thing: it ends all of them, some, or none. */
export type HandOffFit = "all" | "some" | "none";

/**
 * Returns how many of the thing's open ask kinds `offer` ends. A thing with no
 * asks has nothing to end, so every offer fits it equally ("all").
 */
export const decideHandOffFit = (
  offer: Pick<WorkflowOffer, "answers">,
  askKinds: readonly string[],
): HandOffFit => {
  const ended = askKinds.filter((kind) => offer.answers.includes(kind)).length;
  if (ended === askKinds.length) return "all";
  return ended === 0 ? "none" : "some";
};

const FIT_RANK: Readonly<Record<HandOffFit, number>> = { all: 0, some: 1, none: 2 };

/**
 * Returns `offers` best fit first, as a new list. The order is:
 *
 * 1. the offers that end every open ask, then those that end some, then none;
 * 2. among equals, the one the user handed a thing of this kind to most recently;
 * 3. then by name.
 */
export const rankHandOffs = (
  offers: readonly WorkflowOffer[],
  askKinds: readonly string[],
): readonly WorkflowOffer[] => {
  const readHandedAt = (offer: WorkflowOffer): number =>
    offer.lastHandedAt === undefined ? -Infinity : Date.parse(offer.lastHandedAt);
  return offers
    .map((offer) => ({ offer, fit: FIT_RANK[decideHandOffFit(offer, askKinds)] }))
    .toSorted(
      (a, b) =>
        a.fit - b.fit ||
        readHandedAt(b.offer) - readHandedAt(a.offer) ||
        a.offer.name.localeCompare(b.offer.name),
    )
    .map(({ offer }) => offer);
};

/** The asks of an Inbox row that a hand-off line talks about. */
export type HandOffAsks = Pick<InboxThing, "asks" | "askCount" | "askKinds" | "openKinds">;

/** Returns one ask as the line names it: "Mei’s review request", or "the failing checks" when no person raised it. */
const nameAsk = (ask: InboxAsk): string =>
  ask.asker === undefined ? `the ${ask.noun}` : `${ask.asker}’s ${ask.noun}`;

/**
 * Returns the line under a workflow in the hand-off menu, naming each ask it
 * ends and each it leaves with the user: "Ends Mei’s review request. Leaves
 * Omar’s mention with you."
 *
 * - A workflow that ends none says "Ends none of its asks."
 * - A workflow that ends every ask has no "Leaves" part.
 * - The row lists at most eight asks, and the rest are counted ("and 3 more").
 *   The kinds of all the asks say which side the uncounted ones fall on when the
 *   workflow ends every kind or none of them. With a mix, the line says that
 *   more asks are not named.
 * - A thing with no asks has no names to give, so the line is the one built from
 *   `openKinds` (`describeHandOffEnds`).
 */
export const describeHandOffAsks = (
  offer: Pick<WorkflowOffer, "answers">,
  thing: HandOffAsks,
): string => {
  if (thing.askCount === 0) return describeHandOffEnds(offer, thing.openKinds);
  const nameAll = (asks: readonly InboxAsk[], uncounted: number): string[] => [
    ...new Set(asks.map(nameAsk)),
    ...(uncounted > 0 ? [`${String(uncounted)} more`] : []),
  ];
  const uncounted = thing.askCount - thing.asks.length;
  const fit = decideHandOffFit(offer, thing.askKinds);
  const ended = nameAll(
    thing.asks.filter((ask) => offer.answers.includes(ask.kind)),
    fit === "all" ? uncounted : 0,
  );
  const left = nameAll(
    thing.asks.filter((ask) => !offer.answers.includes(ask.kind)),
    fit === "none" ? uncounted : 0,
  );
  const parts = [
    ended.length === 0 ? "Ends none of its asks." : `Ends ${formatNameList(ended, "and")}.`,
  ];
  if (left.length > 0) parts.push(`Leaves ${formatNameList(left, "and")} with you.`);
  if (fit === "some" && uncounted > 0) parts.push(`${String(uncounted)} more asks are not named.`);
  return parts.join(" ");
};

/** From this many available workflows, the hand-off menu has a field to find one by name. */
export const HAND_OFF_FIND_FROM = 6;

/** One workflow of the hand-off menu, with the line already written. */
export interface HandOffChoice {
  readonly offer: WorkflowOffer;
  /** What a hand-off would end, or why the workflow cannot take the thing. */
  readonly line: string;
}

/**
 * Returns the available workflows of `offers` best fit first, each with the
 * line that names the asks it ends and leaves (`describeHandOffAsks`).
 */
export const listAvailableHandOffs = (
  offers: CardOffers,
  thing: HandOffAsks,
): readonly HandOffChoice[] =>
  rankHandOffs(offers.available, thing.askKinds).map((offer) => ({
    offer,
    line: describeHandOffAsks(offer, thing),
  }));

/**
 * Returns the choices whose workflow name, or what the workflow does, holds
 * `query`, ignoring case and the spaces around it. An empty query returns every
 * choice.
 *
 * What a workflow does is the part of its line before "Leaves": what it ends.
 * The part after it names the asks the workflow does not touch, which every
 * other workflow names too, so matching it would match nearly everything.
 */
export const findHandOffs = (
  choices: readonly HandOffChoice[],
  query: string,
): readonly HandOffChoice[] => {
  const wanted = query.trim().toLowerCase();
  if (wanted === "") return choices;
  return choices.filter(({ offer, line }) =>
    `${offer.name} ${line.split(" Leaves ")[0] ?? ""}`.toLowerCase().includes(wanted),
  );
};
