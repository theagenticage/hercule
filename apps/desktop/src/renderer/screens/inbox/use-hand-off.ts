import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import {
  describeMoveRefusal,
  listCardOffers,
  NO_OFFERS,
  readOpenCardHandOff,
  type CardOffers,
} from "@hercule/client-core/inbox";
import type { EntityRecord, Inbox, InboxCard, WorkflowOffer } from "@hercule/contract";
import { entityQuery } from "../../app/queries";
import { focusFirstHandRow } from "./inbox-page-dom";
import type { RunAndMoveOn } from "./use-run-and-move-on";
import type { CurrentBy } from "./use-current-card";
import type { OpenCard } from "./use-open-card";

/**
 * The thing a hand-off is for: an Inbox card, or a linked thing that the open
 * sheet shows and the Inbox does not list. `openKinds` are the kinds of its
 * open signals, snoozed ones included, which say what the hand-off would end.
 */
export type HandOffTarget = Pick<EntityRecord, "id" | "kind" | "noun" | "identifier" | "taskId"> & {
  readonly openKinds: readonly string[];
};

/**
 * A hand-off the user can make: the thing to hand, the workflows it can be
 * handed to, and the account the user picked for it. `chosenConnectionId` is
 * `undefined` when the user picked none, which leaves the choice to the
 * controller.
 */
interface HandOffCandidate {
  readonly target: HandOffTarget;
  readonly offers: CardOffers;
  readonly chosenConnectionId: string | undefined;
}

/** The Hand to menu while it is open: the card it is for, the workflows it lists, and what it opens under. */
export interface HandMenu {
  readonly card: InboxCard;
  readonly offers: CardOffers;
  readonly anchor: HTMLElement;
}

/** What `useHandOff` returns. */
export interface HandOff {
  /** The Hand to menu, or `null` while it is closed. */
  readonly menu: HandMenu | null;
  /**
   * The account the user picked for the card the menu or the open sheet is
   * for, or `undefined` when they picked none. There is one choice at a time:
   * it goes when the menu or the sheet closes, and it is not carried to
   * another card.
   */
  readonly chosenConnectionId: string | undefined;
  /** Picks `connectionId` as the account for the card the menu or the open sheet is for. */
  readonly chooseConnection: (connectionId: string) => void;
  /** Opens the Hand to menu for `card` under `anchor`. `by` is how the user asked. */
  readonly openMenu: (card: InboxCard, anchor: HTMLElement, by: CurrentBy) => void;
  /** Closes the Hand to menu without handing anything. */
  readonly closeMenu: () => void;
  /**
   * Starts a Hand to for the Inbox card `card`, as its button or the key H
   * does: at once when one workflow can take it, the menu under `anchor` when
   * several can, and a line saying why when none can.
   */
  readonly startCardHand: (card: InboxCard, anchor: HTMLElement, by: CurrentBy) => void;
  /**
   * Hands the Inbox card `card` to the workflow `workflowId`, as its one-workflow
   * button or a drop on the rail does, and moves the page on. A workflow the
   * card is not offered says why on the undo line.
   */
  readonly handCard: (card: InboxCard, workflowId: string, by: CurrentBy) => void;
  /** Hands the card the menu is for to the workflow `workflowId` and closes the menu. */
  readonly pickFromMenu: (workflowId: string) => void;
  /**
   * Hands the thing the open sheet shows to the workflow `workflowId`, as a
   * click on one of the sheet's rows does. By keys the sheet walks on to the
   * next card and the hand-off plays behind it; by pointer the sheet folds
   * home first. The thing may be a linked peer the Inbox does not list; then
   * the page does not move on, because the thing has no place on it.
   */
  readonly handFromSheet: (workflowId: string, by: CurrentBy) => void;
  /**
   * Handles H (`position` is `undefined`) or the number key `position` while
   * the sheet shows a card: H hands the thing to its one workflow, moves to
   * the sheet's Hand to rows when several can take it, and says why when none
   * can. A number picks that row. Returns whether the key was the sheet's.
   */
  readonly pressSheetKey: (position: number | undefined) => boolean;
}

/**
 * Owns the Hand to gesture of the Inbox: whether a hand-off goes at once
 * (one workflow), asks the user to pick (several) or is refused (none), the
 * Hand to menu, the one account choice, and moving the page on after a
 * hand-off. Every way to hand a card ends in a call here: its button, the key H,
 * the menu, a drop on the rail, and the sheet's rows and keys.
 *
 * - The workflows and the account choice of a card come from the Inbox the
 *   screen draws. The open sheet's come from the card's own read in the query
 *   cache (`readOpenCardHandOff`), so the page's keys read the same facts the
 *   sheet draws.
 * - `hand` makes the hand-off (`useInboxMoves`), and `say` puts a line on the
 *   undo line. `runAndMoveOn` runs the hand-off and moves the page on.
 */
export const useHandOff = ({
  client,
  inbox,
  open,
  hand,
  say,
  runAndMoveOn,
}: {
  readonly client: HerculeClient;
  readonly inbox: Inbox | undefined;
  readonly open: Pick<OpenCard, "isOpen" | "shown" | "closeThen">;
  readonly hand: (
    target: HandOffTarget,
    offer: WorkflowOffer,
    connectionId: string | undefined,
  ) => void;
  readonly say: (text: string) => void;
  readonly runAndMoveOn: RunAndMoveOn;
}): HandOff => {
  const queryClient = useQueryClient();
  const [menuFor, setMenuFor] = useState<{
    readonly cardId: string;
    readonly anchor: HTMLElement;
    readonly by: CurrentBy;
  } | null>(null);
  const [choice, setChoice] = useState<
    { readonly cardId: string; readonly connectionId: string } | undefined
  >(undefined);

  const findCard = (id: string): InboxCard | undefined =>
    inbox?.cards.find((card) => card.id === id);
  const readOffers = (card: InboxCard): CardOffers =>
    inbox === undefined ? NO_OFFERS : listCardOffers(card, inbox.offerSets);

  // The account choice is for the card the menu or the open sheet shows, and goes when neither is open.
  const subjectId =
    menuFor !== null
      ? menuFor.cardId
      : open.isOpen && open.shown?.kind === "card"
        ? open.shown.id
        : undefined;
  if (subjectId === undefined && choice !== undefined) setChoice(undefined);
  const readChoiceFor = (cardId: string): string | undefined =>
    choice?.cardId === cardId ? choice.connectionId : undefined;

  const buildCardCandidate = (card: InboxCard): HandOffCandidate => ({
    target: { ...card, openKinds: card.signals.kinds },
    offers: readOffers(card),
    chosenConnectionId: readChoiceFor(card.id),
  });

  /** Returns what the open sheet can hand, or `null` while it shows no card that has been read. */
  const readSheetCandidate = (): HandOffCandidate | null => {
    const { shown } = open;
    if (shown?.kind !== "card") return null;
    const detail = queryClient.getQueryData(entityQuery(client, shown.id).queryKey);
    const listed = findCard(shown.id);
    const record = detail ?? listed;
    if (record === undefined) return null;
    const { offers, openKinds } = readOpenCardHandOff(detail, listed, inbox);
    return {
      target: { ...record, openKinds },
      offers,
      chosenConnectionId: readChoiceFor(shown.id),
    };
  };

  /**
   * Hands the thing in `candidate` to the workflow `workflowId` and moves the
   * page on. A workflow the thing is not offered says why on the undo line. A
   * thing that is not on the page has no place to move on from, so the page
   * stays where it is.
   */
  const handTo = (candidate: HandOffCandidate, workflowId: string, by: CurrentBy): void => {
    const { target, offers, chosenConnectionId } = candidate;
    const offer = offers.available.find((each) => each.workflowId === workflowId);
    if (offer === undefined) {
      say(describeMoveRefusal(target, "hand", offers) ?? "That workflow can no longer take it.");
      return;
    }
    const run = (): void => {
      setChoice(undefined);
      hand(target, offer, chosenConnectionId);
    };
    if (findCard(target.id) === undefined) run();
    else runAndMoveOn(target.id, by, run);
  };

  /** Starts a Hand to for `candidate`: at once for one workflow, `chooseWorkflow` for several, a line for none. */
  const startHand = (candidate: HandOffCandidate, by: CurrentBy, chooseWorkflow: () => void) => {
    const { target, offers } = candidate;
    const [first] = offers.available;
    if (first !== undefined && offers.available.length === 1) {
      handTo(candidate, first.workflowId, by);
      return;
    }
    const reason = describeMoveRefusal(target, "hand", offers);
    if (reason === undefined) chooseWorkflow();
    else say(reason);
  };

  const openMenu = (card: InboxCard, anchor: HTMLElement, by: CurrentBy): void => {
    setMenuFor({ cardId: card.id, anchor, by });
  };

  const menuCard = menuFor === null ? undefined : findCard(menuFor.cardId);

  return {
    menu:
      menuFor === null || menuCard === undefined
        ? null
        : { card: menuCard, offers: readOffers(menuCard), anchor: menuFor.anchor },
    chosenConnectionId: subjectId === undefined ? undefined : readChoiceFor(subjectId),
    chooseConnection: (connectionId) => {
      if (subjectId !== undefined) setChoice({ cardId: subjectId, connectionId });
    },
    openMenu,
    closeMenu: () => {
      setMenuFor(null);
    },
    startCardHand: (card, anchor, by) => {
      startHand(buildCardCandidate(card), by, () => {
        openMenu(card, anchor, by);
      });
    },
    handCard: (card, workflowId, by) => {
      handTo(buildCardCandidate(card), workflowId, by);
    },
    pickFromMenu: (workflowId) => {
      if (menuFor === null || menuCard === undefined) return;
      const candidate = buildCardCandidate(menuCard);
      setMenuFor(null);
      handTo(candidate, workflowId, menuFor.by);
    },
    handFromSheet: (workflowId, by) => {
      const candidate = readSheetCandidate();
      if (candidate === null) return;
      if (by === "keys") handTo(candidate, workflowId, by);
      else {
        open.closeThen(() => {
          handTo(candidate, workflowId, by);
        });
      }
    },
    pressSheetKey: (position) => {
      const candidate = readSheetCandidate();
      if (candidate === null) return false;
      if (position === undefined) {
        startHand(candidate, "keys", () => {
          focusFirstHandRow(document);
        });
        return true;
      }
      const picked = candidate.offers.available[position - 1];
      if (picked === undefined) return false;
      handTo(candidate, picked.workflowId, "keys");
      return true;
    },
  };
};
