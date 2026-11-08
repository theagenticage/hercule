/**
 * What handing a card to a workflow says and draws: the offers a card has, what
 * a click on one would end, what the card looks like once it is handed, and
 * the undo line after a hand-off is taken back.
 *
 * The screen holds a hand-off for the rest of the visit, beside the Inbox and
 * not in it: an Inbox card has no field for the colleague who has it, and the
 * Task a hand-off makes has no id until the controller answers. The reply's
 * Task id goes into the Inbox as a `set-task` edit like any other.
 */
import type {
  ActingConnection,
  EntitySignalLine,
  ExternalEntityDetail,
  HandOffUndo,
  Inbox,
  InboxCard,
  WorkflowOffer,
} from "@hercule/contract";
import { nameSignalKind } from "../intake";
import { formatNameList } from "../name-list";
import { endSentence } from "../text";
import { decideCardFace, type CardFace } from "./card-face";
import type { CardTime } from "./card-wait";

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

/**
 * Returns the offers of `card`, read from the set the Inbox holds under its
 * `offerSetId`. A card whose set is missing has no offers.
 */
export const listCardOffers = (
  card: Pick<InboxCard, "offerSetId">,
  offerSets: Readonly<Record<string, readonly WorkflowOffer[]>>,
): CardOffers => partitionOffers(offerSets[card.offerSetId] ?? []);

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

/** The colleague who has a card the user handed off: the workflow, named as the menu names it. */
export interface HandedWorkflow {
  readonly workflowId: string;
  readonly name: string;
}

/**
 * Returns the sentence a handed card draws: "Agent review has it", in a plain
 * tone. The card's colleague names itself with the same words.
 */
export const decideHandedSentence = (
  workflow: HandedWorkflow,
): { readonly text: string; readonly tone: "plain" } => ({
  text: `${workflow.name} has it`,
  tone: "plain",
});

/** Who stands where a card's wait was: the colleague the user handed it to, or the user, who holds its Task. */
export type CardHolder =
  | { readonly kind: "colleague"; readonly workflow: HandedWorkflow }
  | { readonly kind: "you" };

/** What a card of the Inbox draws: its face and time, and who holds it. */
export interface CardDraw extends CardTime {
  readonly face: CardFace;
  /** `undefined` for a card nobody holds, which draws its wait instead. */
  readonly holder: CardHolder | undefined;
}

/**
 * Returns what `card` draws, given its `time` and the colleague it was handed
 * to in this visit (`handed`, `undefined` if none).
 *
 * - A handed card has its sentence replaced by `decideHandedSentence`, and no
 *   wait and no sentence age: the colleague stands in the wait's place, and
 *   the sentence's age would be about a signal the hand-off ended. A screen
 *   reader reads the sentence through `describeCardAloud`.
 * - A card a Task holds is held by the user. A handed card is held by its
 *   colleague even when it has a Task, because a hand-off continues the Task.
 */
export const decideCardDraw = (
  card: InboxCard,
  time: CardTime,
  handed: HandedWorkflow | undefined,
): CardDraw => {
  const face = decideCardFace(card);
  if (handed === undefined) {
    return { ...time, face, holder: card.taskId === undefined ? undefined : { kind: "you" } };
  }
  return {
    ...time,
    wait: null,
    signalAge: undefined,
    face: { ...face, sentence: decideHandedSentence(handed) },
    holder: { kind: "colleague", workflow: handed },
  };
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
  listed: Pick<InboxCard, "offerSetId" | "actingConnections" | "signals"> | undefined,
  inbox: Pick<Inbox, "offerSets"> | undefined,
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
      detail === undefined ? (listed?.signals.kinds ?? []) : listOpenSignalKinds(detail.signals),
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
