import type { JSX, ReactNode } from "react";
import "./machine-activity.css";

/**
 * Renders a quiet line under or in place of the entries, such as "Reading
 * older activity…". With `onRetry`, the line is an alert about a failed read,
 * with a Retry button. With `onReadOlder`, it ends in a "Read older" button.
 */
export function MachineActivityNote({
  children,
  onRetry,
  onReadOlder,
}: {
  readonly children: ReactNode;
  readonly onRetry: (() => void) | undefined;
  readonly onReadOlder?: (() => void) | undefined;
}): JSX.Element {
  if (onReadOlder !== undefined) {
    return (
      <p className="machine-activity-note">
        <span>{children}</span>
        <button type="button" className="btn btn--sm btn--quiet" onClick={onReadOlder}>
          Read older
        </button>
      </p>
    );
  }
  return onRetry === undefined ? (
    <p className="machine-activity-note">{children}</p>
  ) : (
    <p className="machine-activity-note" role="alert">
      <span>{children}</span>
      <button type="button" className="btn btn--sm btn--quiet" onClick={onRetry}>
        Retry
      </button>
    </p>
  );
}
