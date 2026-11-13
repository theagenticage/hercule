/**
 * How components reach the held intents (`pending-intents.ts`): a hook that
 * redraws when the store of the signed-in user changes, and the undo line that
 * shows a held intent.
 */
import { useSyncExternalStore } from "react";
import type { AccountScope } from "./account-scope";
import type { CardMover } from "./card-mover";
import type {
  IntentContent,
  IntentProgress,
  PendingIntent,
  PendingIntents,
} from "./pending-intents";
import type { Gesture } from "./undo-stack";

/** What `usePendingIntents` returns. */
export interface HeldIntents {
  /** The store, to hold, undo, retry and discard intents. */
  readonly store: PendingIntents;
  /** The intents the store holds now, oldest first. */
  readonly intents: readonly PendingIntent[];
}

/**
 * Returns the store of pending intents of `scope`, and the intents it holds,
 * and redraws the caller when they change. The store lives in the scope, not
 * in the component, so an intent goes on when the user leaves the screen that
 * made it.
 */
export const usePendingIntents = (scope: AccountScope): HeldIntents => {
  const store = scope.pendingIntents;
  const intents = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { store, intents };
};

/** What the undo line shows for an intent held with `holdWithUndo`. */
interface UndoLineForIntent {
  /**
   * Shows `text` on the undo line with Undo, and puts `gesture` on the undo
   * stack. Returns a function that takes it off again.
   */
  readonly sayWithUndo: (text: string, gesture: Gesture<CardMover>) => () => void;
  /** What the undo line says, in the past tense like a move. */
  readonly line: string;
  /** What the gesture is called on the undo stack and in the keys' help. */
  readonly words: string;
  /**
   * Takes the held intent `intentId` back when the user presses Undo. Rejects
   * when it can no longer be taken back. Without it, Undo cancels the held
   * intent, and rejects with "It was already sent." once it is on its way.
   */
  readonly undo?: (intentId: string) => Promise<undefined>;
  /**
   * What the line says while the intent is past its window but the user holds
   * the line, so the intent waits. Without it, the line keeps its words.
   */
  readonly overdueLine?: string;
  /** What Undo answers after it cancelled the held intent. Without it, the line says "Put back: <words>.". */
  readonly cancelledText?: string;
  /**
   * Keeps the gesture on the undo stack once the intent is on its way, so the
   * next Undo reaches it and answers `text` (which says it cannot be taken
   * back) instead of reversing an older gesture. The undo line stays up
   * while the intent waits and sends, then says `sentLine` without Undo.
   * Without `afterSending`, the gesture leaves the stack when the intent
   * starts `sending`, and the line runs on its own timer.
   */
  readonly afterSending?: {
    /** What Undo answers once the send is confirmed. */
    readonly text: string;
    /** What Undo answers while the send is under way and delivery is not confirmed. */
    readonly sendingText: string;
    readonly sentLine: string;
  };
}

/**
 * Holds `content` in `store` for its undo window, shows it on the undo line
 * with Undo, and takes the gesture off the undo stack once Undo can no longer
 * stop the intent (it started `sending`) or it ended `failed`: the next Undo
 * must reach the gesture before it. With `afterSending`, the gesture stays
 * after a send, and leaves only when the send fails or Undo has answered.
 * Returns the held intent's id.
 */
export const holdWithUndo = (
  store: PendingIntents,
  content: IntentContent,
  { sayWithUndo, line, words, undo, cancelledText, overdueLine, afterSending }: UndoLineForIntent,
): string => {
  const intentId = store.hold(content);
  // Ends the gesture's `settled` promise: the watch below calls it when the intent is sent, cancelled or fails.
  let settle: (sentLine: string | undefined) => void = () => undefined;
  const settled =
    afterSending === undefined
      ? undefined
      : new Promise<string | undefined>((resolve) => {
          settle = resolve;
        });
  let markOverdue: (waitingLine: string) => void = () => undefined;
  const overdue =
    overdueLine === undefined
      ? undefined
      : new Promise<string>((resolve) => {
          markOverdue = resolve;
        });
  let progress: IntentProgress | "pending" = "pending";
  const takeOffStack = sayWithUndo(line, {
    words,
    // The line is held while the user is on it: the intent waits past its window.
    hold: (isHeld) => {
      store.setHeld(intentId, isHeld);
    },
    ...(settled === undefined ? {} : { settled }),
    ...(overdue === undefined ? {} : { overdue }),
    undo: () => {
      if (undo !== undefined) return undo(intentId);
      if (store.undo(intentId)) {
        return Promise.resolve(cancelledText === undefined ? undefined : { text: cancelledText });
      }
      if (afterSending === undefined) return Promise.reject(new Error("It was already sent."));
      // While sending, delivery is unconfirmed: say so and leave the reply box alone.
      if (progress === "sending") return Promise.resolve({ text: afterSending.sendingText });
      return Promise.resolve({ text: afterSending.text });
    },
  });
  const stopWatching = store.watch(intentId, (reported) => {
    if (reported === "overdue") {
      if (overdueLine !== undefined) markOverdue(overdueLine);
      return;
    }
    progress = reported;
    if (afterSending !== undefined && reported === "sending") return;
    settle(reported === "sent" ? afterSending?.sentLine : undefined);
    if (afterSending !== undefined && reported === "sent") return;
    stopWatching();
    takeOffStack();
  });
  return intentId;
};
