import type { JSX } from "react";
import { UndoIcon } from "../../icons/undo";

/**
 * Renders the quiet line that stays in the toolbar after the morning replay,
 * such as "Since you last looked: 2 landed, 1 new", with a 20px button that
 * plays the replay again. It is presentational: `onReplay` is `null` when
 * there was no replay to play, as under Reduce motion, and then the line has
 * no button.
 */
export function SinceLine({
  text,
  onReplay,
}: {
  readonly text: string;
  readonly onReplay: (() => void) | null;
}): JSX.Element {
  return (
    <span className="since">
      <span className="since-item">{text}</span>
      {onReplay !== null && (
        <button
          type="button"
          className="since-replay"
          aria-label="Replay what changed"
          title="Replay what changed"
          onClick={onReplay}
        >
          <UndoIcon size={12} />
        </button>
      )}
    </span>
  );
}
