/**
 * The undo line at the foot of the Overview's pages: what it says, when it
 * goes, and what Undo says it did. Work and the Inbox share it, because they
 * share the undo stack (`undo-stack.ts`).
 */
import { useEffect, useState } from "react";
import type { Gesture, UndoStack } from "./undo-stack";

/** How long the undo line stays after a move, and after a failure, which takes longer to read. */
const MOVE_LINE_MS = 5_200;
const FAILURE_LINE_MS = 8_000;

/** What the undo line shows: its text, whether it offers Undo, and whether it is in view. */
export interface UndoLineState {
  readonly text: string;
  /**
   * Whether the line offers Undo: true only while the gesture the line was
   * shown for is still on the undo stack. A gesture can leave the stack before
   * the line hides (an intent that was sent), and Undo would then reverse an
   * older gesture that has nothing to do with the line.
   */
  readonly canUndo: boolean;
  readonly isShown: boolean;
  /** Rises on every new line, so the timer that hides the line starts again. */
  readonly serial: number;
}

/** The line as the hook keeps it: `offered` is the gesture whose Undo the line shows, if any. */
interface HeldLine<Page> {
  readonly text: string;
  readonly offered: Gesture<Page> | null;
  readonly isShown: boolean;
  readonly serial: number;
  /** How long the line stays, fixed when it is said: a withdrawn gesture does not restart the timer. */
  readonly staysMs: number;
}

/** What `useUndoLine` returns. */
export interface UndoLineControls<Page> {
  readonly line: UndoLineState;
  /**
   * Shows `text` on the line and starts its timer again. With `offered`, the
   * line shows Undo for as long as that gesture is on the undo stack. Without
   * it, the line has no Undo.
   */
  readonly say: (text: string, offered?: Gesture<Page>) => void;
  /**
   * Takes `gesture` off the undo stack, for a gesture that cannot be undone
   * any more. When the line offers it, Undo goes from the line at once.
   */
  readonly withdraw: (gesture: Gesture<Page>) => void;
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
  const [held, setHeld] = useState<HeldLine<Page>>({
    text: "",
    offered: null,
    isShown: false,
    serial: 0,
    staysMs: FAILURE_LINE_MS,
  });
  const line: UndoLineState = {
    text: held.text,
    canUndo: held.offered !== null,
    isShown: held.isShown,
    serial: held.serial,
  };

  const say = (text: string, offeredGesture?: Gesture<Page>): void => {
    setHeld((before) => ({
      text,
      offered: offeredGesture ?? null,
      isShown: true,
      serial: before.serial + 1,
      staysMs: offeredGesture === undefined ? FAILURE_LINE_MS : MOVE_LINE_MS,
    }));
  };

  const withdraw = (gesture: Gesture<Page>): void => {
    undoStack.remove(gesture);
    // The stack is asked inside the update, not while rendering: the React
    // Compiler caches a render by its inputs and cannot see the stack change.
    setHeld((before) =>
      before.offered !== null && !undoStack.holds(before.offered)
        ? { ...before, offered: null }
        : before,
    );
  };

  useEffect(() => {
    if (!held.isShown) return;
    const timer = setTimeout(() => {
      setHeld((now) => (now.serial === held.serial ? { ...now, isShown: false } : now));
    }, held.staysMs);
    return () => {
      clearTimeout(timer);
    };
  }, [held.serial, held.isShown, held.staysMs]);

  const undo = (page: Page): void => {
    void undoStack.undo(page).then((outcome) => {
      switch (outcome.kind) {
        case "empty":
          say("Nothing to undo.");
          return;
        case "busy":
          return;
        case "reversed":
          say(`Put back: ${outcome.words}.${outcome.note === undefined ? "" : ` ${outcome.note}`}`);
          return;
        case "failed":
          say(`Could not put back: ${outcome.words}. ${outcome.reason}`);
      }
    });
  };

  return { line, say, withdraw, undo };
}
