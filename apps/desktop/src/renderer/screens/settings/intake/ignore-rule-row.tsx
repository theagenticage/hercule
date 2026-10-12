import { useId, type JSX } from "react";
import "./intake-settings.css";

/**
 * Renders one Ignore Rule of Settings > Intake: the rule's text, what it
 * caught under it, and a Delete button that calls `onDelete`. The markup is
 * the book's `set-row`, like a kind's row, so the rule list lines up with
 * the lists above it. A long text wraps, so the whole rule always shows.
 */
export function IgnoreRuleRow({
  text,
  catches,
  onDelete,
}: {
  readonly text: string;
  /** What the rule caught: "Caught 142 in the last 90 days". */
  readonly catches: string;
  readonly onDelete: () => void;
}): JSX.Element {
  const catchesId = useId();
  return (
    <div className="set-row intake-row">
      <div className="set-label">
        <b className="intake-rule-text">{text}</b>
        <span id={catchesId}>{catches}</span>
      </div>
      <div className="intake-controls">
        <button
          type="button"
          className="btn btn--quiet btn--sm"
          aria-label={`Delete the rule ${text}`}
          aria-describedby={catchesId}
          onClick={onDelete}
        >
          Delete…
        </button>
      </div>
    </div>
  );
}
