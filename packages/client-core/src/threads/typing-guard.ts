import { TYPING_PAUSE_MS } from "./question-composer";

/**
 * Keeps a question from taking the composer over while the user is typing a
 * message in it. See `createTypingGuard`.
 */
export interface TypingGuard {
  /** Returns whether the guard holds, which keeps a question from taking the composer over. */
  readonly isHolding: () => boolean;
  /**
   * Holds the guard, or keeps holding it, for another `TYPING_PAUSE_MS`. Call
   * it when the user edits the message in the composer.
   */
  readonly holdAfterEdit: () => void;
  /**
   * Ends the hold at once. Call it when the user tries to send the message
   * (also when the send then fails), and when the message field loses the
   * focus. Does nothing while an IME composition is open.
   */
  readonly release: () => void;
  /**
   * Tells the guard that an IME composition starts (`true`) or ends
   * (`false`). The start also holds the guard, so a question cannot take the
   * composer over between the start of the composition and its first edit.
   * The guard does not end its hold while a composition is open, because the
   * user is still typing even when no key arrives. When one ends, a pause
   * starts counting.
   */
  readonly reportComposing: (composing: boolean) => void;
  /**
   * Registers `listener`, which is called each time `isHolding` changes, and
   * returns the function that removes it.
   */
  readonly subscribe: (listener: () => void) => () => void;
  /** Stops the pause timer. Call it when the composer goes away. */
  readonly dispose: () => void;
}

/**
 * Creates a guard that holds from a user's edit of the message until
 * `TYPING_PAUSE_MS` pass without another, or until `release` is called.
 * While it holds, the composer stays a message composer.
 *
 * The guard has one timeout. Only an edit and the end of a composition start
 * it, so an idle composer runs nothing. Listeners are called only when
 * `isHolding` changes, not on every edit.
 *
 * The guard knows nothing of React: the web app and the desktop app each
 * wrap it in a hook.
 */
export const createTypingGuard = (): TypingGuard => {
  let holding = false;
  let composing = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();

  const stopTimeout = (): void => {
    clearTimeout(timeout);
    timeout = undefined;
  };
  const setHolding = (next: boolean): void => {
    if (holding === next) return;
    holding = next;
    for (const listener of [...listeners]) listener();
  };
  const release = (): void => {
    if (composing) return;
    stopTimeout();
    setHolding(false);
  };
  const startTimeout = (): void => {
    stopTimeout();
    if (!composing) timeout = setTimeout(release, TYPING_PAUSE_MS);
  };

  return {
    isHolding: () => holding,
    holdAfterEdit: () => {
      setHolding(true);
      startTimeout();
    },
    release,
    reportComposing: (next) => {
      composing = next;
      if (next) {
        // No timer runs while a composition is open: it restarts when it ends.
        stopTimeout();
        setHolding(true);
      } else if (holding) {
        // A composition can end without an edit, such as one the user cancels.
        startTimeout();
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: stopTimeout,
  };
};
