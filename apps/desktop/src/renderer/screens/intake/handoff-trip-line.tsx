/**
 * The line that tells a handed-off signal's trip on Done, in the list's rows
 * and in the pane: "Handed to Fix bug → tried again once → done".
 */
import type { JSX } from "react";
import type { HandoffTrip } from "@hercule/client-core";

/** The separator between the steps of a trip. */
export const HANDOFF_TRIP_SEPARATOR = " → ";

/**
 * Renders a trip: the steps, then the end. `steps` is the trip's steps already
 * joined with the separator. The end is in the marigold when the user is
 * waited on (`waits`) and in the green ink when the work is `finished`. With no
 * tone, the line is one string, so the browser shapes it as one run.
 */
export function HandoffTripLine({
  steps,
  end,
  tone,
}: {
  readonly steps: string;
  readonly end: string;
  readonly tone: HandoffTrip["end"]["tone"];
}): JSX.Element {
  if (tone === null) return <>{`${steps}${HANDOFF_TRIP_SEPARATOR}${end}`}</>;
  return (
    <>
      {`${steps}${HANDOFF_TRIP_SEPARATOR}`}
      <span className={`trip-end trip-end--${tone}`}>{end}</span>
    </>
  );
}

/**
 * Renders a trip as the headline of the pane's outcome, as one line of its
 * text column: the first step in bold, then the other steps and the end in the
 * regular weight, the end toned as `HandoffTripLine` tones it.
 */
export function HandoffTripHeadline({ trip }: { readonly trip: HandoffTrip }): JSX.Element {
  const [first, ...later] = trip.steps;
  const afterFirst = later.map((step) => `${HANDOFF_TRIP_SEPARATOR}${step}`).join("");
  return (
    <span className="ad-outcome-trip">
      <b>{first}</b>
      {trip.end.tone === null ? (
        `${afterFirst}${HANDOFF_TRIP_SEPARATOR}${trip.end.text}`
      ) : (
        <>
          {`${afterFirst}${HANDOFF_TRIP_SEPARATOR}`}
          <span className={`trip-end trip-end--${trip.end.tone}`}>{trip.end.text}</span>
        </>
      )}
    </span>
  );
}
