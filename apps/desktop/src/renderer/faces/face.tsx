import { Fragment, type CSSProperties, type JSX } from "react";
import { drawAccessory, drawHeadwear } from "./accessories";
import {
  drawBrows,
  drawEyes,
  drawMouth,
  drawPaw,
  drawPoseExtras,
  drawTypewriter,
} from "./face-parts";
import type { Hue, Look } from "./look";
import type { Pose } from "@hercule/client-core";
import { buildBodyPath, SHAPE_METRICS } from "./shapes";
import "./face.css";

/**
 * Returns the inline style that paints an element in `hue`. tokens.css derives
 * `--who` and its shades from the `--hue` it sets, so a face, a crumb or a
 * card drawn inside the element takes the colleague's colour.
 */
export const buildHueStyle = (hue: Hue): CSSProperties => ({ "--hue": `var(--hue-${hue})` });

/**
 * Renders a colleague's face: `look` drawn in `pose`, `size` CSS pixels
 * square. Only the working pose moves, and only when `animated` is true and
 * Reduce motion is off; every other pose ignores `animated`.
 *
 * The face is hidden from assistive technology. Every place that draws a face
 * also writes who it is and what state it is in, such as a thread row's title
 * and pose, so a name on the face would only repeat them.
 *
 * A still face is the Bureau book's `face` in crew.js, attribute for
 * attribute, without the eyes' blink group: the app does not blink, and
 * without that group the same props always give the same markup.
 */
export function Face({
  look,
  pose,
  size,
  animated = false,
}: {
  readonly look: Look;
  readonly pose: Pose;
  readonly size: number;
  readonly animated?: boolean;
}): JSX.Element {
  // Small faces get thicker strokes and larger eyes, so they still read.
  const bold = size < 30;
  const { topY } = SHAPE_METRICS[look.shape];
  const body = buildBodyPath(look.shape);
  // Left unrounded, as crew.js leaves it.
  const highlightY = topY + 6.4;
  const tapping = animated && pose === "working";
  const hue = buildHueStyle(look.hue);
  const drawing = (
    <>
      {/* The body twice: its shade as the base it sits on, then the body itself, 2 units higher. */}
      <path d={body} fill="var(--who-shade)" />
      <path d={body} fill="var(--who)" transform="translate(0 -2)" />
      <ellipse
        cx="17.4"
        cy={highlightY}
        rx="3.6"
        ry="2.1"
        transform={`rotate(-30 17.4 ${highlightY})`}
        fill="#fff"
        opacity=".34"
      />
      <ellipse cx="15" cy="31.4" rx="2.6" ry="1.6" fill="var(--blush)" />
      <ellipse cx="33" cy="31.4" rx="2.6" ry="1.6" fill="var(--blush)" />
      {drawEyes(pose, bold)}
      {drawBrows(pose, bold)}
      {drawMouth(pose, bold, look.accessories.includes("tache"))}
      {look.accessories.map((accessory) => (
        <Fragment key={accessory}>{drawAccessory(accessory, topY)}</Fragment>
      ))}
      {look.headwear !== null && drawHeadwear(look.headwear, topY)}
      {tapping ? drawTypewriter() : drawPoseExtras(pose)}
    </>
  );
  if (!tapping) {
    return (
      <svg
        className={`cr cr--${pose}`}
        viewBox="3 1 45 45"
        width={size}
        height={size}
        aria-hidden="true"
        style={hue}
      >
        {drawing}
      </svg>
    );
  }
  // Each tapping paw is drawn in its own svg, laid exactly over the face, and
  // face.css moves the span around that svg. Chromium animates the transform
  // of an HTML element on its compositor thread alone. When the animated
  // element is the paw inside the face's svg, or the paw's own svg element,
  // the page's main thread also runs style and paint on every frame: 120
  // times a second on a 120 Hz display.
  return (
    <span className="cr cr--working cr--animated" aria-hidden="true" style={hue}>
      <svg viewBox="3 1 45 45" width={size} height={size}>
        {drawing}
      </svg>
      <span className="cr-tap">
        <svg viewBox="3 1 45 45" width={size} height={size}>
          {drawPaw(18)}
        </svg>
      </span>
      <span className="cr-tap cr-tap--2">
        <svg viewBox="3 1 45 45" width={size} height={size}>
          {drawPaw(30)}
        </svg>
      </span>
    </span>
  );
}
