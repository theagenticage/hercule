/**
 * The one hook that owns the logical board of the Work screen
 * (`buildLogicalBoard`): the board as read, with the user's pending card
 * moves, the answers held for the undo line and the merges held for the undo
 * line already on it.
 *
 * Two boards exist on the screen, and the names keep them apart:
 *
 * - The logical board is what is true now. Every action reads it: a drop,
 *   Done and Drop, a merge, a move by key, the lookup of a failed card, the
 *   details pane.
 * - The drawn board (`useBoardReads`) is the logical board with the changes
 *   nobody here caused held back until the hand is still. Only what is drawn
 *   reads it: the lanes, the Filter, Find and the counts.
 */
import { useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@hercule/client-core";
import { buildLogicalBoard, type PendingBoardChanges } from "@hercule/client-core/work";
import type { WorkBoard } from "@hercule/contract";
import type { AccountScope } from "../../../app/account-scope";
import { listHeldAnswers, listHeldMerges, type PendingIntent } from "../../../app/pending-intents";
import { usePendingIntents } from "../../../app/use-pending-intents";

const NOTHING_HIDDEN: ReadonlySet<string> = new Set();

/** What `useLogicalBoard` returns. */
export interface LogicalBoardState {
  /** The logical board, or `undefined` until the first read ends. */
  readonly board: WorkBoard | undefined;
  /** The Tasks the logical board leaves out on purpose (see `LogicalBoard.hiddenIds`). */
  readonly hiddenIds: ReadonlySet<string>;
  /**
   * Returns the logical board as it is this instant, built from the cached
   * board and the stores, not from the last render. A gesture calls it, so
   * two gestures before one render see each other's effect. `undefined`
   * until the first read ends.
   */
  readonly readBoardNow: () => WorkBoard | undefined;
}

/**
 * Returns the logical board for `serverBoard`, the board as the last read gave
 * it. The pending card moves belong to the controller (they outlive the
 * screen), the held answers and merges to the user's store of pending intents.
 */
export const useLogicalBoard = ({
  scope,
  serverBoard,
}: {
  readonly scope: AccountScope;
  readonly serverBoard: WorkBoard | undefined;
}): LogicalBoardState => {
  const queryClient = useQueryClient();
  const { pendingCardMoves } = scope;
  const { store, intents } = usePendingIntents(scope);
  const moves = useSyncExternalStore(pendingCardMoves.subscribe, pendingCardMoves.getSnapshot);

  const logical =
    serverBoard === undefined
      ? undefined
      : buildLogicalBoard(
          serverBoard,
          readPendingChanges(
            moves.map((each) => each.change),
            intents,
          ),
        );

  return {
    board: logical?.board,
    hiddenIds: logical?.hiddenIds ?? NOTHING_HIDDEN,
    readBoardNow: () => {
      const cached = queryClient.getQueryData<WorkBoard>(queryKeys.workBoard());
      return cached === undefined
        ? undefined
        : buildLogicalBoard(
            cached,
            readPendingChanges(
              pendingCardMoves.getSnapshot().map((each) => each.change),
              store.getSnapshot(),
            ),
          ).board;
    },
  };
};

/** Returns the pending changes of the board: the card changes, and the answers and merges `intents` hold. */
const readPendingChanges = (
  changes: PendingBoardChanges["changes"],
  intents: readonly PendingIntent[],
): PendingBoardChanges => ({
  changes,
  heldAnswers: listHeldAnswers(intents),
  heldMerges: listHeldMerges(intents),
});
