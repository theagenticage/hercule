import type { JSX } from "react";
import type { Pose } from "./pose";

// The parts of a face that change with its pose, drawn as the Bureau book's
// crew.js draws them: `eyes`, `brows`, `mouth`, `extras` and `badge` there.
// Every number is computed with the book's own expression, so each attribute
// matches the book's string. `bold` is true below 30px, where strokes are
// thicker and eyes larger so the face still reads.

/** The y of the eyes' centres, in the units of the face's viewBox. */
const EYE_Y = 26.6;

/**
 * Returns the stroke attributes of a line drawn in the face's ink: the eyes
 * of some poses, the brows and the mouth.
 */
function buildInkStroke(width: number) {
  return {
    fill: "none",
    stroke: "var(--face-ink)",
    strokeWidth: width,
    strokeLinecap: "round",
  } as const;
}

/** Returns the white highlight in an eye centred on `x`, `y`, for an eye scaled by `scale`. */
function drawGlint(x: number, y: number, scale: number): JSX.Element {
  return <circle cx={x + 0.7} cy={y - 0.9} r={0.7 * scale} fill="#fff" opacity=".9" />;
}

/** Returns one eye in `pose`, centred on `x`. */
function drawEye(pose: Pose, x: number, bold: boolean): JSX.Element {
  const scale = bold ? 1.2 : 1;
  const stroke = buildInkStroke(bold ? 1.9 : 1.5);
  switch (pose) {
    case "working":
      // Lowered to the typewriter.
      return (
        <>
          <ellipse cx={x} cy={EYE_Y + 1} rx={2 * scale} ry={2.2 * scale} fill="var(--face-ink)" />
          {drawGlint(x, EYE_Y + 1, scale)}
        </>
      );
    case "paused":
      return <path d={`M${x - 2.2 * scale} ${EYE_Y + 0.2}h${4.4 * scale}`} {...stroke} />;
    case "asleep":
      return <path d={`M${x - 2.3} ${EYE_Y}q2.3 2 4.6 0`} {...stroke} />;
    case "done":
      return <path d={`M${x - 2.3} ${EYE_Y + 1}q2.3-2.8 4.6 0`} {...stroke} />;
    case "away":
      return <circle cx={x - 1} cy={EYE_Y + 0.3} r={1.5 * scale} fill="var(--face-ink)" />;
    case "waiting":
    case "idle":
    case "failed": {
      // Waiting eyes are open wider and sit a little higher.
      const dy = pose === "waiting" ? -0.5 : 0;
      const ry = pose === "waiting" ? 2.75 : 2.55;
      return (
        <>
          <ellipse cx={x} cy={EYE_Y + dy} rx={2 * scale} ry={ry * scale} fill="var(--face-ink)" />
          {drawGlint(x, EYE_Y + dy, scale)}
        </>
      );
    }
  }
}

/** Returns both eyes of a face in `pose`, the left one first. */
export function drawEyes(pose: Pose, bold: boolean): JSX.Element {
  return (
    <>
      {drawEye(pose, 19, bold)}
      {drawEye(pose, 29, bold)}
    </>
  );
}

/** Returns the brows of a face in `pose`, or null for the poses drawn without brows. */
export function drawBrows(pose: Pose, bold: boolean): JSX.Element | null {
  const stroke = buildInkStroke(bold ? 1.6 : 1.25);
  switch (pose) {
    case "waiting":
      return <path d="M16.9 21.6q2.1-1.4 4.2 0M26.9 21.6q2.1-1.4 4.2 0" {...stroke} />;
    case "working":
      return <path d="M17.2 22.3l3.6.5M30.8 22.3l-3.6.5" {...stroke} />;
    case "failed":
      return <path d="M16.8 22.8l4.2-1.5M31.2 22.8l-4.2-1.5" {...stroke} />;
    default:
      return null;
  }
}

/**
 * Returns the mouth of a face in `pose`, or null when a tache hides it.
 * When `wearsTache` is true the mouth sits lower, and only the waiting, done
 * and failed mouths still show.
 */
export function drawMouth(pose: Pose, bold: boolean, wearsTache: boolean): JSX.Element | null {
  const stroke = buildInkStroke(bold ? 1.8 : 1.45);
  const y = wearsTache ? 34.4 : 32.6;
  switch (pose) {
    case "waiting":
      return <ellipse cx="24" cy={y + 0.2} rx="1.5" ry="1.7" fill="var(--face-ink)" />;
    case "done":
      return <path d={`M21 ${y - 1.2}q3 3.2 6 0`} {...stroke} />;
    case "failed":
      return <path d={`M21.4 ${y + 0.6}q1.3-1.3 2.6 0t2.6 0`} {...stroke} />;
  }
  if (wearsTache) return null;
  switch (pose) {
    case "working":
    case "paused":
      return <path d={`M22.6 ${y}h2.8`} {...stroke} />;
    case "asleep":
      return <path d={`M23 ${y}q1 .8 2 0`} {...stroke} />;
    case "away":
      return <path d={`M22.2 ${y}h3.6`} {...stroke} strokeDasharray=".1 1.8" />;
    case "idle":
      return <path d={`M21.6 ${y - 1.2}q2.4 2.3 4.8 0`} {...stroke} />;
  }
}

/**
 * Returns the round badge in the face's lower right corner: a disc in `fill`
 * with `symbol` on it. The ring around the disc takes `--badge-ring`, so it
 * can match the surface the face sits on. An outlined badge adds a thin inner
 * ring, for the badges drawn on `--raised`.
 */
function drawBadge({
  fill,
  outlined,
  symbol,
}: {
  readonly fill: string;
  readonly outlined: boolean;
  readonly symbol: JSX.Element;
}): JSX.Element {
  return (
    <>
      <circle
        cx="40"
        cy="39"
        r="5.6"
        fill={fill}
        stroke="var(--badge-ring, var(--surface))"
        strokeWidth="2"
      />
      {outlined && (
        <circle cx="40" cy="39" r="4.4" fill="none" stroke="var(--line)" strokeWidth=".8" />
      )}
      {symbol}
    </>
  );
}

// The paint of the working pose's paws: the body's shade, with a faint outline.
const PAW_PAINT = {
  fill: "var(--who-shade)",
  stroke: "var(--face-ink)",
  strokeOpacity: ".25",
  strokeWidth: ".6",
} as const;

/** Returns the working pose's typewriter without the paws: its body, then its keys as dots. */
export function drawTypewriter(): JSX.Element {
  return (
    <>
      <path d="M11.4 45.4l2.4-5h20.4l2.4 5z" fill="var(--hat)" />
      <g fill="var(--surface)" opacity=".55">
        <circle cx="17" cy="43.4" r=".7" />
        <circle cx="20.4" cy="43.4" r=".7" />
        <circle cx="24" cy="43.4" r=".7" />
        <circle cx="27.6" cy="43.4" r=".7" />
        <circle cx="31" cy="43.4" r=".7" />
      </g>
    </>
  );
}

/**
 * Returns one of the working pose's paws on its own, in a group that paints
 * it as `drawPoseExtras` paints both: the left paw at x 18, the right at x 30.
 */
export function drawPaw(x: 18 | 30): JSX.Element {
  return (
    <g {...PAW_PAINT}>
      <ellipse cx={x} cy="40.4" rx="2.8" ry="1.9" />
    </g>
  );
}

/**
 * Returns what a pose adds around the face, or null for the idle pose:
 * - working: a typewriter with two paws on it;
 * - waiting: a raised arm with a `--you` palm, the one place a face carries
 *   marigold, because it asks for you;
 * - asleep: two z's;
 * - failed: a plaster on the cheek and a red badge with an X;
 * - done: a green badge with a check;
 * - paused and away: an outlined badge.
 *
 * Everything is drawn still. The book animates the paws, the arm and the z's;
 * the app animates only the paws, and draws them apart to do it: see Face.
 * The still paws keep the book's `cr-tap` classes, which nothing styles.
 */
export function drawPoseExtras(pose: Pose): JSX.Element | null {
  switch (pose) {
    case "working":
      return (
        <>
          {drawTypewriter()}
          <g {...PAW_PAINT}>
            <ellipse className="cr-tap" cx="18" cy="40.4" rx="2.8" ry="1.9" />
            <ellipse className="cr-tap cr-tap--2" cx="30" cy="40.4" rx="2.8" ry="1.9" />
          </g>
        </>
      );
    case "waiting":
      return (
        <>
          <path
            d="M36.8 33C40.4 30.4 41.6 24.4 41.8 18.4"
            fill="none"
            stroke="var(--who-shade)"
            strokeWidth="3.4"
            strokeLinecap="round"
          />
          <rect
            x="37.8"
            y="6.8"
            width="8"
            height="10.6"
            rx="4"
            fill="var(--you)"
            stroke="var(--who-shade)"
            strokeWidth="1.3"
          />
          <ellipse
            cx="37.6"
            cy="13.4"
            rx="1.7"
            ry="2.5"
            transform="rotate(-32 37.6 13.4)"
            fill="var(--you)"
            stroke="var(--who-shade)"
            strokeWidth="1.1"
          />
        </>
      );
    case "asleep":
      return (
        <g fill="var(--muted)" fontFamily="var(--font-ui)" fontWeight="760">
          <text x="37.4" y="15" fontSize="10">
            z
          </text>
          <text x="42.6" y="8.4" fontSize="7">
            z
          </text>
        </g>
      );
    case "failed":
      return (
        <>
          <g transform="rotate(-30 14.6 32.4)">
            <rect
              x="9.6"
              y="30.1"
              width="10"
              height="4.6"
              rx="2.3"
              fill="oklch(0.95 0.03 75)"
              stroke="oklch(0.7 0.05 60)"
              strokeWidth=".7"
            />
            <rect x="13.1" y="30.7" width="3" height="3.4" rx=".7" fill="oklch(0.85 0.05 65)" />
          </g>
          {drawBadge({
            fill: "var(--fail)",
            outlined: false,
            symbol: (
              <path
                d="M38.3 37.3l3.4 3.4M41.7 37.3l-3.4 3.4"
                stroke="#fff"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            ),
          })}
        </>
      );
    case "done":
      return drawBadge({
        fill: "var(--ok)",
        outlined: false,
        symbol: (
          <path
            d="M37.6 39.2l1.6 1.6 3.2-3.4"
            fill="none"
            stroke="#fff"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ),
      });
    case "paused":
      return drawBadge({
        fill: "var(--raised)",
        outlined: true,
        symbol: (
          <path
            d="M38.8 37.2v3.6M41.2 37.2v3.6"
            stroke="var(--ink)"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        ),
      });
    case "away":
      return drawBadge({
        fill: "var(--raised)",
        outlined: true,
        symbol: (
          <path
            d="M37.6 40.8l4.8-4.8M37.8 37.2a3 3 0 0 1 4.6 0"
            fill="none"
            stroke="var(--muted)"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        ),
      });
    case "idle":
      return null;
  }
}
