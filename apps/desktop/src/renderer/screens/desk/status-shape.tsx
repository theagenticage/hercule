import type { JSX } from "react";
import "./status-shape.css";

const RING = <circle cx="8" cy="8" r="5.6" />;

/** Draws a ring with a filled wedge in it, as the shapes that say how far something has come. */
const ringWith = (wedge: string): JSX.Element => (
  <>
    {RING}
    <path d={wedge} fill="currentColor" stroke="none" />
  </>
);

/**
 * The shapes a status can have, each drawn on the 16-unit grid with a 1.5
 * stroke and round caps:
 *
 * - `ring` is open, `dashed` is not real yet;
 * - `quarter`, `half` and `most` are under way;
 * - `fork` is a proposed change and `join` a merged one;
 * - `check` is finished and `cross` failed or refused;
 * - `hold` waits for a change.
 */
const SHAPES = {
  ring: RING,
  dashed: <circle cx="8" cy="8" r="5.6" strokeDasharray="2.1 2.3" />,
  quarter: ringWith("M8 8V4.4A3.6 3.6 0 0 1 11.6 8Z"),
  half: ringWith("M8 4.4a3.6 3.6 0 0 1 0 7.2Z"),
  most: ringWith("M8 8V4.4a3.6 3.6 0 1 1-3.6 3.6Z"),
  fork: (
    <>
      <circle cx="4.5" cy="3.9" r="1.5" />
      <circle cx="4.5" cy="12.1" r="1.5" />
      <circle cx="11.5" cy="12.1" r="1.5" />
      <path d="M4.5 5.4v5.2M11.5 10.6V6.9a2.3 2.3 0 0 0-2.3-2.3H7.9" />
      <path d="M9.5 2.9 7.8 4.6l1.7 1.7" />
    </>
  ),
  join: (
    <>
      <circle cx="4.5" cy="3.9" r="1.5" />
      <circle cx="4.5" cy="12.1" r="1.5" />
      <circle cx="11.5" cy="8" r="1.5" />
      <path d="M4.5 5.4v5.2M4.5 5.4C5 7.2 7 8 10 8" />
    </>
  ),
  check: (
    <>
      {RING}
      <path d="M5.4 8.2l1.8 1.8 3.4-3.7" />
    </>
  ),
  cross: (
    <>
      {RING}
      <path d="M6 6l4 4M10 6l-4 4" />
    </>
  ),
  hold: (
    <>
      {RING}
      <path d="M5.2 8h5.6" />
    </>
  ),
} as const;

/** A shape of a status: a key of `SHAPES`. */
export type StatusShapeName = keyof typeof SHAPES;

/**
 * The tones a shape can be drawn in, each one colour of the design system:
 * `quiet` is `--faint`, `good` is `--ok` and `bad` is `--fail-ink`. The tones
 * `active` and `attention` come with the Inbox's tokens.
 */
export type StatusTone = "quiet" | "good" | "bad";

/**
 * Renders a status as a shape in a tone, `size` CSS pixels square. The shape is hidden from assistive technology: the words that
 * say the status always stand beside it. `className` is added to the shape's
 * own classes.
 */
export function StatusShape({
  shape,
  tone,
  size,
  className,
}: {
  readonly shape: StatusShapeName;
  readonly tone: StatusTone;
  readonly size: number;
  readonly className?: string;
}): JSX.Element {
  return (
    <svg
      className={className === undefined ? `shape tone-${tone}` : `shape tone-${tone} ${className}`}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      {SHAPES[shape]}
    </svg>
  );
}

/**
 * Renders the mark that goes first in the words of a failed run: the `cross`
 * shape in its `bad` tone, so a failure looks the same on every page. It sits
 * in a line of text.
 */
export function FailedMark(): JSX.Element {
  return <StatusShape shape="cross" tone="bad" size={14} className="failed-mark" />;
}
