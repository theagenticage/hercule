import { useState, type JSX, type ReactNode } from "react";
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
 * - By default the question and its buttons share one line, and a question
 *   too long for it is cut short, with the full text in a tooltip. Pass
 *   `stacked` when every word of the question matters: the question then
 *   wraps over as many lines as it needs, with the buttons below it.
 * - `disabled` disables both buttons, so the question cannot be answered
 *   while an action the answer would interfere with is still running.
 * - `children`, when given, sit between the question and the buttons: a
 *   control that shapes the answer, such as a checkbox.
 */
export function InPlaceQuestion({
  question,
  declineLabel,
  acceptLabel,
  onDecline,
  onAccept,
  stacked = false,
  disabled = false,
  children,
}: {
  readonly question: string;
  readonly declineLabel: string;
  readonly acceptLabel: string;
  readonly onDecline: () => void;
  readonly onAccept: () => void;
  readonly stacked?: boolean;
  readonly disabled?: boolean;
  readonly children?: ReactNode;
}): JSX.Element {
  // The first render runs before the decline button takes focus, so the
  // focused element is still the one that asked.
  const [asker] = useState(() => document.activeElement);
  const buttons = (
    <>
      <Button
        autoFocus
        disabled={disabled}
        // Neither button shrinks, so a label such as "Keep running" never
        // breaks over two lines: on one line the question gives way first.
        // Stacked, the decline button starts the row under the question, so
        // its text is pulled back to line up with the question's first letter.
        className={stacked ? "-ml-2 shrink-0" : "shrink-0"}
        onClick={() => {
          // The asking element can take focus only after the page re-renders
          // without the question, so that render is flushed first.
          flushSync(onDecline);
          if (asker instanceof HTMLElement) asker.focus();
        }}
      >
        {declineLabel}
      </Button>
      <Button variant="primary" disabled={disabled} className="shrink-0" onClick={onAccept}>
        {acceptLabel}
      </Button>
    </>
  );
  if (stacked) {
    return (
      <div className="flex flex-col gap-1.5 text-row text-muted">
        {/* Pretty wrapping keeps the last line from holding a single word. */}
        <p className="text-pretty">{question}</p>
        {children}
        <div className="flex items-center gap-1.5">{buttons}</div>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-row text-muted">
      {/* A long question is truncated in a narrow row, so the tooltip shows the full text. */}
      <span title={question} className="min-w-0 truncate">
        {question}
      </span>
      {children}
      {buttons}
    </div>
  );
}
