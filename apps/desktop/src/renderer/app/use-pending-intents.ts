/**
 * How components reach the held intents (`pending-intents.ts`): a hook that
 * redraws when the store of the signed-in user changes, and the undo line that
 * shows a held intent.
 */
import { useSyncExternalStore } from "react";
import type { AccountScope } from "./account-scope";
import type { CardMover } from "./card-mover";
import type { IntentContent, PendingIntent, PendingIntents } from "./pending-intents";
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
}

/**
 * Holds `content` in `store` for the undo window, shows it on the undo line
 * with Undo, and takes the gesture off the undo stack once the intent leaves
 * `pending`: from then on Undo can no longer stop it, so the next Undo must
 * reach the gesture before it. Returns the held intent's id.
 */
export const holdWithUndo = (
  store: PendingIntents,
  content: IntentContent,
  { sayWithUndo, line, words, undo }: UndoLineForIntent,
): string => {
  const intentId = store.hold(content);
  const takeOffStack = sayWithUndo(line, {
    words,
    undo:
      undo === undefined
        ? () =>
            store.undo(intentId)
              ? Promise.resolve(undefined)
              : Promise.reject(new Error("It was already sent."))
        : () => undo(intentId),
  });
  const stopWatching = store.subscribe(() => {
    if (store.getSnapshot().find((intent) => intent.intentId === intentId)?.state === "pending") {
      return;
    }
    stopWatching();
    takeOffStack();
  });
  return intentId;
};
