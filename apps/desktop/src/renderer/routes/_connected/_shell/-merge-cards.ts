/**
 * Merging one card of the Work board into another, whichever way the user
 * asks for it: by dragging (hold still over a card, or hold Option), by key
 * (`M`, then the arrows and Return) or from the details pane.
 *
 * - A merge is held back for the undo line (`app/pending-intents.ts`) and only
 *   then sent as `task.merge`. Meanwhile the card that merges away is hidden
 *   from the board, and Undo takes the merge back by cancelling the held intent.
 * - A merge that is refused, or not sent because the app closed, brings the
 *   card back, comes out from under the card it was merged into, and the undo
 *   line says why. Nothing is merged without the user being told.
 * - The store lives in the controller, not here, so a merge goes on when the
 *   user leaves Work during the undo line.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { flushSync } from "react-dom";
import {
  describeMerge,
  describeMergedInto,
  describeMergeFailure,
  hideHeldMergeSources,
} from "@hercule/client-core/work";
import type { WorkCard } from "@hercule/contract";
import type { SavedController } from "../../../app/context";
import type { PendingIntent } from "../../../app/pending-intents";
import { usePendingIntents } from "../../../app/use-pending-intents";
import {
  launchLeavingCard,
  playMergeIn,
  playMergeOut,
  removeFlight,
} from "../../../screens/work/board-flights";
import { flipBoard } from "../../../screens/work/flip-board";
import type { CardMoves } from "./-card-moves";

/** What `useMergeCards` returns. */
export interface MergeCards {
  /** `boardCards` without the card of each merge that is held or on its way. */
  readonly cards: readonly WorkCard[];
  /**
   * Holds the merge of the card `sourceCardId` into the card `targetCardId`
   * for the undo line and shows it done, with no motion: the source leaves the
   * board and the undo line offers Undo. Returns `false`, and holds nothing,
   * when either card is not on the board or both are the same. The drag
   * calls it inside its own committed change and plays the motion itself.
   */
  readonly holdMerge: (sourceCardId: string, targetCardId: string) => boolean;
  /**
   * Merges the card `sourceCardId` into the card `targetCardId` as the user
   * asked by key or from the details: the card slides in under the target and
   * fades, and the target settles. Says on the undo line when either card has
   * left the board.
   */
  readonly mergeCard: (sourceCardId: string, targetCardId: string) => void;
}

/** Returns the held merges that failed, oldest first. */
const listFailedMerges = (
  intents: readonly PendingIntent[],
): readonly (PendingIntent & { readonly kind: "merge" })[] =>
  intents.filter(
    (intent): intent is PendingIntent & { readonly kind: "merge" } =>
      intent.kind === "merge" && intent.state === "failed",
  );

/**
 * Returns the merge actions for the board of `boardCards`, and the cards to
 * draw. `isBoardRead` is whether the board was read: a merge that failed while
 * the app was closed is reported once the card's title is known. `moves` shows
 * the undo line and keeps the undo stack, `scrollRef` is the element that
 * scrolls the board, `openTaskId` is the Task whose details are open, and
 * `closePane` closes them (a merge away of the open Task closes them).
 */
export const useMergeCards = ({
  controller,
  username,
  boardCards,
  isBoardRead,
  moves,
  scrollRef,
  openTaskId,
  closePane,
}: {
  readonly controller: SavedController;
  readonly username: string;
  readonly boardCards: readonly WorkCard[];
  readonly isBoardRead: boolean;
  readonly moves: Pick<CardMoves, "sayWithUndo" | "sayWithoutUndo">;
  readonly scrollRef: RefObject<HTMLElement | null>;
  readonly openTaskId: string | null;
  readonly closePane: () => void;
}): MergeCards => {
  const { store, intents } = usePendingIntents(controller, username);

  const heldMerges = useMemo(
    () =>
      intents.filter(
        (intent): intent is PendingIntent & { readonly kind: "merge" } =>
          intent.kind === "merge" && intent.state !== "failed",
      ),
    [intents],
  );
  const cards = useMemo(
    () => hideHeldMergeSources(boardCards, heldMerges),
    [boardCards, heldMerges],
  );

  // The listeners of the store outlive a render, so they read the newest values from here.
  const latest = useRef({ boardCards, isBoardRead, moves, openTaskId, closePane });
  useLayoutEffect(() => {
    latest.current = { boardCards, isBoardRead, moves, openTaskId, closePane };
  });

  /** Runs `change` as one committed change that glides the board on `hand`. With no board on screen, just runs it. */
  const playBoardChange = (change: () => void): void => {
    const scroller = scrollRef.current;
    if (scroller === null) {
      change();
      return;
    }
    flipBoard(scroller, "hand", () => {
      flushSync(change);
    });
  };

  /**
   * Takes back the held merge `intentId`, while it is held, and plays the
   * merge backwards: the card comes out from under the card it merged into.
   * Rejects once the merge is on its way, which Undo can no longer stop.
   */
  const undoMerge = (
    intentId: string,
    sourceCardId: string,
    targetCardId: string,
  ): Promise<undefined> => {
    const scroller = scrollRef.current;
    const target = scroller?.querySelector<HTMLElement>(`[data-card-id="${targetCardId}"]`) ?? null;
    const from = target?.getBoundingClientRect() ?? null;
    let isUndone = false;
    playBoardChange(() => {
      isUndone = store.undo(intentId);
    });
    if (!isUndone) return Promise.reject(new Error("It was already sent."));
    const card = scroller?.querySelector<HTMLElement>(`[data-card-id="${sourceCardId}"]`);
    if (card != null && from !== null) playMergeOut(card, from, target);
    return Promise.resolve(undefined);
  };

  const holdMerge = (sourceCardId: string, targetCardId: string): boolean => {
    const source = boardCards.find((card) => card.id === sourceCardId);
    const target = boardCards.find((card) => card.id === targetCardId);
    if (source === undefined || target === undefined || source.id === target.id) return false;
    const intentId = store.hold({ kind: "merge", taskId: source.id, intoTaskId: target.id });
    if (openTaskId === source.id) closePane();
    const takeOffStack = moves.sayWithUndo(describeMergedInto(target.title), {
      words: describeMerge(source.title, target.title),
      undo: () => undoMerge(intentId, source.id, target.id),
    });
    // Once the merge is on its way, Undo can no longer stop it, so the gesture
    // leaves the stack and the next Undo reaches the gesture before it.
    const stopWatching = store.subscribe(() => {
      if (store.getSnapshot().find((intent) => intent.intentId === intentId)?.state === "pending") {
        return;
      }
      stopWatching();
      takeOffStack();
    });
    return true;
  };

  const mergeCard = (sourceCardId: string, targetCardId: string): void => {
    const scroller = scrollRef.current;
    // The card in the page is hidden by the change, so a copy of it slides in.
    const ghost = scroller === null ? null : launchLeavingCard(scroller, sourceCardId);
    let isHeld = false;
    playBoardChange(() => {
      isHeld = holdMerge(sourceCardId, targetCardId);
    });
    if (!isHeld) {
      if (ghost !== null) removeFlight(ghost);
      moves.sayWithoutUndo("A card left the board, so nothing was merged.");
    } else if (ghost !== null && scroller !== null) {
      playMergeIn(scroller, ghost, targetCardId);
    }
  };

  /**
   * Puts back the card of each merge that failed, says why on the undo line,
   * and forgets the merge. With `isPlayed`, the card comes out from under the
   * card it was merged into; the first report after a start has no motion,
   * because it runs where React cannot flush a change by itself. Does nothing
   * until the board is read, because the line names the card.
   */
  const reportFailedMerges = (isPlayed: boolean): void => {
    const { boardCards: shown, isBoardRead: isRead, moves: lines } = latest.current;
    if (!isRead) return;
    for (const intent of listFailedMerges(store.getSnapshot())) {
      const scroller = scrollRef.current;
      const target =
        scroller?.querySelector<HTMLElement>(`[data-card-id="${intent.intoTaskId}"]`) ?? null;
      const from = target?.getBoundingClientRect() ?? null;
      if (isPlayed) {
        playBoardChange(() => {
          store.discard(intent.intentId);
        });
        const card = scroller?.querySelector<HTMLElement>(`[data-card-id="${intent.taskId}"]`);
        if (card != null && from !== null) playMergeOut(card, from, target);
      } else {
        store.discard(intent.intentId);
      }
      const title = shown.find((each) => each.id === intent.taskId)?.title ?? "The card";
      lines.sayWithoutUndo(
        describeMergeFailure(title, intent.failure?.message ?? "It was not sent."),
      );
    }
  };
  const reportRef = useRef(reportFailedMerges);
  useLayoutEffect(() => {
    reportRef.current = reportFailedMerges;
  });
  useEffect(
    () =>
      store.subscribe(() => {
        reportRef.current(true);
      }),
    [store],
  );
  // A merge that failed while the app was closed is found once the board is read.
  useEffect(() => {
    reportRef.current(false);
  }, [isBoardRead]);

  return { cards, holdMerge, mergeCard };
};
