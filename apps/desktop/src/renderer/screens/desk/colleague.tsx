import type { JSX } from "react";
import { buildHueStyle, Face, type Look } from "../../faces";
import { hashSeed } from "../../faces/look";

/**
 * The poses a colleague shows behind the top edge of a card: `working` types
 * with two paws on the edge, `waiting` raises its palm because a Thread asks
 * a question, and `failed` wears a plaster and keeps its paws off the edge.
 */
export type ColleaguePose = "working" | "waiting" | "failed";

/** How long the paws' cycle is, in hundredths of a second, so the start of each cycle can be spread over it. */
const PAW_CYCLE_HUNDREDTHS = 340;

/**
 * Renders the colleague on a card: its head standing behind the card's top
 * edge, and two paws on the edge in front of the card's sheet. Place it in a
 * `.desk-card`'s `.card-body`, or in a pane that rides on a sheet's edge.
 *
 * - `look` and `pose` are what the app's `Face` draws. The head is that same
 *   face, cropped by CSS below the mouth, so there is no second face system.
 * - `seed` spreads the start of the paws' typing over the cycle, so a board of
 *   working colleagues does not tap in step. A Thread's session id serves.
 * - `still` stops the paws, for the Still colleagues setting.
 */
export function Colleague({
  look,
  pose,
  seed,
  still,
}: {
  readonly look: Look;
  readonly pose: ColleaguePose;
  readonly seed: string;
  readonly still: boolean;
}): JSX.Element {
  const delay = -(hashSeed(seed) % PAW_CYCLE_HUNDREDTHS) / 100;
  return (
    <>
      <span className="card-holder">
        <span className="card-head" data-pose={pose}>
          <Face look={look} pose={pose} size={30} />
        </span>
      </span>
      <span
        className="card-paws"
        data-pose={pose}
        data-still={still ? "" : undefined}
        style={{ ...buildHueStyle(look.hue), "--paw-delay": `${delay.toFixed(2)}s` }}
      >
        <i />
        <i />
      </span>
    </>
  );
}
