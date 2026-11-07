import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { queryKeys, type HerculeClient } from "@hercule/client-core";
import { applyInboxEdit, type InboxEdit } from "@hercule/client-core/inbox";
import {
  applyCardMove,
  applyCardReturn,
  buildMoveToPlacement,
  buildRestoreMove,
  type CardPlacement,
  type EndStage,
} from "@hercule/client-core/work";
import type { Inbox, WorkBoard, WorkCard } from "@hercule/contract";

/** A card being put back: whether it went exactly where it was, and the request that moves it. */
export interface PutBackRequest {
  readonly isExact: boolean;
  readonly request: Promise<unknown>;
}

/**
 * What the screen that is open lends to a gesture on the undo stack, so that
 * Undo shows its change through that screen's own list of pending changes. A
 * gesture outlives the screen that made it: leaving Work and coming back
 * opens a new screen with a new list. Work and the Inbox share the stack, so
 * each lends what the other's gestures need.
 */
export interface CardMover {
  /**
   * Shows the card back at `place`, as Undo does, and queues the move. The
   * move is sent only if `isUndoWanted` resolves to true, which it does when
   * the gesture being undone was saved: a gesture that was refused changed
   * nothing, and the card may since have been moved by another client.
   * Returns `undefined` when the card is no longer on the board.
   */
  readonly putCardBack: (
    place: CardPlacement,
    isUndoWanted: Promise<boolean>,
  ) => PutBackRequest | undefined;
  /**
   * Shows `card`, a card that ended at `stage` (Done or Dropped), back at
   * `place`, and queues the move that takes the Task out of its end. The move
   * is sent only if `isUndoWanted` resolves to true. Returns `undefined` when
   * the card is on the board already.
   */
  readonly putEndedCardBack: (
    card: WorkCard,
    place: CardPlacement,
    stage: EndStage,
    isUndoWanted: Promise<boolean>,
  ) => PutBackRequest | undefined;
  /**
   * Shows `edit` on the Inbox as the screen that is open draws it, and writes
   * it into the cached Inbox. Resolves when it is written. A screen that is
   * not the Inbox writes the cache alone, and the Inbox shows it when it opens.
   */
  readonly writeInboxEdit: (edit: InboxEdit) => Promise<void>;
}

/**
 * Writes a change the controller has answered into the read cached under
 * `queryKey`, then marks that read out of date so that it is read again.
 * Does nothing when no read is cached.
 *
 * - A read that is running is cancelled first, because it started before the
 *   answer and could end after the change, putting back what the change took
 *   away.
 * - Cancelling also drops the one read that may have seen the answer: the
 *   controller pushes its change before the reply arrives, and that push
 *   starts a read. The read made after the change is written is the only one
 *   that is sure to be authoritative, so it is asked for here and does not
 *   depend on a push that may already have come.
 */
export const writeAnsweredChange = async <Read>(
  queryClient: QueryClient,
  queryKey: QueryKey,
  change: (cached: Read) => Read,
): Promise<void> => {
  if (queryClient.getQueryData(queryKey) === undefined) return;
  await queryClient.cancelQueries({ queryKey });
  queryClient.setQueryData<Read>(queryKey, (cached) =>
    cached === undefined ? undefined : change(cached),
  );
  // Not awaited: the read can be slow, and the caller only needs the change written.
  void queryClient.invalidateQueries({ queryKey });
};

/**
 * Returns the way to write an Inbox edit into the cached Inbox alone, which a
 * screen that does not draw the Inbox uses, and which the Inbox uses to settle
 * an edit the controller answered. The Inbox reads the cache when it opens.
 * See `writeAnsweredChange` for how the cache is written.
 */
export const buildCachedInboxWriter =
  (queryClient: QueryClient): CardMover["writeInboxEdit"] =>
  (edit) =>
    writeAnsweredChange<Inbox>(queryClient, queryKeys.inbox(), (cached) =>
      applyInboxEdit(cached, edit),
    );

/**
 * Returns the way a screen that does not draw the Work board puts a card
 * back: the move is sent at once and written into the cached board, which
 * Work reads when it opens. Returns `undefined` for a card when no board is
 * cached, because the place it came from cannot be worked out.
 */
export const buildCachedCardMover =
  (client: HerculeClient, queryClient: QueryClient): CardMover["putCardBack"] =>
  (place, isUndoWanted) => {
    const board = queryClient.getQueryData<WorkBoard>(queryKeys.workBoard());
    const restore = board === undefined ? undefined : buildRestoreMove(board, place);
    if (restore === undefined) return undefined;
    const { taskId, ...target } = restore.move;
    const request = (async () => {
      // A gesture that was refused changed nothing, so there is nothing to put back.
      if (!(await isUndoWanted)) return;
      await client.task.move({ params: { id: taskId }, payload: target });
      await writeAnsweredChange<WorkBoard>(queryClient, queryKeys.workBoard(), (cached) =>
        applyCardMove(cached, restore.move),
      );
    })();
    return { isExact: restore.exact, request };
  };

/**
 * Returns the way a screen that does not draw the Work board puts a card that
 * ended (Done or Dropped) back: the move is sent at once and the card is
 * written into the cached board, which Work reads when it opens. Returns
 * `undefined` when no board is cached, or when the card is on it already.
 */
export const buildCachedEndedCardMover =
  (client: HerculeClient, queryClient: QueryClient): CardMover["putEndedCardBack"] =>
  (card, place, _stage, isUndoWanted) => {
    const board = queryClient.getQueryData<WorkBoard>(queryKeys.workBoard());
    if (board === undefined || board.cards.some((each) => each.id === card.id)) return undefined;
    const restore = buildMoveToPlacement(board, place);
    const { taskId, ...target } = restore.move;
    const request = (async () => {
      if (!(await isUndoWanted)) return;
      await client.task.move({ params: { id: taskId }, payload: target });
      await writeAnsweredChange<WorkBoard>(queryClient, queryKeys.workBoard(), (cached) =>
        applyCardReturn(cached, card, restore.move),
      );
    })();
    return { isExact: restore.exact, request };
  };
