import type { CSSProperties, JSX } from "react";
import type { SessionsDrawing } from "@hercule/client-core/fleet";
import "./fleet-page.css";

declare module "react" {
  interface CSSProperties {
    /** The width of one cell of the sessions drawing, such as `5px`. */
    "--fleet-cell"?: string;
  }
}

/** How many sessions a segment of the continuous fill holds: it is cut every 10 sessions. */
const SESSIONS_PER_CUT = 10;

/**
 * Returns how many slots each segment of a stretch of `slots` slots holds, in
 * order: `slotsPerSegment` each, and the rest in a shorter last segment. An
 * empty stretch has no segment.
 */
const splitIntoSegments = (slots: number, slotsPerSegment: number): number[] =>
  Array.from({ length: Math.ceil(slots / slotsPerSegment) }, (_, index) =>
    Math.min(slotsPerSegment, slots - index * slotsPerSegment),
  );

/**
 * Renders a machine's sessions against its cap, as `drawing` says, in one of
 * two forms:
 *
 * - While `drawing.cellWidth` is a number, every slot is one cell of that
 *   width, with a 2px gap between every two, so the bar ends wherever its
 *   cells end. A running session's cell is filled and marked `is-run`.
 * - While it is `null`, the bar is one continuous fill, 120px wide, cut every
 *   10 sessions. A segment fills from the left with the sessions running in
 *   it and is free for the rest, and a segment whose every slot runs a
 *   session is marked `is-run`.
 *
 * In both forms the cap comes first. When the cap was lowered below the
 * sessions running, the sessions past the cap follow, filled. The sessions
 * waiting for a slot follow in marigold. A 1.5px rule marks where the cap
 * ends, when sessions run past it or wait. A drawing that `isAway` draws every
 * slot in the disabled tint, for a machine whose sessions cannot be known; the
 * waiting ones stay marigold.
 *
 * The numbers are drawn beside the bar, so the drawing is hidden from
 * assistive technology. `size` is the card's or the list row's.
 */
export function SessionsFigure({
  drawing,
  size,
}: {
  readonly drawing: SessionsDrawing;
  readonly size: "card" | "list";
}): JSX.Element {
  const { cap, running, isAway, cellWidth, waitingDrawn } = drawing;
  const isCells = cellWidth !== null;
  const slotsPerSegment = isCells ? 1 : SESSIONS_PER_CUT;
  const className = `fleet-sessions fleet-sessions--${size}${isCells ? " is-cells" : ""}${isAway ? " is-away" : ""}`;
  const overCap = Math.max(0, running - cap);
  const marksCap = waitingDrawn > 0 || overCap > 0;
  // A cell takes its width from `--fleet-cell`; only a segment of the continuous fill grows with
  // the sessions it holds.
  const segmentStyle = (slots: number, runningShare?: number): CSSProperties => ({
    ...(isCells ? {} : { flexGrow: slots }),
    ...(runningShare === undefined ? {} : { "--fleet-running": `${runningShare * 100}%` }),
  });

  return (
    <span
      className={className}
      style={isCells ? { "--fleet-cell": `${String(cellWidth)}px` } : undefined}
      aria-hidden="true"
    >
      {splitIntoSegments(cap, slotsPerSegment).map((slots, index) => {
        // Every segment before the last holds `slotsPerSegment` slots, so this one starts there.
        const runningHere = Math.min(slots, Math.max(0, running - index * slotsPerSegment));
        return (
          <i
            key={`cap-${String(index)}`}
            className={runningHere === slots ? "is-run" : undefined}
            style={segmentStyle(slots, runningHere / slots)}
          />
        );
      })}
      {marksCap && <b className="fleet-sessions-rule" />}
      {splitIntoSegments(overCap, slotsPerSegment).map((slots, index) => (
        <i key={`over-${String(index)}`} className="is-run" style={segmentStyle(slots, 1)} />
      ))}
      {splitIntoSegments(waitingDrawn, slotsPerSegment).map((slots, index) => (
        <i key={`wait-${String(index)}`} className="is-wait" style={segmentStyle(slots)} />
      ))}
    </span>
  );
}
