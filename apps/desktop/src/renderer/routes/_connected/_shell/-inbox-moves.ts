/**
 * Taking on and dismissing the Inbox's cards, and the undo line at the foot of
 * the screen. It follows the Work board's moves (`-card-moves.ts`):
 *
 * - Moves are sent one at a time, in the order the user made them. The
 *   reversal of a move takes its place in the same line when the user presses
 *   Undo, and waits there for the move's own answer. A move the user makes
 *   after Undo therefore reaches the controller after the reversal.
 * - A dismissal shows at once: the card leaves the page and the cards after it
 *   close up, before the controller answers. The screen shows the Inbox in the
 *   query cache with every edit not yet answered applied over it
 *   (`reapplyInboxEdits`), so a read that lands meanwhile cannot put the card
 *   back. A Take shows when the controller answers, with the Task it made.
 * - When the controller answers, the edit is written into the cached Inbox and
 *   leaves the pending list in the same draw. A move it refuses leaves the
 *   pending list alone, so the card goes back, and the undo line says why.
 * - Each move the user makes is one gesture on the shared undo stack. The
 *   gesture takes its place when the user acts, before the controller answers,
 *   and its undo waits for the answer itself. A move that fails, or a Take that
 *   makes no Task, takes its gesture off again. A gesture outlives the screen
 *   that made it, so it is undone through the screen that is open when Undo is
 *   pressed (`CardMover`).
 */
import { useMemo, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  invalidateWithoutCancelling,
  queryKeys,
  readErrorMessage,
  type HerculeClient,
} from "@hercule/client-core";
import {
  decideRidingChoices,
  describeDismissal,
  describeLinkRemoved,
  EMPTY_RIDING_LEDGER,
  nameCard,
  planLink,
  planUnlink,
  reapplyInboxEdits,
  settleRidingChoice,
  settleRidingMove,
  startRidingMove,
  type EntityLinkMove,
  type InboxEdit,
  type RidingChoices,
  type RidingMove,
} from "@hercule/client-core/inbox";
import type { EntityUnlinkResult, Inbox, InboxCard } from "@hercule/contract";
import {
  buildCachedCardMover,
  buildCachedEndedCardMover,
  buildCachedInboxWriter,
  type CardMover,
} from "../../../app/card-mover";
import type { SpringName } from "../../../app/motion";
import type { Gesture, UndoStack } from "../../../app/undo-stack";
import { undoAddedTask } from "../../../app/undo-added-task";
import { useUndoLine, type UndoLineState } from "../../../app/use-undo-line";
import { findCardElement } from "../../../screens/inbox/inbox-page-dom";
import {
  comeBackFromAside,
  copyCardToStepAside,
  flipInboxPage,
  riseMonogram,
  stepAside,
} from "../../../screens/inbox/inbox-motion";

/** The key every Inbox move runs under, so one move waits for the one before it. */
const INBOX_MOVES_KEY = ["inbox-moves"];

/** A change to the Inbox that the controller has not answered yet. */
interface PendingEdit {
  readonly id: number;
  readonly edit: InboxEdit;
}

const NO_EDITS: readonly PendingEdit[] = [];

const NOTHING_TO_PUT_BACK = "That move changed nothing, so there is nothing to put back.";

/** Removes the full stops at the end of an error's words, so a sentence can go on after them. */
const readReason = (error: unknown): string => readErrorMessage(error).replace(/\.+$/, "");

/** Which way a change to a link goes. */
type LinkDirection = "link" | "unlink";

/** What the controller answered to a Link or Unlink, in one shape. */
interface LinkAnswer {
  /** False when a Link failed, or an Unlink removed nothing because the user had made no link. */
  readonly didChange: boolean;
  /** The firmest claim that still joins the two after an Unlink. */
  readonly remaining: EntityUnlinkResult["remaining"];
}

/** Returns the direction that reverses `direction`. */
const reverseDirection = (direction: LinkDirection): LinkDirection =>
  direction === "link" ? "unlink" : "link";

/** What the undo line says about a Link or Unlink: the gesture, and what a refusal says. */
const LINK_WORDS = {
  link: {
    gesture: (words: string) => `Linked ${words}`,
    done: (words: string) => `Linked ${words}.`,
    failed: (words: string, reason: string) => `${words} were not linked: ${reason}. Try again.`,
  },
  unlink: {
    gesture: (words: string) => `Removed the link between ${words}`,
    failed: (words: string, reason: string) =>
      `The link between ${words} was not removed: ${reason}. Try again.`,
  },
} as const;

/** What `useInboxMoves` returns. */
export interface InboxMoves {
  /** The Inbox with the pending edits applied, or `undefined` until the first read ends. */
  readonly inbox: Inbox | undefined;
  /** Whether a move the user made is applied over the read and not yet answered by the controller. */
  readonly hasPendingEdits: boolean;
  /** What the user's own Link and Unlink put cards on or took them off, for the visit to hold in place. */
  readonly riding: RidingChoices;
  /**
   * Takes the card on as a Task. When the controller answers, the card shows
   * the user's monogram where its wait was, and the undo line offers Undo. A
   * failure says why.
   */
  readonly take: (card: InboxCard) => void;
  /**
   * Dismisses the card. It leaves the page at once: a copy steps aside, and the
   * cards after it close up on `hand`. A failure puts it back on `travel`
   * and says why. `riders` are the cards drawn riding on it: they stand alone
   * from then on, and the undo line says so.
   */
  readonly dismiss: (card: InboxCard, riders: readonly InboxCard[]) => void;
  /**
   * Links two things as the user's own claim. The undo line says what was
   * linked and offers Undo, which removes the link again. A failure says why.
   */
  readonly link: (move: EntityLinkMove) => void;
  /**
   * Removes the user's own link between two things. The undo line offers Undo,
   * which links them again, and says when a link of a source stays. A failure
   * says why.
   */
  readonly unlink: (move: EntityLinkMove) => void;
  /** Reverses the newest gesture on the undo stack, and says what happened. */
  readonly undoLastMove: () => void;
  /** What the undo line shows. */
  readonly line: UndoLineState;
  /** Shows `text` on the undo line with no Undo. */
  readonly sayWithoutUndo: (text: string) => void;
}

/** Sends a Link or Unlink of the pair in `move` to the controller and returns its answer. */
const sendLinkChange = async (
  client: HerculeClient,
  move: EntityLinkMove,
  direction: LinkDirection,
): Promise<LinkAnswer> => {
  const payload = { fromRef: move.fromRef, toRef: move.toRef };
  if (direction === "link") {
    await client.externalEntity.link({ payload });
    return { didChange: true, remaining: undefined };
  }
  const { removed, remaining } = await client.externalEntity.unlink({ payload });
  return { didChange: removed, remaining };
};

/**
 * Moves cards of the Inbox for `client` and returns the Inbox to draw.
 * `serverInbox` is the Inbox as the last read gave it, and `scrollRef` is the
 * element that scrolls the page, which the motion of a move measures.
 */
export const useInboxMoves = ({
  client,
  undoStack,
  serverInbox,
  scrollRef,
}: {
  readonly client: HerculeClient;
  readonly undoStack: UndoStack<CardMover>;
  readonly serverInbox: Inbox | undefined;
  readonly scrollRef: RefObject<HTMLElement | null>;
}): InboxMoves => {
  const queryClient = useQueryClient();
  const pendingRef = useRef<readonly PendingEdit[]>(NO_EDITS);
  const [pendingEdits, setPendingEdits] = useState(NO_EDITS);
  const changePending = (change: (edits: readonly PendingEdit[]) => readonly PendingEdit[]) => {
    pendingRef.current = change(pendingRef.current);
    setPendingEdits(pendingRef.current);
  };
  const nextId = useRef(1);
  const writeCachedInbox = buildCachedInboxWriter(queryClient);
  // The visit holds what rides on what, so a read cannot move a card. The user's own Link and Unlink can,
  // and they are kept here, by card, for the length of the screen.
  const [ridingLedger, setRidingLedger] = useState(EMPTY_RIDING_LEDGER);
  const riding = useMemo(() => decideRidingChoices(ridingLedger), [ridingLedger]);

  // The same Inbox object until a read or an edit changes it, because the screen compares it with the last.
  const inbox = useMemo(
    () =>
      serverInbox === undefined
        ? undefined
        : reapplyInboxEdits(
            serverInbox,
            pendingEdits.map((each) => each.edit),
          ),
    [serverInbox, pendingEdits],
  );

  /**
   * Makes `change` and glides every part of the page that moves because of it
   * on `spring`. The change is committed at once, because the page is
   * measured again right after it. With no page on screen, only makes it.
   * Returns the parts that are new.
   */
  const playPageChange = (spring: SpringName, change: () => void): readonly HTMLElement[] => {
    const scroller = scrollRef.current;
    if (scroller === null) {
      change();
      return [];
    }
    return flipInboxPage(scroller, spring, () => {
      flushSync(change);
    }).born;
  };

  /**
   * Shows `edit` on the page at once, gliding on `spring`, and lists it as
   * pending. `ridingMove` is what a Link or Unlink does to what rides on what,
   * which waits for the controller's answer with the edit. Returns the edit
   * and the parts that are new.
   */
  const showEdit = (edit: InboxEdit, spring: SpringName, ridingMove?: RidingMove) => {
    const shown: PendingEdit = { id: nextId.current++, edit };
    const born = playPageChange(spring, () => {
      changePending((edits) => [...edits, shown]);
      if (ridingMove !== undefined) {
        setRidingLedger((ledger) => startRidingMove(ledger, shown.id, ridingMove));
      }
    });
    return { shown, born };
  };

  /**
   * Takes `shown` off the page again because the controller refused it, or
   * because it changed nothing. The cards it moved are put back where they
   * stood, and a move made after it stays.
   */
  const takeEditBack = (shown: PendingEdit): void => {
    playPageChange("hand", () => {
      changePending((edits) => edits.filter((each) => each.id !== shown.id));
      setRidingLedger((ledger) => settleRidingMove(ledger, shown.id, false));
    });
  };

  /** Writes an edit the controller answered into the cached Inbox, and drops it from the pending list in the same draw. */
  const settleEdit = async (shown: PendingEdit, didChangeRiding = true): Promise<void> => {
    await writeCachedInbox(shown.edit);
    changePending((edits) => edits.filter((each) => each.id !== shown.id));
    setRidingLedger((ledger) => settleRidingMove(ledger, shown.id, didChangeRiding));
  };

  /**
   * Shows an edit made by Undo on the page that is open, and writes it into
   * the cached Inbox. A card put back parts the page on `hand` and comes from
   * 14px aside on `travel`.
   */
  const writeInboxEdit = async (edit: InboxEdit): Promise<void> => {
    const { shown, born } = showEdit(edit, "hand");
    if (edit.kind === "set-link" && edit.riding !== undefined) {
      const { id, ridesOn } = edit.riding;
      setRidingLedger((ledger) => settleRidingChoice(ledger, id, ridesOn));
    }
    if (edit.kind === "put-back") {
      for (const card of born) {
        if (card.dataset["cardId"] === edit.card.id) comeBackFromAside(card);
      }
    }
    await settleEdit(shown);
  };

  const { line, say, undo } = useUndoLine(undoStack, () => ({
    putCardBack: buildCachedCardMover(client, queryClient),
    putEndedCardBack: buildCachedEndedCardMover(client, queryClient),
    writeInboxEdit,
  }));

  const takeOn = useMutation({
    mutationKey: INBOX_MOVES_KEY,
    scope: { id: "inbox-moves" },
    mutationFn: (card: InboxCard) => client.externalEntity.takeOn({ params: { id: card.id } }),
  });
  const dismissCard = useMutation({
    mutationKey: INBOX_MOVES_KEY,
    scope: { id: "inbox-moves" },
    mutationFn: (card: InboxCard) => client.externalEntity.dismiss({ params: { id: card.id } }),
  });

  const changeLinkRequest = useMutation({
    mutationKey: INBOX_MOVES_KEY,
    scope: { id: "inbox-moves" },
    mutationFn: ({
      move,
      direction,
    }: {
      readonly move: EntityLinkMove;
      readonly direction: LinkDirection;
    }): Promise<LinkAnswer> => sendLinkChange(client, move, direction),
  });

  // The reversals wait in the same line as the moves, so none overtakes another.
  const reverseMove = useMutation({
    mutationKey: INBOX_MOVES_KEY,
    scope: { id: "inbox-moves" },
    mutationFn: (reverse: () => Promise<void>) => reverse(),
  });

  const take = (card: InboxCard): void => {
    const name = nameCard(card);
    const request = takeOn.mutateAsync(card);
    // A Take that made no Task (it failed, or the card already had one) has nothing to put back.
    const wasCreated = request.then(
      ({ created }) => created,
      () => false,
    );
    const gesture: Gesture<CardMover> = {
      words: `Took on ${name}`,
      undo: async (page) => {
        await reverseMove.mutateAsync(async () => {
          if (!(await wasCreated)) throw new Error(NOTHING_TO_PUT_BACK);
          const { taskId } = await request;
          // The Task was touched since, so it stays and the line says why.
          await undoAddedTask(client, card.id, taskId);
          await page.writeInboxEdit({ kind: "set-task", id: card.id, taskId: undefined });
        });
        return undefined;
      },
    };
    undoStack.reserve(gesture, wasCreated);
    request.then(
      async ({ taskId, created }) => {
        const { shown } = showEdit({ kind: "set-task", id: card.id, taskId }, "hand");
        const scroller = scrollRef.current;
        const element = scroller === null ? null : findCardElement(scroller, card.id);
        if (element !== null) riseMonogram(element);
        await settleEdit(shown);
        if (!created) {
          say(`${name} already had a Task, so no new one was made.`);
          return;
        }
        say(`Took on ${name}. A Task is on Work.`, gesture);
      },
      (error: unknown) => {
        say(`${name} was not taken on: ${readReason(error)}. Try again.`);
      },
    );
  };

  const dismiss = (card: InboxCard, riders: readonly InboxCard[]): void => {
    const name = nameCard(card);
    const scroller = scrollRef.current;
    const element = scroller === null ? null : findCardElement(scroller, card.id);
    // The copy is made while the card is still on the page, and steps aside once it has left.
    const copy =
      scroller === null || element === null ? null : copyCardToStepAside(scroller, element);
    const { shown } = showEdit({ kind: "drop", id: card.id }, "hand");
    if (copy !== null) stepAside(copy);

    const wasSaved = dismissCard.mutateAsync(card).then(
      async () => {
        await settleEdit(shown);
        return true;
      },
      (error: unknown) => {
        playPageChange("travel", () => {
          changePending((edits) => edits.filter((each) => each.id !== shown.id));
        });
        say(`${name} was not dismissed, so it is back: ${readReason(error)}. Try again.`);
        return false;
      },
    );
    const gesture: Gesture<CardMover> = {
      words: `Dismissed ${name}`,
      undo: async (page) => {
        await reverseMove.mutateAsync(async () => {
          if (!(await wasSaved)) throw new Error(NOTHING_TO_PUT_BACK);
          await client.externalEntity.restore({ params: { id: card.id } });
          await page.writeInboxEdit({ kind: "put-back", card });
        });
        return undefined;
      },
    };
    undoStack.reserve(gesture, wasSaved);
    say(describeDismissal(card, riders), gesture);
  };

  /** Reads again what a link decides: what rides on what, the count, and every open entity's links. */
  const readLinksAgain = (): void => {
    for (const key of [queryKeys.inbox(), queryKeys.inboxCount(), queryKeys.externalEntity()]) {
      invalidateWithoutCancelling(queryClient, key);
    }
  };

  /**
   * Links the two things, or removes the user's link between them, and shows
   * it at once. A request that is linked to a ticket flies from Requests into
   * the ticket's tucked sheet and everything between closes up, in one
   * movement on `hand`; a card that rode on the other end stands alone. The
   * undo line offers Undo, which does the reverse. A failure takes it back.
   * The controller's answer decides what rides on what: a link a source
   * still reports keeps its card riding.
   */
  const changeLink = (move: EntityLinkMove, direction: LinkDirection): void => {
    const words = `${move.fromName} and ${move.toName}`;
    const plan =
      inbox === undefined
        ? undefined
        : direction === "link"
          ? planLink(inbox, move.fromRef, move.toRef)
          : planUnlink(inbox, move.fromRef, move.toRef);
    const shown = plan === undefined ? undefined : showEdit(plan.edit, "hand", plan.riding).shown;
    const request = changeLinkRequest.mutateAsync({ move, direction });
    const wasChanged = request.then(
      ({ didChange }) => didChange,
      () => false,
    );
    const gesture: Gesture<CardMover> = {
      words: LINK_WORDS[direction].gesture(words),
      undo: async (page) => {
        await reverseMove.mutateAsync(async () => {
          if (!(await wasChanged)) throw new Error(NOTHING_TO_PUT_BACK);
          await sendLinkChange(client, move, reverseDirection(direction));
          // The part goes back where it was, the same way it came.
          if (plan !== undefined) await page.writeInboxEdit(plan.undo);
          readLinksAgain();
        });
        return undefined;
      },
    };
    undoStack.reserve(gesture, wasChanged);
    request.then(
      async ({ didChange, remaining }) => {
        if (shown !== undefined) {
          if (didChange) await settleEdit(shown, remaining !== "source");
          else takeEditBack(shown);
        }
        readLinksAgain();
        if (!didChange) {
          say(`You had made no link between ${words}, so none was removed.`);
          return;
        }
        say(
          direction === "link" ? LINK_WORDS.link.done(words) : describeLinkRemoved(remaining),
          gesture,
        );
      },
      (error: unknown) => {
        if (shown !== undefined) takeEditBack(shown);
        say(LINK_WORDS[direction].failed(words, readReason(error)));
      },
    );
  };

  return {
    inbox,
    hasPendingEdits: pendingEdits.length > 0,
    riding,
    take,
    dismiss,
    link: (move) => {
      changeLink(move, "link");
    },
    unlink: (move) => {
      changeLink(move, "unlink");
    },
    undoLastMove: undo,
    line,
    sayWithoutUndo: (text) => {
      say(text);
    },
  };
};
