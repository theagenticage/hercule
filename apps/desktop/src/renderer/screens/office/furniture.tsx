import { Fragment, type CSSProperties, type JSX, type ReactNode } from "react";
import type { Pose } from "@hercule/client-core";
import { Face, type Look } from "../../faces";
import type { ProjectTint } from "../project-tile";
import {
  formatPoints,
  formatTenths,
  projectPoint,
  type Projection,
  type StagePoint,
} from "./projection";

// The furniture of the Office, ported from the Bureau book's office.js. Each
// function returns the SVG of one piece, placed in the room by its plan
// coordinates under a projection. The markup is the book's, element for
// element and in the same nesting, because office.css styles some of it by
// position, such as `.floor > g > rect`.

/** The height of a desk's top, in tiles. */
const DESK = 0.74;
/** The height of a desk's writing surface, above its brass edge, in tiles. */
export const DESK_SURFACE = DESK + 0.06;

/** Returns the size in pixels of a seated colleague's face under `p`. */
export const measureFaceSize = (p: Projection): number => Math.round(p.tile * 1.52);

/** Draws a four-cornered polygon through the stage points `a` to `d`. */
export function drawQuad(
  a: StagePoint,
  b: StagePoint,
  c: StagePoint,
  d: StagePoint,
  className: string,
  style?: CSSProperties,
): JSX.Element {
  return <polygon className={className} points={formatPoints([a, b, c, d])} style={style} />;
}

/**
 * Draws a box `w` by `d` by `h` tiles whose back corner stands at plan point
 * `(x, y, z)`: its two visible sides and its top, all shaded from the one
 * colour `color`. `className` is added to the box's `bx` class.
 */
export function drawBox(
  p: Projection,
  x: number,
  y: number,
  z: number,
  w: number,
  d: number,
  h: number,
  color: string,
  className: string,
): JSX.Element {
  const at = (px: number, py: number, pz: number) => projectPoint(p, px, py, pz);
  return (
    <g className={`bx ${className}`} style={{ "--c": color }}>
      {drawQuad(
        at(x, y + d, z),
        at(x + w, y + d, z),
        at(x + w, y + d, z + h),
        at(x, y + d, z + h),
        "l",
      )}
      {drawQuad(
        at(x + w, y, z),
        at(x + w, y + d, z),
        at(x + w, y + d, z + h),
        at(x + w, y, z + h),
        "r",
      )}
      {drawQuad(
        at(x, y, z + h),
        at(x + w, y, z + h),
        at(x + w, y + d, z + h),
        at(x, y + d, z + h),
        "t",
      )}
    </g>
  );
}

/** Draws a flat rectangle `w` by `d` tiles lying at height `z`, its back corner at `(x, y)`. */
export function drawPatch(
  p: Projection,
  x: number,
  y: number,
  w: number,
  d: number,
  className: string,
  z = 0,
  style?: CSSProperties,
): JSX.Element {
  return drawQuad(
    projectPoint(p, x, y, z),
    projectPoint(p, x + w, y, z),
    projectPoint(p, x + w, y + d, z),
    projectPoint(p, x, y + d, z),
    className,
    style,
  );
}

/** Draws a flat circle of radius `r` tiles lying at height `z`, centred on `(x, y)`. */
export function drawEllipse(
  p: Projection,
  x: number,
  y: number,
  z: number,
  r: number,
  className: string,
): JSX.Element {
  const [cx, cy] = projectPoint(p, x, y, z);
  const across = p.tile * 0.8660254;
  const down = p.tile * 0.5;
  return (
    <ellipse
      className={className}
      cx={formatTenths(cx)}
      cy={formatTenths(cy)}
      rx={(r * across * 1.414).toFixed(1)}
      ry={(r * down * 1.414).toFixed(1)}
    />
  );
}

/** Draws a colleague's face in `pose`, its body's bottom resting on plan point `(x, y, z)`. */
export function drawColleague(
  p: Projection,
  look: Look,
  pose: Pose,
  x: number,
  y: number,
  z: number,
): JSX.Element {
  const [sx, sy] = projectPoint(p, x, y, z);
  const size = measureFaceSize(p);
  return (
    <g transform={`translate(${formatTenths(sx - size / 2)} ${formatTenths(sy - size * 0.93)})`}>
      <Face look={look} pose={pose} size={size} />
    </g>
  );
}

/** Draws a brass stool with a cushion, centred on `(x, y)`. */
function drawStool(p: Projection, x: number, y: number): JSX.Element {
  return (
    <>
      {drawBox(p, x - 0.04, y - 0.04, 0, 0.08, 0.08, 0.38, "var(--brass)", "brass")}
      {drawEllipse(p, x, y, 0.36, 0.3, "cushion cushion--side")}
      {drawEllipse(p, x, y, 0.42, 0.3, "cushion")}
    </>
  );
}

/** Draws a banker's lamp standing at `(x, y, z)`: a brass foot and stem under a green glass shade, lit or dark. */
function drawLamp(p: Projection, x: number, y: number, z: number, lit: boolean): JSX.Element {
  return (
    <>
      {drawEllipse(p, x, y, z, 0.1, "lamp-foot")}
      {drawBox(p, x - 0.02, y - 0.02, z, 0.04, 0.04, 0.32, "var(--brass)", "brass")}
      {drawBox(
        p,
        x - 0.12,
        y - 0.22,
        z + 0.3,
        0.24,
        0.44,
        0.09,
        lit ? "var(--lamp-on)" : "var(--room-lamp)",
        "shade",
      )}
    </>
  );
}

/** Draws a cup of tisane on its saucer, standing at `(x, y, z)`. */
function drawCup(p: Projection, x: number, y: number, z: number): JSX.Element {
  return (
    <>
      {drawEllipse(p, x, y, z, 0.12, "saucer")}
      {drawBox(p, x - 0.055, y - 0.055, z, 0.11, 0.11, 0.1, "var(--room-paper)", "cup")}
    </>
  );
}

/**
 * Draws a leaf from stage point `from`, pointing at `angle` degrees (0 is
 * right, -90 is up), `length` pixels long and `width` pixels wide.
 */
function drawLeaf(
  from: StagePoint,
  angle: number,
  length: number,
  width: number,
  className: string,
): JSX.Element {
  const r = (angle * Math.PI) / 180;
  const ex = from[0] + Math.cos(r) * length;
  // A frond droops at its tip.
  const ey = from[1] + Math.sin(r) * length + length * 0.18;
  const mx = (from[0] + ex) / 2;
  const my = (from[1] + ey) / 2 - length * 0.12;
  const nx = -Math.sin(r) * width;
  const ny = Math.cos(r) * width;
  return (
    <path
      className={className}
      d={`M${formatTenths(from[0])} ${formatTenths(from[1])}Q${formatTenths(mx + nx)} ${formatTenths(my + ny)} ${formatTenths(ex)} ${formatTenths(ey)}Q${formatTenths(mx - nx)} ${formatTenths(my - ny)} ${formatTenths(from[0])} ${formatTenths(from[1])}Z`}
    />
  );
}

/** The fronds of a palm: each one's angle in degrees, its length as a share of the palm's, and its shade. */
const FRONDS: ReadonlyArray<readonly [number, number, number]> = [
  [-168, 0.9, 1],
  [-12, 0.9, 1],
  [-140, 1, 2],
  [-40, 1, 2],
  [-112, 1.05, 0],
  [-68, 1.05, 0],
  [-90, 0.8, 1],
];

/** Draws a palm in a lacquered planter with a brass band, the planter's back corner at `(x, y)`. */
export function drawPalm(p: Projection, x: number, y: number, tall: boolean): JSX.Element {
  const z = tall ? 0.72 : 0.42;
  const top = projectPoint(p, x + 0.28, y + 0.28, z);
  const length = p.tile * (tall ? 1.05 : 0.7);
  return (
    <>
      {drawEllipse(p, x + 0.28, y + 0.28, 0, 0.42, "shadow")}
      {drawBox(p, x, y, 0, 0.56, 0.56, z, "var(--room-inlay-2)", "planter")}
      {drawBox(p, x - 0.02, y - 0.02, z - 0.12, 0.6, 0.6, 0.06, "var(--brass)", "brass")}
      {FRONDS.map(([angle, share, shade], index) => (
        <Fragment key={index}>
          {drawLeaf(top, angle, length * share, length * 0.16, `leaf leaf--${shade}`)}
        </Fragment>
      ))}
    </>
  );
}

/** A desk in a wing, and who works at it. */
export interface DeskSeat {
  /** Where the colleague sits; the desk stands on the colleague's -x side. */
  readonly x: number;
  readonly y: number;
  /** The tint of the blotter: the project of the thread at the desk, if any. */
  readonly tint: ProjectTint | null;
  /** Who sits at the desk, idle, or `null` for an empty desk. */
  readonly colleague: Look | null;
}

/**
 * Draws a desk and whoever works at it, as the book's `desk()` draws an empty
 * desk or an idle colleague's: the lamp is dark, and an idle colleague has a
 * cup of tisane. The viewer sees the colleague's face with the desk behind it.
 * `receiver` is drawn on the desk in place of the lamp: the Triage desk's tube
 * receiver.
 */
export function drawDesk(p: Projection, seat: DeskSeat, receiver?: ReactNode): JSX.Element {
  const { x, y } = seat;
  const x0 = x - 1.42;
  const y0 = y - 0.6;
  return (
    <>
      {drawEllipse(p, x - 0.9, y, 0, 0.8, "shadow")}
      {drawBox(p, x0 + 0.06, y0 + 0.06, 0, 0.82, 0.3, DESK, "var(--room-wood)", "wood")}
      {drawBox(p, x0 + 0.06, y0 + 0.84, 0, 0.82, 0.3, DESK, "var(--room-wood)", "wood")}
      {drawBox(p, x0, y0, DESK, 0.96, 1.2, 0.06, "var(--brass)", "brass")}
      {drawPatch(p, x0 + 0.02, y0 + 0.02, 0.92, 1.16, "desk-top", DESK_SURFACE)}
      {drawPatch(
        p,
        x0 + 0.3,
        y0 + 0.2,
        0.56,
        0.8,
        "blotter",
        DESK_SURFACE,
        seat.tint === null ? undefined : { fill: `var(--proj-${seat.tint})` },
      )}
      {receiver ?? drawLamp(p, x0 + 0.2, y0 + 0.28, DESK_SURFACE, false)}
      {seat.colleague !== null && drawCup(p, x0 + 0.6, y0 + 0.9, DESK_SURFACE)}
      {drawStool(p, x, y)}
      {seat.colleague !== null && drawColleague(p, seat.colleague, "idle", x, y, 0.42)}
    </>
  );
}

/**
 * Draws your desk, its back corner at `(x0, y0)`: a lacquered partner's desk
 * with a leather chair on its far side, because you are the one looking out
 * over the floor. Its in-tray is empty.
 */
export function drawYourDesk(p: Projection, x0: number, y0: number): JSX.Element {
  const w = 3.0;
  const d = 1.3;
  return (
    <>
      {drawEllipse(p, x0 + 1.5, y0 + 0.4, 0, 1.4, "shadow")}
      {drawBox(p, x0 + 1.46, y0 - 0.6, 0, 0.08, 0.08, 0.4, "var(--brass)", "brass")}
      {drawBox(p, x0 + 1.1, y0 - 0.95, 0.4, 0.8, 0.76, 0.12, "var(--room-fabric)", "fabric")}
      {drawBox(p, x0 + 1.1, y0 - 1.05, 0.46, 0.8, 0.14, 0.78, "var(--room-fabric)", "fabric")}
      {drawBox(p, x0 + 0.08, y0 + 0.08, 0, 0.84, d - 0.16, DESK, "var(--room-inlay-2)", "lacquer")}
      {drawBox(
        p,
        x0 + w - 0.92,
        y0 + 0.08,
        0,
        0.84,
        d - 0.16,
        DESK,
        "var(--room-inlay-2)",
        "lacquer",
      )}
      {drawBox(
        p,
        x0 + 0.92,
        y0 + d - 0.2,
        0.28,
        w - 1.84,
        0.1,
        DESK - 0.28,
        "var(--room-inlay-2)",
        "lacquer",
      )}
      {drawBox(p, x0, y0, DESK, w, d, 0.06, "var(--brass)", "brass")}
      {drawPatch(
        p,
        x0 + 0.02,
        y0 + 0.02,
        w - 0.04,
        d - 0.04,
        "desk-top desk-top--you",
        DESK_SURFACE,
      )}
      {drawPatch(p, x0 + 0.9, y0 + 0.24, 1.2, 0.82, "blotter", DESK_SURFACE)}
      {drawLamp(p, x0 + 0.3, y0 + 0.36, DESK_SURFACE, true)}
      {drawBox(p, x0 + 2.2, y0 + 0.28, DESK_SURFACE, 0.6, 0.5, 0.04, "var(--room-wood)", "wood")}
      {drawCup(p, x0 + 1.8, y0 + 0.95, DESK_SURFACE)}
    </>
  );
}

/** Draws a hat stand at `(x, y)` with a homburg on its top hook. */
export function drawHatStand(p: Projection, x: number, y: number): JSX.Element {
  const [hx, hy] = projectPoint(p, x, y, 1.72);
  const u = p.tile;
  return (
    <>
      {drawEllipse(p, x, y, 0, 0.3, "shadow")}
      {drawEllipse(p, x, y, 0.02, 0.2, "lamp-foot")}
      {drawBox(p, x - 0.03, y - 0.03, 0, 0.06, 0.06, 1.7, "var(--brass)", "brass")}
      <g transform={`translate(${formatTenths(hx)} ${formatTenths(hy)})`}>
        <ellipse
          cx="0"
          cy={formatTenths(u * 0.1)}
          rx={formatTenths(u * 0.34)}
          ry={formatTenths(u * 0.1)}
          className="hat"
        />
        <path
          d={`M${formatTenths(-u * 0.2)} ${formatTenths(u * 0.1)}V${formatTenths(-u * 0.12)}Q0 ${formatTenths(-u * 0.26)} ${formatTenths(u * 0.2)} ${formatTenths(-u * 0.12)}V${formatTenths(u * 0.1)}Z`}
          className="hat hat--crown"
        />
        <path
          d={`M${formatTenths(-u * 0.2)} ${formatTenths(u * 0.02)}H${formatTenths(u * 0.2)}`}
          className="hat-band"
        />
      </g>
    </>
  );
}

/** Draws a club chair at `(x, y)`, facing the viewer, with a colleague asleep in it. */
export function drawClubChair(p: Projection, x: number, y: number, look: Look): JSX.Element {
  return (
    <>
      {drawEllipse(p, x, y, 0, 0.8, "shadow")}
      {drawBox(p, x - 0.6, y - 0.62, 0, 1.2, 0.34, 1.04, "var(--room-fabric)", "fabric")}
      {drawBox(p, x - 0.6, y - 0.28, 0, 0.3, 0.9, 0.62, "var(--room-fabric)", "fabric")}
      {drawBox(p, x - 0.3, y - 0.28, 0, 0.6, 0.9, 0.38, "var(--room-fabric)", "fabric")}
      {drawColleague(p, look, "asleep", x, y + 0.05, 0.38)}
      {drawBox(p, x + 0.3, y - 0.28, 0, 0.3, 0.9, 0.62, "var(--room-fabric)", "fabric")}
    </>
  );
}

/** Draws a round side table at `(x, y)` with a cup on it. */
export function drawSideTable(p: Projection, x: number, y: number): JSX.Element {
  return (
    <>
      {drawBox(p, x - 0.03, y - 0.03, 0, 0.06, 0.06, 0.56, "var(--brass)", "brass")}
      {drawEllipse(p, x, y, 0.56, 0.3, "table-side")}
      {drawEllipse(p, x, y, 0.6, 0.3, "table-top")}
      {drawCup(p, x + 0.05, y + 0.05, 0.6)}
    </>
  );
}

/** Draws a low sideboard against the right-hand wall from `x`, `w` tiles long, with the tisane service on it. */
export function drawSideboard(p: Projection, x: number, w: number): JSX.Element {
  return (
    <>
      {drawBox(p, x, 0, 0, w, 0.78, 0.92, "var(--room-wood)", "wood")}
      {drawBox(p, x - 0.02, -0.02, 0.92, w + 0.04, 0.82, 0.05, "var(--brass)", "brass")}
      {drawEllipse(p, x + 0.7, 0.4, 0.97, 0.2, "saucer")}
      {drawBox(p, x + 0.56, 0.26, 0.97, 0.28, 0.28, 0.26, "var(--room-paper)", "cup")}
      {drawBox(p, x + 0.66, 0.36, 1.23, 0.08, 0.08, 0.05, "var(--brass)", "brass")}
      {drawCup(p, x + 1.3, 0.34, 0.97)}
      {drawCup(p, x + 1.7, 0.44, 0.97)}
    </>
  );
}
