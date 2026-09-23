import { useState, type JSX } from "react";
import { flushSync } from "react-dom";
import { Button } from "@hercule/ui";

/**
 * A question asked in place, beside what asked it, rather than behind a
 * browser dialog, like every other question this app puts to the reader.
 *
 * The answer that declines comes first and the answer that accepts comes
 * last, as everywhere in the app. The focus moves to the answer that
 * declines, so a key press that follows the question cannot accept it. After
 * that answer, the focus goes back to the element that asked, so the caller
 * keeps that element mounted while the question shows. A question that takes
 * the place of another needs a key of its own: it then starts again, takes
 * the focus, and keeps the element that asked it.
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
  // The first render comes before the answer that declines takes the focus,
  // so the element with the focus is the element that asked.
  const [asker] = useState(() => document.activeElement);
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-row text-muted">
      {/* A long question is cut off where the row is narrow, so the whole question is in its tooltip. */}
      <span title={question} className="min-w-0 truncate">
        {question}
      </span>
      <Button
        autoFocus
        onClick={() => {
          // The element that asked can take the focus only after the page
          // has rendered without the question.
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
