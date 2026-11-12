/**
 * The undo line at the foot of the Overview's pages: what it says, when it
 * goes, and what Undo says it did. Work and the Inbox share it, because they
 * share the undo stack (`undo-stack.ts`).
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Gesture, UndoAction, UndoStack } from "./undo-stack";

/** How long the undo line stays after a move, and after a failure, which takes longer to read. */
const MOVE_LINE_MS = 5_200;
const FAILURE_LINE_MS = 8_000;
/** How long a line held under the pointer or the focus stays after both leave it. */
const RELEASED_LINE_MS = 3_000;

/**
 * Whether the user is on the line: `held` while the pointer or the focus is on
 * it (the line stays), `released` after both left it (the line goes 3 seconds
 * later), `free` otherwise (the line's own time runs).
 */
type Hold = "free" | "held" | "released";

/** What the undo line shows: its text, whether it offers Undo, and whether it is in view. */
export interface UndoLineState {
  readonly text: string;
  /**
   * Whether the line offers Undo: true only while the gesture the line was
   * shown for is still on the undo stack. A gesture can leave the stack before
   * the line hides (a request that changed nothing), and Undo would then
   * reverse an older gesture that has nothing to do with the line.
   */
  readonly canUndo: boolean;
  /** A second button beside Undo, such as "See its Task", or `null` for none. */
  readonly action: UndoAction | null;
  /** The title of the thing the line is about, which the line puts last, or `null` for none. */
  readonly title: string | null;
  readonly isShown: boolean;
  /** Whether the pointer or the focus is on the line, which keeps it from hiding. */
  readonly isHeld: boolean;
  /** Rises on every new line, so the timer that hides the line starts again. */
  readonly serial: number;
}

/** The line as the hook keeps it: `offered` is the gesture whose Undo the line shows, if any. */
interface HeldLine<Page> {
  readonly text: string;
  readonly offered: Gesture<Page> | null;
  readonly action: UndoAction | null;
  readonly title: string | null;
  readonly isShown: boolean;
  readonly serial: number;
  readonly hold: Hold;
  /** How long the line stays, fixed when it is said: a withdrawn gesture does not restart the timer. */
  readonly staysMs: number;
}

/** What `useUndoLine` returns. */
export interface UndoLineControls<Page> {
  readonly line: UndoLineState;
  /**
   * Shows `text` on the line and starts its timer again. With `offered`, the
   * line shows Undo for as long as that gesture is on the undo stack. Without
   * it, the line has no Undo. With `action`, the line shows that button too.
   * With `title`, the line shows the title of the thing last, and cuts it
   * first when the line is too narrow (see `UndoLine`).
   */
  readonly say: (
    text: string,
    offered?: Gesture<Page>,
    action?: UndoAction,
    title?: string,
  ) => void;
  /**
   * Takes `gesture` off the undo stack, for a gesture that cannot be undone
   * any more. When the line offers it, Undo goes from the line at once.
   */
  readonly withdraw: (gesture: Gesture<Page>) => void;
  /**
   * Tells the line whether the pointer or the focus is on it. While it is,
   * the line does not hide, also when a new line replaces its words. It hides 3
   * seconds after both leave. A page whose line does not wait for the user
   * never calls this.
   */
  readonly hold: (isHeld: boolean) => void;
  /**
   * Reverses the newest gesture of the stack and says what happened on this
   * line. The key and the line's button both come here, through the stack. An
   * undo that is already running makes this do nothing.
   */
  readonly undo: () => void;
}

/**
 * Holds the undo line for `undoStack`, for as long as the page that calls it
 * is mounted. The line hides itself 5.2 seconds after a gesture and 8 seconds
 * after a failure, and starts again on every new line. A page that calls
 * `hold` keeps the line while the user is on it, and it goes 3 seconds after
 * the user leaves.
 *
 * While the page is mounted it is the stack's page (`UndoStack.registerPage`):
 * every Undo, from the Undo key or from the line's button, is drawn by this
 * page and said on this line.
 *
 * `buildPage` returns what this page lends to a gesture when it is undone (see
 * `Gesture.undo`). It is called when Undo is pressed, so it may use the
 * newest state of the page. `isPaused` returns whether Undo must wait, such as
 * while a card is in the hand of a drag (see `UndoAdapter.isPaused`).
 */
export function useUndoLine<Page>(
  undoStack: UndoStack<Page>,
  buildPage: () => Page,
  isPaused: () => boolean = () => false,
): UndoLineControls<Page> {
  const [held, setHeld] = useState<HeldLine<Page>>({
    text: "",
    offered: null,
    action: null,
    title: null,
    isShown: false,
    serial: 0,
    hold: "free",
    staysMs: FAILURE_LINE_MS,
  });
  const line: UndoLineState = {
    text: held.text,
    canUndo: held.offered !== null,
    action: held.action,
    title: held.title,
    isShown: held.isShown,
    isHeld: held.hold === "held",
    serial: held.serial,
  };

  const say = (
    text: string,
    offeredGesture?: Gesture<Page>,
    action?: UndoAction,
    title?: string,
  ): void => {
    setHeld((before) => ({
      text,
      offered: offeredGesture ?? null,
      action: action ?? null,
      title: title ?? null,
      isShown: true,
      serial: before.serial + 1,
      hold: before.hold === "held" ? "held" : "free",
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

  const hold = (isHeld: boolean): void => {
    setHeld((before) => {
      if (isHeld) return before.hold === "held" ? before : { ...before, hold: "held" };
      return before.hold === "held" ? { ...before, hold: "released" } : before;
    });
  };

  useEffect(() => {
    if (!held.isShown || held.hold === "held") return;
    const stays = held.hold === "released" ? RELEASED_LINE_MS : held.staysMs;
    const timer = setTimeout(() => {
      setHeld((now) => (now.serial === held.serial ? { ...now, isShown: false } : now));
    }, stays);
    return () => {
      clearTimeout(timer);
    };
  }, [held.serial, held.isShown, held.staysMs, held.hold]);

  // The newest state of the page, so a later render is what Undo uses.
  const latest = useRef({ buildPage, isPaused, say });
  useLayoutEffect(() => {
    latest.current = { buildPage, isPaused, say };
  });
  useEffect(
    () =>
      undoStack.registerPage({
        buildPage: () => latest.current.buildPage(),
        isPaused: () => latest.current.isPaused(),
        report: (report) => {
          latest.current.say(report.text, undefined, report.action);
        },
      }),
    [undoStack],
  );

  const undo = (): void => {
    void undoStack.undo();
  };

  return { line, say, withdraw, hold, undo };
}
