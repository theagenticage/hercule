import { useState, type JSX } from "react";
import { flushSync } from "react-dom";
import { Button } from "@hercule/ui";

/**
 * A confirmation question with two buttons, shown inline next to the control
 * that asked it. The app asks every question this way, never with a browser
 * dialog.
 *
 * - The decline button comes first and the accept button last, as everywhere
 *   in the app.
 * - Focus moves to the decline button, so a stray key press right after the
 *   question appears cannot accept it.
 * - After a decline, focus returns to the element that had focus when the
 *   question appeared. The caller must keep that element mounted while the
 *   question shows.
 * - When one question replaces another, give the new one its own React `key`.
 *   It then remounts, takes focus, and remembers its own asking element.
 */
export function InPlaceQuestion({
  question,
  declineLabel,
  acceptLabel,
  onDecline,
  onAccept,
}: {
  readonly question: string;
  readonly declineLabel: string;
  readonly acceptLabel: string;
  readonly onDecline: () => void;
  readonly onAccept: () => void;
}): JSX.Element {
  // The first render runs before the decline button takes focus, so the
  // focused element is still the one that asked.
  const [asker] = useState(() => document.activeElement);
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-row text-muted">
      {/* A long question is truncated in a narrow row, so the tooltip shows the full text. */}
      <span title={question} className="min-w-0 truncate">
        {question}
      </span>
      <Button
        autoFocus
        onClick={() => {
          // The asking element can take focus only after the page re-renders
          // without the question, so that render is flushed first.
          flushSync(onDecline);
          if (asker instanceof HTMLElement) asker.focus();
        }}
      >
        {declineLabel}
      </Button>
      <Button variant="primary" onClick={onAccept}>
        {acceptLabel}
      </Button>
    </div>
  );
}
