import type { QueryClient } from "@tanstack/react-query";
import { queryKeys, type HerculeClient } from "@hercule/client-core";
import { applyInboxEdit, type InboxEdit } from "@hercule/client-core/inbox";
import { applyCardMove, buildRestoreMove, type CardPlacement } from "@hercule/client-core/work";
import type { Inbox, WorkBoard } from "@hercule/contract";

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
   * Shows `edit` on the Inbox as the screen that is open draws it, and writes
   * it into the cached Inbox. Resolves when it is written. A screen that is
   * not the Inbox writes the cache alone, and the Inbox shows it when it opens.
   */
  readonly writeInboxEdit: (edit: InboxEdit) => Promise<void>;
}

/**
 * Returns the way a screen that does not draw the Inbox writes an Inbox edit:
 * into the cached Inbox alone. The Inbox reads the cache when it opens. A read
 * of the Inbox that is running is cancelled first, because it could end after
 * the edit and put the card back.
 */
export const buildCachedInboxWriter =
  (queryClient: QueryClient): CardMover["writeInboxEdit"] =>
  async (edit) => {
    if (queryClient.getQueryData(queryKeys.inbox()) === undefined) return;
    await queryClient.cancelQueries({ queryKey: queryKeys.inbox() });
    queryClient.setQueryData<Inbox>(queryKeys.inbox(), (cached) =>
      cached === undefined ? undefined : applyInboxEdit(cached, edit),
    );
  };

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
      await queryClient.cancelQueries({ queryKey: queryKeys.workBoard() });
      queryClient.setQueryData<WorkBoard>(queryKeys.workBoard(), (cached) =>
        cached === undefined ? undefined : applyCardMove(cached, restore.move),
      );
    })();
    return { isExact: restore.exact, request };
  };
