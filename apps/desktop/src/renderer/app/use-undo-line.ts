/**
 * The undo line at the foot of the Overview's pages: what it says, when it
 * goes, and what Undo says it did. Work and the Inbox share it, because they
 * share the undo stack (`undo-stack.ts`).
 */
import { useEffect, useState } from "react";
import type { UndoStack } from "./undo-stack";

/** How long the undo line stays after a move, and after a failure, which takes longer to read. */
const MOVE_LINE_MS = 5_200;
const FAILURE_LINE_MS = 8_000;

/** What the undo line shows: its text, whether it offers Undo, and whether it is in view. */
export interface UndoLineState {
  readonly text: string;
  readonly canUndo: boolean;
  readonly isShown: boolean;
  /** Rises on every new line, so the timer that hides the line starts again. */
  readonly serial: number;
}

const QUIET_LINE: UndoLineState = { text: "", canUndo: false, isShown: false, serial: 0 };

/** What `useUndoLine` returns. */
export interface UndoLineControls<Page> {
  readonly line: UndoLineState;
  /** Shows `text` on the line, with Undo when `canUndo` is true, and starts its timer again. */
  readonly say: (text: string, canUndo: boolean) => void;
  /**
   * Reverses the newest gesture of the stack, passing `page` to the gesture
   * (see `Gesture.undo`), and says what happened. An undo that is already
   * running makes this do nothing.
   */
  readonly undo: (page: Page) => void;
}

/**
 * Holds the undo line for `undoStack`. The line hides itself 5.2 seconds
 * after a gesture and 8 seconds after a failure, and starts again on every new
 * line.
 */
export function useUndoLine<Page>(undoStack: UndoStack<Page>): UndoLineControls<Page> {
  const [line, setLine] = useState<UndoLineState>(QUIET_LINE);

  const say = (text: string, canUndo: boolean): void => {
    setLine((before) => ({ text, canUndo, isShown: true, serial: before.serial + 1 }));
  };

  useEffect(() => {
    if (!line.isShown) return;
    const timer = setTimeout(
      () => {
        setLine((now) => (now.serial === line.serial ? { ...now, isShown: false } : now));
      },
      line.canUndo ? MOVE_LINE_MS : FAILURE_LINE_MS,
    );
    return () => {
      clearTimeout(timer);
    };
  }, [line.serial, line.isShown, line.canUndo]);

  const undo = (page: Page): void => {
    void undoStack.undo(page).then((outcome) => {
      switch (outcome.kind) {
        case "empty":
          say("Nothing to undo.", false);
          return;
        case "busy":
          return;
        case "reversed":
          say(
            `Put back: ${outcome.words}.${outcome.note === undefined ? "" : ` ${outcome.note}`}`,
            false,
          );
          return;
        case "failed":
          say(`Could not put back: ${outcome.words}. ${outcome.reason}`, false);
      }
    });
  };

  return { line, say, undo };
}
