import { useEffect, useState, useSyncExternalStore } from "react";
import { createTypingGuard } from "@hercule/client-core";

/** What `useTypingGuard` returns: the guard's `holding` and the calls that move it. */
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
   * (`false`). The guard does not end its hold while one is open.
   */
  readonly reportComposing: (composing: boolean) => void;
}

/**
 * Returns the typing guard of this composer: it keeps a question from taking
 * the composer over while the user types a message, until they pause. The
 * rules live in client-core's `createTypingGuard`; this hook keeps one guard
 * for the life of the component, redraws it when the guard starts or stops
 * holding, and stops the guard's timer when the component goes away.
 */
export function useTypingGuard(): TypingGuard {
  const [guard] = useState(createTypingGuard);
  const holding = useSyncExternalStore(guard.subscribe, guard.isHolding);
  useEffect(() => guard.dispose, [guard]);
  return {
    holding,
    holdAfterEdit: guard.holdAfterEdit,
    release: guard.release,
    reportComposing: guard.reportComposing,
  };
}
