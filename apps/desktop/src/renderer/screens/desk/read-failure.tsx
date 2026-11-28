import type { JSX } from "react";
import "./read-failure.css";

/**
 * Renders a read that failed: `what` could not be read, `reason` says why,
 * and a button reads it again with `onRetry`. It is an alert, so a screen
 * reader says it when it appears. The page that draws it sets the space
 * around it.
 */
export function ReadFailure({
  what,
  reason,
  onRetry,
}: {
  readonly what: string;
  readonly reason: string;
  readonly onRetry: () => void;
}): JSX.Element {
  return (
    <p className="desk-note" role="alert">
      {what} could not be read: {reason}
      <button type="button" onClick={onRetry}>
        Try again
      </button>
    </p>
  );
}
