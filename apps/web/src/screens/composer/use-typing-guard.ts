import { useEffect, useRef, useState } from "react";
import { TYPING_PAUSE_MS } from "@hercule/client-core";

/** What `useTypingGuard` returns. */
export interface TypingGuard {
  /** Whether the guard holds, which keeps a question from taking the composer over. */
  readonly holding: boolean;
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
   * (`false`). The guard does not end its hold while one is open, because the
   * user is still typing even when no key arrives. When one ends, a pause
   * starts counting.
   */
  readonly reportComposing: (composing: boolean) => void;
}

/**
 * Keeps a question from taking the composer over while the user is typing a
 * message in it. The guard holds from a user's edit of the message until
 * `TYPING_PAUSE_MS` pass without another, or until `release` is called.
 * While it holds, the composer stays a message composer.
 *
 * The one timeout is started by an edit and by the end of a composition,
 * never by anything else, so an idle composer runs nothing.
 */
export function useTypingGuard(): TypingGuard {
  const [holding, setHolding] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The state above is for drawing. These two are what the timeout and the
  // callbacks read, so they never see an old render's value.
  const holdingRef = useRef(false);
  const composingRef = useRef(false);

  const stopTimeout = (): void => {
    clearTimeout(timeoutRef.current);
    timeoutRef.current = undefined;
  };
  const release = (): void => {
    if (composingRef.current) return;
    stopTimeout();
    holdingRef.current = false;
    setHolding(false);
  };
  const startTimeout = (): void => {
    stopTimeout();
    timeoutRef.current = setTimeout(release, TYPING_PAUSE_MS);
  };

  useEffect(() => stopTimeout, []);

  return {
    holding,
    holdAfterEdit: () => {
      holdingRef.current = true;
      setHolding(true);
      startTimeout();
    },
    release,
    reportComposing: (composing) => {
      composingRef.current = composing;
      // A composition can end without an edit, such as one the user cancels.
      if (!composing && holdingRef.current) startTimeout();
    },
  };
}
