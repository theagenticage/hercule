/**
 * Taking on and dismissing the Inbox's cards, and the undo line at the foot of
 * the screen. It follows the Work board's moves (`-card-moves.ts`):
 *
 * - Moves are sent one at a time, in the order the user made them.
 * - A dismissal shows at once: the card leaves the page and the cards after it
 *   close up, before the controller answers. The screen shows the Inbox in the
 *   query cache with every edit not yet answered applied over it
 *   (`reapplyInboxEdits`), so a read that lands meanwhile cannot put the card
 *   back. A Take shows when the controller answers, with the Task it made.
 * - When the controller answers, the edit is written into the cached Inbox and
 *   leaves the pending list in the same draw. A move it refuses leaves the
 *   pending list alone, so the card goes back, and the undo line says why.
 * - Each move the user makes is one gesture on the shared undo stack. A
 *   gesture outlives the screen that made it, so it is undone through the
 *   screen that is open when Undo is pressed (`CardMover`).
 */
import { useMemo, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys, readErrorMessage, type HerculeClient } from "@hercule/client-core";
import {
  applyInboxEdit,
  nameCard,
  reapplyInboxEdits,
  type InboxEdit,
} from "@hercule/client-core/inbox";
import type { Inbox, InboxCard } from "@hercule/contract";
import { buildCachedCardMover, type CardMover } from "../../../app/card-mover";
import type { SpringName } from "../../../app/motion";
import type { Gesture, UndoStack } from "../../../app/undo-stack";
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

const NOT_SAVED_MESSAGE = "That move did not save, so there is nothing to put back.";

/** Removes the full stops at the end of an error's words, so a sentence can go on after them. */
const readReason = (error: unknown): string => readErrorMessage(error).replace(/\.+$/, "");

/** What `useInboxMoves` returns. */
export interface InboxMoves {
  /** The Inbox with the pending edits applied, or `undefined` until the first read ends. */
  readonly inbox: Inbox | undefined;
  /**
   * Takes the card on as a Task. When the controller answers, the card shows
   * the user's monogram where its wait was, and the undo line offers Undo. A
   * failure says why.
   */
  readonly take: (card: InboxCard) => void;
  /**
   * Dismisses the card. It leaves the page at once: a copy steps aside, and the
   * cards after it close up on `hand`. A failure puts it back on `travel`
   * and says why.
   */
  readonly dismiss: (card: InboxCard) => void;
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
  const { line, say, undo } = useUndoLine(undoStack);

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
    });
    return { shown, born };
  };

  /** Writes an edit the controller answered into the cached Inbox, and drops it from the pending list in the same draw. */
  const settleEdit = async (shown: PendingEdit): Promise<void> => {
    // A read that started before this answer could end after the edit and put the card back.
    // Cancelling reverts it, and the push that follows starts a read that began after the answer.
    if (queryClient.getQueryData(queryKeys.inbox()) !== undefined) {
      await queryClient.cancelQueries({ queryKey: queryKeys.inbox() });
    }
    queryClient.setQueryData<Inbox>(queryKeys.inbox(), (cached) =>
      cached === undefined ? undefined : applyInboxEdit(cached, shown.edit),
    );
    changePending((edits) => edits.filter((each) => each.id !== shown.id));
  };

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

  const take = (card: InboxCard): void => {
    const name = nameCard(card);
    takeOn.mutateAsync(card).then(
      async ({ taskId, created }) => {
        const { shown } = showEdit({ kind: "set-task", id: card.id, taskId }, "hand");
        const scroller = scrollRef.current;
        const element = scroller === null ? null : findCardElement(scroller, card.id);
        if (element !== null) riseMonogram(element);
        await settleEdit(shown);
        if (!created) {
          say(`${name} already had a Task, so no new one was made.`, false);
          return;
        }
        const gesture: Gesture<CardMover> = {
          words: `Took on ${name}`,
          undo: async (page) => {
            const outcome = await client.externalEntity.undoTakeOn({
              params: { id: card.id },
              payload: { taskId },
            });
            // The Task was touched since, so it stays. The line says why.
            if (!outcome.undone) {
              throw new Error(outcome.reason ?? "The Task has changed since you took it on.");
            }
            await page.writeInboxEdit({ kind: "set-task", id: card.id, taskId: undefined });
            return undefined;
          },
        };
        undoStack.push(gesture);
        say(`Took on ${name}. A Task is on Work.`, true);
      },
      (error: unknown) => {
        say(`${name} was not taken on: ${readReason(error)}. Try again.`, false);
      },
    );
  };

  const dismiss = (card: InboxCard): void => {
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
        say(`${name} was not dismissed, so it is back: ${readReason(error)}. Try again.`, false);
        return false;
      },
    );
    const gesture: Gesture<CardMover> = {
      words: `Dismissed ${name}`,
      undo: async (page) => {
        if (!(await wasSaved)) throw new Error(NOT_SAVED_MESSAGE);
        await client.externalEntity.restore({ params: { id: card.id } });
        await page.writeInboxEdit({ kind: "put-back", card });
        return undefined;
      },
    };
    undoStack.push(gesture);
    say(`Dismissed ${name}.`, true);
    // A move that failed has nothing to undo. Taking its gesture off the stack
    // keeps the next Undo for the move before it.
    void wasSaved.then((saved) => {
      if (!saved) undoStack.remove(gesture);
    });
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

  const undoLastMove = (): void => {
    undo({ putCardBack: buildCachedCardMover(client, queryClient), writeInboxEdit });
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

  return {
    inbox,
    take,
    dismiss,
    undoLastMove,
    line,
    sayWithoutUndo: (text) => {
      say(text, false);
    },
  };
};
