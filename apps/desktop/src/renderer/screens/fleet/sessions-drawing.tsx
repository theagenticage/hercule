import type { CSSProperties, JSX } from "react";
import type { SessionsDrawing } from "@hercule/client-core/fleet";
import "./fleet-page.css";

/**
 * Renders a machine's sessions against its cap, as `drawing` says, as one bar
 * of a fixed width, whatever the cap:
 *
 * - The bar's first part holds the cap: running sessions are its filled
 *   stretch, free slots its empty rest. A filled marigold part after it holds
 *   the `drawing.waitingDrawn` sessions waiting for a slot.
 * - Both parts are cut every `drawing.sessionsPerCut` sessions: once per slot
 *   up to a cap of 16, so the bar still reads as slots, and every 10 above.
 * - When the cap was lowered below the sessions running, the running stretch
 *   fills the first part, which then holds the sessions running, and a rule
 *   marks where the cap ends. The rule also stands between the cap and the
 *   waiting part.
 * - A drawing that `isAway` draws the cap's part as an outline with nothing
 *   running in it, for a machine whose sessions cannot be known. The waiting
 *   part stays marigold.
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
  const { running, isAway, sessionsPerCut, waitingDrawn } = drawing;
  const className = `fleet-sessions fleet-sessions--${size}${isAway ? " is-away" : ""}`;
  const isOverCap = running > drawing.cap;
  // The first part holds the cap, or the sessions running when they are more.
  const inCap = Math.max(drawing.cap, running);
  const total = inCap + waitingDrawn;
  const share = (count: number, of: number): string => `${(count / of) * 100}%`;
  const cutStyle = (sessions: number): CSSProperties =>
    ({ "--fleet-cut": share(sessionsPerCut, sessions) }) as CSSProperties;
  const marksCap = waitingDrawn > 0 || isOverCap;
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
      {waitingDrawn > 0 && <i className="is-wait" style={cutStyle(waitingDrawn)} />}
    </span>
  );
}
