/**
 * What the moves on an Inbox card say and change in the Inbox the screen
 * holds: the words of each move, why one is refused, and the edits that write
 * a move into the Inbox as the screen draws it, before the next read
 * confirms it.
 */
import type { Inbox, InboxCard } from "@hercule/contract";
import { applySetLink, type SetLinkEdit } from "./card-links";

/** The moves a card offers on the Inbox. */
export type InboxMove = "take" | "dismiss" | "see-task";

/**
 * Returns why `move` does not apply to `card`, as a sentence for the undo
 * line, or `undefined` when it does.
 *
 * - Take and dismiss refuse a card that has a live Task: Take would only find
 *   that Task, and dismissing the card would hide work in progress.
 * - Seeing the Task refuses a card that has none.
 */
export const describeMoveRefusal = (card: InboxCard, move: InboxMove): string | undefined => {
  if (move === "see-task") {
    return card.taskId === undefined
      ? "It has no Task yet. Press T to take it on, and G to see the Task."
      : undefined;
  }
  return card.taskId === undefined ? undefined : "It already has a Task. Press G to see it.";
};

/** Returns what to call `card` in a sentence about a move: its noun and identifier, such as "Pull request #87". */
export const nameCard = (card: InboxCard): string => `${card.noun} ${card.identifier}`;

/**
 * Returns what the undo line says after a dismissal: "Dismissed Ticket ACME-1."
 * and, when cards rode on it, what becomes of them: "Pull request #6238 stands
 * alone now." Dismissing a lead lets what rode on it stand alone.
 */
export const describeDismissal = (card: InboxCard, riders: readonly InboxCard[]): string => {
  const first = riders[0];
  const alone =
    first === undefined
      ? ""
      : riders.length === 1
        ? ` ${nameCard(first)} stands alone now.`
        : ` ${String(riders.length)} things that rode on it stand alone now.`;
  return `Dismissed ${nameCard(card)}.${alone}`;
};

/** One change to the cards of the Inbox the screen draws. */
export type InboxEdit =
  /** The card leaves the page: the user dismissed it. */
  | { readonly kind: "drop"; readonly id: string }
  /** A card is back among the cards: the user undid a dismissal. */
  | { readonly kind: "put-back"; readonly card: InboxCard }
  /**
   * The card has this active Task, or none when `taskId` is `undefined`. The
   * card keeps its `side`: the screen holds each card's side for the visit,
   * and the next read puts a card with a Task under With someone else.
   */
  | { readonly kind: "set-task"; readonly id: string; readonly taskId: string | undefined }
  /** The user linked two things, or took the link back. See `planLink` and `planUnlink`. */
  | SetLinkEdit;

/** Returns `card` with its active Task set to `taskId`, or without one when `taskId` is `undefined`. */
const withTask = (card: InboxCard, taskId: string | undefined): InboxCard => {
  const { taskId: before, ...rest } = card;
  void before;
  return taskId === undefined ? rest : { ...rest, taskId };
};

/**
 * Returns `inbox` with `edit` made. The counts stay as the controller gave
 * them, because the next read replaces them. A card put back goes last among
 * the cards, because the page sorts them; one that is there already is left
 * as it is.
 */
export const applyInboxEdit = (inbox: Inbox, edit: InboxEdit): Inbox => {
  switch (edit.kind) {
    case "drop":
      return { ...inbox, cards: inbox.cards.filter((card) => card.id !== edit.id) };
    case "put-back":
      return inbox.cards.some((card) => card.id === edit.card.id)
        ? inbox
        : { ...inbox, cards: [...inbox.cards, edit.card] };
    case "set-task":
      return {
        ...inbox,
        cards: inbox.cards.map((card) =>
          card.id === edit.id ? withTask(card, edit.taskId) : card,
        ),
      };
    case "set-link":
      return applySetLink(inbox, edit);
  }
};

/** Returns `inbox` with each of `edits` made, the first first. Returns `inbox` itself for no edit. */
export const reapplyInboxEdits = (inbox: Inbox, edits: readonly InboxEdit[]): Inbox =>
  edits.reduce(applyInboxEdit, inbox);
