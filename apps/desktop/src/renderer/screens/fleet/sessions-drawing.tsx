import type { CSSProperties, JSX } from "react";
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
 *   the cap.
 * - When the cap was lowered below the sessions running, the running part runs
 *   past the cap and the cap is marked by a rule inside it.
 * - A bar is cut every 10 sessions, so a cap of 100 stays countable.
 * - `away` draws the cap's part as an outline with nothing running in it, for
 *   a machine whose sessions cannot be known. The waiting sessions stay marigold.
 *
 * The numbers are drawn beside it, so the drawing is hidden from assistive
 * technology. `size` is the card's or the list row's.
 */
export function SessionsFigure({
  drawing,
  size,
  away = false,
}: {
  readonly drawing: SessionsDrawing;
  readonly size: "card" | "list";
  readonly away?: boolean;
}): JSX.Element {
  const running = away ? 0 : drawing.running;
  const free = away ? drawing.cap : drawing.free;
  const className = `fleet-sessions fleet-sessions--${drawing.shape} fleet-sessions--${size}${away ? " is-away" : ""}`;

  if (drawing.shape === "blocks") {
    return (
      <span className={className} aria-hidden="true">
        {Array.from({ length: running }, (_, index) => (
          <i key={`run-${String(index)}`} className="is-run" />
        ))}
        {Array.from({ length: free }, (_, index) => (
          <i key={`free-${String(index)}`} />
        ))}
        {drawing.waiting > 0 && <b className="fleet-sessions-gap" />}
        {Array.from({ length: drawing.waiting }, (_, index) => (
          <i key={`wait-${String(index)}`} className="is-wait" />
        ))}
      </span>
    );
  }

  // The first part holds the cap, or the sessions running when they are more.
  const inCap = Math.max(drawing.cap, running);
  const total = inCap + drawing.waiting;
  const share = (count: number, of: number): string => `${(count / of) * 100}%`;
  const capStyle = {
    width: share(inCap, total),
    "--fleet-cut": share(SESSIONS_PER_CUT, inCap),
  } as CSSProperties;
  const marksCap = drawing.waiting > 0 || running > drawing.cap;
  return (
    <span className={className} aria-hidden="true">
      <span className="fleet-sessions-cap" style={capStyle}>
        <i className="is-run" style={{ width: share(running, inCap) }} />
      </span>
      {marksCap && (
        <b className="fleet-sessions-rule" style={{ left: share(drawing.cap, total) }} />
      )}
      {drawing.waiting > 0 && <i className="is-wait" />}
    </span>
  );
}
