import type { JSX } from "react";
import { Face, HERCULE_LOOK } from "../../faces";
import "./sunrise.css";

/** The size of the sunrise's drawing, and the middle of its horizon, in the drawing's own units. */
const WIDTH = 720;
const HEIGHT = 240;
const RAY_COUNT = 31;
/** A ray runs from the inner radius out to a long or a short outer radius, alternately. */
const INNER_RADIUS = 126;
const LONG_RADIUS = 226;
const SHORT_RADIUS = 182;
/** How many milliseconds later each ray, from the middle one outward, starts to grow. */
const DELAY_PER_RAY = 26;

/** One ray, from its inner end to its outer end, and when it starts to grow. */
interface Ray {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly delay: number;
}

/** Returns the rays fanning up from the middle of the horizon, the middle one first to grow. */
function buildRays(): ReadonlyArray<Ray> {
  const centerX = WIDTH / 2;
  return Array.from({ length: RAY_COUNT }, (_, index) => {
    const angle = Math.PI * (index / (RAY_COUNT - 1));
    const outer = index % 2 === 0 ? LONG_RADIUS : SHORT_RADIUS;
    return {
      x1: centerX - Math.cos(angle) * INNER_RADIUS,
      y1: HEIGHT - Math.sin(angle) * INNER_RADIUS,
      x2: centerX - Math.cos(angle) * outer,
      y2: HEIGHT - Math.sin(angle) * outer,
      delay: Math.abs(index - (RAY_COUNT - 1) / 2) * DELAY_PER_RAY,
    };
  });
}

const RAYS = buildRays();

/**
 * Renders the sunrise: Hercule coming up over a horizon with rays fanning
 * out behind him, for a page where all is done. The box is 720 by 240 and
 * stands on the bottom edge of its positioned parent, centred, so the page
 * puts it on its hairline. The rays grow out and Hercule rises once, when it
 * mounts, and Reduce motion shows it at rest.
 */
export function Sunrise(): JSX.Element {
  return (
    <div className="sunrise" aria-hidden="true">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
        {RAYS.map((ray) => (
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
      </svg>
      <div className="sunrise-head">
        <Face look={HERCULE_LOOK} pose="idle" size={96} />
      </div>
    </div>
  );
}
