import type { RefObject } from "react";
import type { WorkBoard } from "@hercule/contract";
import { useBoardReads } from "./use-board-reads";
import { usePausePawsOffScreen } from "./use-pause-paws";
import { useViewMotion } from "./use-view-motion";
import type { WorkView } from "./use-work-view";

/** What the Work screen draws and calls once the board's motion is in place. */
export interface BoardMotion {
  /** The board to draw: `board` without the changes that wait for a still hand. */
  readonly board: WorkBoard | undefined;
  /** `view` with each change the user makes played as motion. Call its functions from events. */
  readonly view: WorkView;
  /** What the board did by itself last, for the toolbar's line, or `null`. */
  readonly note: string | null;
  /** Tells the board that the user added the Task `taskId`, so its card fades in at once. */
  readonly noteAddedTask: (taskId: string) => void;
}

/**
 * Gives the Work board its motion (MOTION.md, Overview and Work), except
 * carrying a card and the switch between views.
 *
 * - What the user does to the view (fold, open "13 more", filter, Find) plays
 *   as one change on `travel` (`useViewMotion`).
 * - What a read brings (a Task arriving, a run failing, any other change)
 *   plays on `self`, and waits for a still hand where it could move what the
 *   user is reading (`useBoardReads`).
 * - A working colleague whose card is scrolled out of view stops tapping
 *   (`usePausePawsOffScreen`).
 *
 * `board` is the board with the user's pending moves applied, `serverBoard`
 * the board as the last read gave it, and `view` the view the screen holds.
 * At rest nothing runs: no timer, no frame and no listener beyond one
 * observer on the desk's carry mark.
 */
export const useBoardMotion = ({
  board,
  serverBoard,
  view,
  scrollRef,
}: {
  readonly board: WorkBoard | undefined;
  readonly serverBoard: WorkBoard | undefined;
  readonly view: WorkView;
  readonly scrollRef: RefObject<HTMLDivElement | null>;
}): BoardMotion => {
  const reads = useBoardReads({ board, serverBoard, scrollRef });
  const animatedView = useViewMotion(view, scrollRef);
  usePausePawsOffScreen(scrollRef);
  return {
    board: reads.board,
    view: animatedView,
    note: reads.note,
    noteAddedTask: reads.noteAddedTask,
  };
};
