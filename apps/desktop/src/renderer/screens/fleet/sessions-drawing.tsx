import type { CSSProperties, JSX } from "react";
import type { SessionsDrawing } from "@hercule/client-core/fleet";
import "./fleet-page.css";

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
 * Renders a machine's sessions against its cap, as `drawing` says, as one bar
 * of a fixed width, whatever the cap, made of segments of `slotsPerSegment`
 * slots with the same gap between every two:
 *
 * - The cap's segments come first. A segment fills from the left with the
 *   sessions running in its slots and is free for the rest. A segment whose
 *   every slot runs a session is marked `is-run`.
 * - When the cap was lowered below the sessions running, the sessions past
 *   the cap follow as filled segments.
 * - The sessions waiting for a slot follow as marigold segments.
 * - A 1.5px rule marks where the cap ends, when sessions run past it or wait.
 * - A drawing that `isAway` draws every segment in the disabled tint, for a
 *   machine whose sessions cannot be known. The waiting segments stay
 *   marigold.
 *
 * A segment's width is its share of the slots drawn, so every slot is as wide
 * as every other. The numbers are drawn beside the bar, so the drawing is
 * hidden from assistive technology. `size` is the card's or the list row's.
 */
export function SessionsFigure({
  drawing,
  size,
}: {
  readonly drawing: SessionsDrawing;
  readonly size: "card" | "list";
}): JSX.Element {
  const { cap, running, isAway, slotsPerSegment, waitingDrawn } = drawing;
  const className = `fleet-sessions fleet-sessions--${size}${isAway ? " is-away" : ""}`;
  const overCap = Math.max(0, running - cap);
  const marksCap = waitingDrawn > 0 || overCap > 0;
  const segmentStyle = (slots: number, runningShare?: number): CSSProperties => ({
    flexGrow: slots,
    ...(runningShare === undefined ? {} : { "--fleet-running": `${runningShare * 100}%` }),
  });

  return (
    <span className={className} aria-hidden="true">
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
