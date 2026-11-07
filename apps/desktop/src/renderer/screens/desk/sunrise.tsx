import type { JSX } from "react";
import { Face, HERCULE_LOOK } from "../../faces";
import "./sunrise.css";

/** The size of the sunrise's drawing, and the middle of its horizon, in the drawing's own units. */
const WIDTH = 720;
const HEIGHT = 240;
const RAY_COUNT = 31;
/** How many milliseconds later each ray, from the middle one outward, starts to grow. */
const DELAY_PER_RAY = 26;
/** The face's size in a sunrise that is 440px wide, which the other widths scale from. */
const FACE_SIZE_AT_440 = 96;
const REFERENCE_WIDTH = 440;
/** A face's body fills 76 of its 96 pixels of height, so the box that clips it is this much shorter. */
const FACE_BOX_RATIO = 76 / 96;

/**
 * Where a sunrise's rays run, from its inner radius out to a long or a short
 * outer radius, alternately. The sunrise over Work's hairline has shorter rays
 * than the one that stands on its own horizon in the Inbox.
 */
interface RayRadii {
  readonly inner: number;
  readonly long: number;
  readonly short: number;
}

const PAGE_RADII: RayRadii = { inner: 126, long: 226, short: 182 };
const FLOW_RADII: RayRadii = { inner: 136, long: 236, short: 192 };

/** One ray, from its inner end to its outer end, and when it starts to grow. */
interface Ray {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly delay: number;
}

/** Returns the rays fanning up from the middle of the horizon, the middle one first to grow. */
function buildRays({ inner, long, short }: RayRadii): ReadonlyArray<Ray> {
  const centerX = WIDTH / 2;
  return Array.from({ length: RAY_COUNT }, (_, index) => {
    const angle = Math.PI * (index / (RAY_COUNT - 1));
    const outer = index % 2 === 0 ? long : short;
    return {
      x1: centerX - Math.cos(angle) * inner,
      y1: HEIGHT - Math.sin(angle) * inner,
      x2: centerX - Math.cos(angle) * outer,
      y2: HEIGHT - Math.sin(angle) * outer,
      delay: Math.abs(index - (RAY_COUNT - 1) / 2) * DELAY_PER_RAY,
    };
  });
}

const PAGE_RAYS = buildRays(PAGE_RADII);
const FLOW_RAYS = buildRays(FLOW_RADII);

/**
 * Renders the sunrise: Hercule coming up over a horizon with rays fanning
 * out behind him, for a page where all is done. The rays grow out and Hercule
 * rises once, when it mounts.
 *
 * - Without `width`, the box is 720 by 240 and stands on the bottom edge of
 *   its positioned parent, centred, so the page puts it on its hairline.
 * - With `width`, the sunrise stands in the flow of the page, `width` pixels
 *   wide, in brass rays over a brass horizon of its own. Hercule's head grows
 *   with the width: 96px at 440. The horizon is the bottom edge of the box.
 * - `isStill` draws it at rest: it opens a page that was already empty, and
 *   only the user's own action that empties a page plays the arrival. Reduce
 *   motion shows it at rest as well.
 */
export function Sunrise({
  width,
  isStill,
}: {
  readonly width?: number;
  readonly isStill?: boolean;
}): JSX.Element {
  const isInFlow = width !== undefined;
  const rays = isInFlow ? FLOW_RAYS : PAGE_RAYS;
  const faceSize = isInFlow
    ? Math.round((width * FACE_SIZE_AT_440) / REFERENCE_WIDTH)
    : FACE_SIZE_AT_440;
  const faceBoxHeight = Math.round(faceSize * FACE_BOX_RATIO);
  return (
    <div
      className={isInFlow ? "sunrise sunrise--in-flow" : "sunrise"}
      data-still={isStill === true ? "" : undefined}
      style={
        isInFlow
          ? {
              "--sunrise-width": `${String(width)}px`,
              "--face-size": `${String(faceSize)}px`,
              "--face-box-height": `${String(faceBoxHeight)}px`,
            }
          : undefined
      }
      aria-hidden="true"
    >
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        {rays.map((ray) => (
          <line
            key={ray.x1}
            className="ray"
            x1={ray.x1.toFixed(1)}
            y1={ray.y1.toFixed(1)}
            x2={ray.x2.toFixed(1)}
            y2={ray.y2.toFixed(1)}
            // The ray grows from its inner end, which is its origin of scaling.
            style={{
              transformOrigin: `${ray.x1.toFixed(1)}px ${ray.y1.toFixed(1)}px`,
              "--ray-delay": `${ray.delay}ms`,
            }}
          />
        ))}
        {isInFlow && (
          <line
            className="horizon"
            x1="60"
            y1={HEIGHT}
            x2="660"
            y2={HEIGHT}
            style={{ transformOrigin: `${String(WIDTH / 2)}px ${String(HEIGHT)}px` }}
          />
        )}
      </svg>
      <div className="sunrise-head">
        <Face look={HERCULE_LOOK} pose="idle" size={faceSize} />
      </div>
    </div>
  );
}
