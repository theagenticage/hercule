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
  describeDismissal,
  nameCard,
  NO_RIDING_CHOICES,
  planLink,
  planUnlink,
  reapplyInboxEdits,
  type EntityLinkMove,
  type InboxEdit,
  type RidingChoices,
} from "@hercule/client-core/inbox";
import type { Inbox, InboxCard } from "@hercule/contract";
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
  readonly dismiss: (card: InboxCard, riders?: readonly InboxCard[]) => void;
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
  const [riding, setRiding] = useState(NO_RIDING_CHOICES);
  const chooseRiding = (edit: InboxEdit): void => {
    if (edit.kind !== "set-link" || edit.riding === undefined) return;
    const { id, ridesOn } = edit.riding;
    setRiding((before) => new Map(before).set(id, ridesOn));
  };

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

  /** Shows `edit` on the page at once, gliding on `spring`, and lists it as pending. Returns the edit and the parts that are new. */
  const showEdit = (edit: InboxEdit, spring: SpringName) => {
    const shown: PendingEdit = { id: nextId.current++, edit };
    const born = playPageChange(spring, () => {
      changePending((edits) => [...edits, shown]);
      chooseRiding(edit);
    });
    return { shown, born };
  };

  /** Takes `shown` off the page again, and gives each card back what it rode on before, because the controller refused it. */
  const takeEditBack = (shown: PendingEdit, reverse: InboxEdit | undefined): void => {
    playPageChange("hand", () => {
      changePending((edits) => edits.filter((each) => each.id !== shown.id));
      if (reverse !== undefined) chooseRiding(reverse);
    });
  };

  /** Writes an edit the controller answered into the cached Inbox, and drops it from the pending list in the same draw. */
  const settleEdit = async (shown: PendingEdit): Promise<void> => {
    await writeCachedInbox(shown.edit);
    changePending((edits) => edits.filter((each) => each.id !== shown.id));
  };

  /**
   * Shows an edit made by Undo on the page that is open, and writes it into
   * the cached Inbox. A card put back parts the page on `hand` and comes from
   * 14px aside on `travel`.
   */
  const writeInboxEdit = async (edit: InboxEdit): Promise<void> => {
    const { shown, born } = showEdit(edit, "hand");
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

  const linkEntities = useMutation({
    mutationKey: INBOX_MOVES_KEY,
    scope: { id: "inbox-moves" },
    mutationFn: (move: EntityLinkMove) =>
      client.externalEntity.link({ payload: { fromRef: move.fromRef, toRef: move.toRef } }),
  });
  const unlinkEntities = useMutation({
    mutationKey: INBOX_MOVES_KEY,
    scope: { id: "inbox-moves" },
    mutationFn: (move: EntityLinkMove) =>
      client.externalEntity.unlink({ payload: { fromRef: move.fromRef, toRef: move.toRef } }),
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

  const dismiss = (card: InboxCard, riders: readonly InboxCard[] = []): void => {
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
   * Links the two things, and shows it at once: a request that is linked to a
   * ticket flies from Requests into the ticket's tucked sheet, and everything
   * between closes up, in one movement on `hand`. A failure takes it back.
   */
  const link = (move: EntityLinkMove): void => {
    const words = `${move.fromName} and ${move.toName}`;
    const plan = inbox === undefined ? undefined : planLink(inbox, move.fromRef, move.toRef);
    const shown = plan === undefined ? undefined : showEdit(plan.edit, "hand").shown;
    const request = linkEntities.mutateAsync(move);
    const wasLinked = request.then(
      () => true,
      () => false,
    );
    const gesture: Gesture<CardMover> = {
      words: `Linked ${words}`,
      undo: async (page) => {
        await reverseMove.mutateAsync(async () => {
          if (!(await wasLinked)) throw new Error(NOTHING_TO_PUT_BACK);
          await client.externalEntity.unlink({
            payload: { fromRef: move.fromRef, toRef: move.toRef },
          });
          // The part leaves its lead and goes back where it was, the same way it came.
          if (plan !== undefined) await page.writeInboxEdit(plan.undo);
          readLinksAgain();
        });
        return undefined;
      },
    };
    undoStack.reserve(gesture, wasLinked);
    request.then(
      async () => {
        if (shown !== undefined) await settleEdit(shown);
        readLinksAgain();
        say(`Linked ${words}.`, gesture);
      },
      (error: unknown) => {
        if (shown !== undefined) takeEditBack(shown, plan?.undo);
        say(`${words} were not linked: ${readReason(error)}. Try again.`);
      },
    );
  };

  /** Removes the user's link between the two things, and shows it at once. A card that rode on the other end stands alone. */
  const unlink = (move: EntityLinkMove): void => {
    const words = `${move.fromName} and ${move.toName}`;
    const plan = inbox === undefined ? undefined : planUnlink(inbox, move.fromRef, move.toRef);
    const shown = plan === undefined ? undefined : showEdit(plan.edit, "hand").shown;
    const request = unlinkEntities.mutateAsync(move);
    const wasRemoved = request.then(
      ({ removed }) => removed,
      () => false,
    );
    const gesture: Gesture<CardMover> = {
      words: `Removed the link between ${words}`,
      undo: async (page) => {
        await reverseMove.mutateAsync(async () => {
          if (!(await wasRemoved)) throw new Error(NOTHING_TO_PUT_BACK);
          await client.externalEntity.link({
            payload: { fromRef: move.fromRef, toRef: move.toRef },
          });
          if (plan !== undefined) await page.writeInboxEdit(plan.undo);
          readLinksAgain();
        });
        return undefined;
      },
    };
    undoStack.reserve(gesture, wasRemoved);
    request.then(
      async ({ removed, remaining }) => {
        if (shown !== undefined) {
          if (removed) await settleEdit(shown);
          else takeEditBack(shown, plan?.undo);
        }
        readLinksAgain();
        if (!removed) {
          say(`You had made no link between ${words}, so none was removed.`);
          return;
        }
        const stays =
          remaining === "source"
            ? " The source still reports the link."
            : remaining === "text"
              ? " A reference in text still mentions it."
              : "";
        say(`Link removed.${stays}`, gesture);
      },
      (error: unknown) => {
        if (shown !== undefined) takeEditBack(shown, plan?.undo);
        say(`The link between ${words} was not removed: ${readReason(error)}. Try again.`);
      },
    );
  };

  return {
    inbox,
    hasPendingEdits: pendingEdits.length > 0,
    riding,
    take,
    dismiss,
    link,
    unlink,
    undoLastMove: undo,
    line,
    sayWithoutUndo: (text) => {
      say(text);
    },
  };
};
