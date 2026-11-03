import { Fragment, type CSSProperties, type JSX } from "react";
import type { SessionsDrawing } from "@hercule/client-core/fleet";
import "./fleet-page.css";

/** How many sessions one cut of a bar stands for. */
const SESSIONS_PER_CUT = 10;

/**
 * Renders a machine's sessions against its cap, as `drawing` says: one block
 * per slot while the shape is `blocks`, one bar when it is `bar`.
 *
 * - A running session is a filled block or stretch, a free slot is an empty
 *   one, and each session waiting for a slot is a marigold-ringed block after
 *   the cap. In blocks only the first `drawing.waitingBlocks` waiting sessions
 *   get a block.
 * - When the cap was lowered below the sessions running, the running part runs
 *   past the cap and a rule marks where the cap ends: after the cap-th block,
 *   or inside the bar.
 * - A bar is cut every 10 sessions in its cap part and in its waiting part,
 *   so a cap of 100 stays countable.
 * - A drawing that `isAway` draws the cap's part as an outline with nothing
 *   running in it, for a machine whose sessions cannot be known. The waiting
 *   sessions stay marigold.
 *
 * The numbers are drawn beside it, so the drawing is hidden from assistive
 * technology. `size` is the card's or the list row's.
 */
export function SessionsFigure({
  drawing,
  size,
}: {
  readonly drawing: SessionsDrawing;
  readonly size: "card" | "list";
}): JSX.Element {
  const { running, free, isAway } = drawing;
  const className = `fleet-sessions fleet-sessions--${drawing.shape} fleet-sessions--${size}${isAway ? " is-away" : ""}`;
  const isOverCap = running > drawing.cap;

  if (drawing.shape === "blocks") {
    return (
      <span className={className} aria-hidden="true">
        {Array.from({ length: running }, (_, index) => (
          <Fragment key={`run-${String(index)}`}>
            {isOverCap && index === drawing.cap && <b className="fleet-sessions-mark" />}
            <i className="is-run" />
          </Fragment>
        ))}
        {Array.from({ length: free }, (_, index) => (
          <i key={`free-${String(index)}`} />
        ))}
        {drawing.waitingBlocks > 0 && <b className="fleet-sessions-gap" />}
        {Array.from({ length: drawing.waitingBlocks }, (_, index) => (
          <i key={`wait-${String(index)}`} className="is-wait" />
        ))}
      </span>
    );
  }

  // The first part holds the cap, or the sessions running when they are more.
  const inCap = Math.max(drawing.cap, running);
  const total = inCap + drawing.waiting;
  const share = (count: number, of: number): string => `${(count / of) * 100}%`;
  const cutStyle = (sessions: number): CSSProperties =>
    ({ "--fleet-cut": share(SESSIONS_PER_CUT, sessions) }) as CSSProperties;
  const marksCap = drawing.waiting > 0 || isOverCap;
  return (
    <span className={className} aria-hidden="true">
      <span
        className="fleet-sessions-cap"
        style={{ width: share(inCap, total), ...cutStyle(inCap) }}
      >
        <i className="is-run" style={{ width: share(running, inCap) }} />
      </span>
      {marksCap && (
        <b className="fleet-sessions-rule" style={{ left: share(drawing.cap, total) }} />
      )}
      {drawing.waiting > 0 && <i className="is-wait" style={cutStyle(drawing.waiting)} />}
    </span>
  );
}
