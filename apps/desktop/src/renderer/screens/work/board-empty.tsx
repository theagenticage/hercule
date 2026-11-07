import type { JSX } from "react";
import { HERCULE_LOOK } from "../../faces";
import { ComposeIcon } from "../../icons/compose";
import { Card } from "../desk";

/**
 * Renders the page of a controller with no Task yet: one line that says so,
 * a dashed card in Exploring where the first Task will land, with Hercule
 * looking over its edge, and the one filled button, Start a thread.
 */
export function FirstRun({ onStartThread }: { readonly onStartThread: () => void }): JSX.Element {
  return (
    <div className="board-first-run">
      <div className="board-first-words">
        <h2>Nothing here yet.</h2>
        <p>
          Work you take on lands here, by stage. Start a thread, and its Task appears by itself.
        </p>
      </div>
      <div className="board-grid board-first-grid">
        <div className="board-cell">
          <Card
            className="board-ghost"
            title="Your first Task lands here"
            now="It keeps its place, and moves when the work does."
            nowTone="plain"
            colleague={{ look: HERCULE_LOOK, pose: "waiting", seed: "hercule", still: true }}
            landed={false}
          />
        </div>
      </div>
      <button type="button" className="board-start-button" onClick={onStartThread}>
        <ComposeIcon size={14} />
        Start a thread
        <kbd>⌘N</kbd>
      </button>
    </div>
  );
}

/** Renders what a clear desk says under the sunrise: all unfinished work is done. */
export function DeskClear(): JSX.Element {
  return (
    <div className="board-clear">
      <h2>All clear.</h2>
      <p>The crew is at rest.</p>
    </div>
  );
}

/** Renders what a filter that leaves nothing says. The chips stay in the toolbar, so the way out is in view. */
export function NoMatch(): JSX.Element {
  return <p className="board-no-match">No Tasks match this filter.</p>;
}

/**
 * Renders a read that failed: `what` could not be read, `reason` says why,
 * and a button reads it again with `onRetry`. It is an alert, so a screen
 * reader says it when it appears.
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
    <p className="board-note" role="alert">
      {what} could not be read: {reason}
      <button type="button" onClick={onRetry}>
        Try again
      </button>
    </p>
  );
}
