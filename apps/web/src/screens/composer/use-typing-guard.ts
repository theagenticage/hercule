import { useEffect, useState, useSyncExternalStore } from "react";
import { createTypingGuard } from "@hercule/client-core";

/** What `useTypingGuard` returns: the guard of `createTypingGuard`, with its state as a value to draw. */
export interface TypingGuardState {
  /** Whether the guard holds, which keeps a question from taking the composer over. */
  readonly holding: boolean;
  /** Holds the guard, or keeps holding it, for another `TYPING_PAUSE_MS`. Call it when the user edits the message. */
  readonly holdAfterEdit: () => void;
  /**
   * Ends the hold at once. Call it when the user tries to send the message
   * (also when the send then fails), and when the message field loses the
   * focus. Does nothing while an IME composition is open.
   */
  readonly release: () => void;
  /** Tells the guard that an IME composition starts (`true`) or ends (`false`). */
  readonly reportComposing: (composing: boolean) => void;
}

/**
 * Returns the typing guard of the component that calls it, see
 * `createTypingGuard` for the rules. The component re-renders when `holding`
 * changes, and the guard stops its timer when the component unmounts.
 */
export function useTypingGuard(): TypingGuardState {
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
