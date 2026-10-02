import { Fragment, type JSX } from "react";
import { GitHubMark, LogoMark } from "../../logos";
import { DESK_SURFACE, drawBox, drawPatch, drawQuad } from "./furniture";
import {
  formatPoints,
  formatTenths,
  placeOnBackWall,
  placeOnFloor,
  placeOnSideWall,
  projectPoint,
  ROOM_DEPTH,
  ROOM_WIDTH,
  WALL_HEIGHT,
  type Projection,
} from "./projection";

// The shell of the Office, ported from the Bureau book's office.js: the floor,
// the walls with their wainscot, the windows and what hangs on the walls, and
// the inlay in the floor. The markup is the book's, element for element and in
// the same nesting, because office.css styles some of it by position.

/** Where the plaques of the Connections hang on the left-hand wall: their span along y, in tiles. */
const PLAQUES_Y: readonly [number, number] = [0.4, 5.0];
/** The height of the top of the plaque rail, in tiles. */
const PLAQUES_Z = 3.0;
/** The height of the brass pipe along the wall that gathers every tube, in tiles. */
const MANIFOLD_Z = 1.5;
/** Where along y the gathered tube leaves the wall for the Triage desk, in tiles. */
export const TUBE_Y = 3.2;
/** How many plaques the rail is spaced for. */
const PLAQUE_SLOTS = 8;

/** Draws tall windows with a fan-shaped transom on the left-hand wall, from `y1` to `y2`, and the sun they let in. */
function drawWindowPair(p: Projection, y1: number, y2: number): JSX.Element {
  const u = p.tile;
  const w = (y2 - y1) * u;
  const h = 1.85 * u;
  // the transom's height
  const t = 0.5 * u;
  let rays = "";
  for (let i = 1; i < 6; i++) {
    const a = Math.PI + (i * Math.PI) / 6;
    rays += `M${formatTenths(w / 2)} ${formatTenths(t)}L${formatTenths(w / 2 + Math.cos(a) * t * 0.86)} ${formatTenths(t + Math.sin(a) * t * 0.86)}`;
  }
  const at = (x: number, y: number) => projectPoint(p, x, y, 0);
  return (
    <>
      <g transform={placeOnSideWall(p, 0.01, y2, 2.9)}>
        <rect width={formatTenths(w)} height={formatTenths(h)} rx="3" className="window" />
        <path
          className="mullion"
          d={`M0 ${formatTenths(t)}H${formatTenths(w)}M${formatTenths(w / 3)} ${formatTenths(t)}V${formatTenths(h)}M${formatTenths((w * 2) / 3)} ${formatTenths(t)}V${formatTenths(h)}M0 ${formatTenths(t + (h - t) / 2)}H${formatTenths(w)}`}
        />
        <path
          className="mullion mullion--fan"
          d={`M${formatTenths(w / 2 - t * 0.86)} ${formatTenths(t)}A${formatTenths(t * 0.86)} ${formatTenths(t * 0.86)} 0 0 1 ${formatTenths(w / 2 + t * 0.86)} ${formatTenths(t)}${rays}`}
        />
        <rect width={formatTenths(w)} height={formatTenths(h)} rx="3" className="window-frame" />
        <rect
          y={formatTenths(h + 3)}
          x="-5"
          width={formatTenths(w + 10)}
          height="4"
          rx="2"
          className="sill"
        />
      </g>
      {drawQuad(at(0, y1 + 0.4), at(0, y2 + 0.4), at(2.8, y2 + 1.9), at(2.8, y1 + 1.9), "sun")}
    </>
  );
}

/** Draws a clock hand at `degrees` clockwise from twelve, `length` pixels long. */
function drawHand(degrees: number, length: number, className: string): JSX.Element {
  const a = (degrees * Math.PI) / 180;
  return (
    <path
      className={className}
      d={`M0 0L${formatTenths(Math.sin(a) * length)} ${formatTenths(-Math.cos(a) * length)}`}
    />
  );
}

/** Draws a sunburst clock on the right-hand wall, centred at `(x, z)`, showing 09:41. */
function drawClock(p: Projection, x: number, z: number): JSX.Element {
  const r = 0.34 * p.tile;
  let rays = "";
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const reach = i % 2 === 0 ? 1.7 : 1.4;
    rays += `M${formatTenths(Math.cos(a) * r * 1.12)} ${formatTenths(Math.sin(a) * r * 1.12)}L${formatTenths(Math.cos(a) * r * reach)} ${formatTenths(Math.sin(a) * r * reach)}`;
  }
  return (
    <g transform={placeOnBackWall(p, x, 0.01, z)}>
      <path className="clock-rays" d={rays} />
      <circle r={formatTenths(r)} className="clock" />
      {drawHand((9 + 41 / 60) * 30, r * 0.5, "hand hand--h")}
      {drawHand(41 * 6, r * 0.78, "hand")}
      <circle r={formatTenths(p.tile * 0.05)} className="hand-dot" />
    </g>
  );
}

/** Draws the wordmark on the right-hand wall from `(x, z)`: the logo mark and the name in the Deco face over a brass rule. */
function drawWordmark(p: Projection, x: number, z: number): JSX.Element {
  const u = p.tile;
  return (
    <>
      <g transform={placeOnBackWall(p, x, 0.01, z + 0.02)}>
        <LogoMark size={Math.round(u * 0.95)} />
      </g>
      <g transform={placeOnBackWall(p, x + 1.18, 0.01, z - 0.74)}>
        <text className="wall-word" style={{ fontSize: `${formatTenths(u * 0.78)}px` }}>
          Hercule
        </text>
      </g>
      <g transform={placeOnBackWall(p, x, 0.01, z - 1.02)}>
        <path
          className="brass-rule"
          d={`M0 0H${formatTenths(u * 5.1)}M0 5H${formatTenths(u * 5.1)}`}
        />
      </g>
    </>
  );
}

/**
 * Draws the rail of Connection plaques on the left-hand wall, spaced for
 * eight. With `gitHubConnected`, the GitHub plaque hangs first: its mark over a brass
 * mouth, with a tube from the mouth into the manifold along the wall. Without
 * it the rail is bare. The collar where the tube leaves the wall for the
 * Triage desk is always fitted.
 *
 * The book sends capsules down the tubes; the room draws none, because
 * nothing moves in the room unless something is happening.
 */
function drawTubeWall(p: Projection, gitHubConnected: boolean): JSX.Element {
  const u = p.tile;
  const span = (PLAQUES_Y[1] - PLAQUES_Y[0]) * u;
  const pitch = span / PLAQUE_SLOTS;
  const mouthY = 0.52 * u;
  const pipeY = (PLAQUES_Z - MANIFOLD_Z) * u;
  const joinX = (PLAQUES_Y[1] - TUBE_Y) * u;
  // The one plaque, in the first slot.
  const mx = pitch * 0.5;
  const m = 0.26 * u;
  // The tube from the mouth down to the manifold, then the manifold from the mouth to the collar.
  const tubes = gitHubConnected
    ? `M${formatTenths(mx)} ${formatTenths(mouthY)}V${formatTenths(pipeY)}M${formatTenths(Math.min(pitch * 0.5, joinX))} ${formatTenths(pipeY)}H${formatTenths(Math.max(pitch * 0.5, joinX))}`
    : "";
  return (
    <g transform={placeOnSideWall(p, 0.01, PLAQUES_Y[1], PLAQUES_Z)}>
      <rect
        x="-4"
        y="-4"
        width={formatTenths(span + 8)}
        height={formatTenths(0.8 * u)}
        rx="3"
        className="plaque-rail"
      />
      <g className="flow">
        <path className="tube" d={tubes} />
        <rect
          x={formatTenths(joinX - 5)}
          y={formatTenths(pipeY - 5)}
          width="10"
          height="10"
          rx="3"
          className="collar"
        />
      </g>
      {gitHubConnected && (
        <>
          <g
            className="plaque-mark"
            transform={`translate(${formatTenths(mx - m / 2)} ${formatTenths(0.06 * u)})`}
          >
            <GitHubMark size={m} />
          </g>
          <circle
            cx={formatTenths(mx)}
            cy={formatTenths(mouthY)}
            r={formatTenths(0.13 * u)}
            className="mouth"
          />
          <circle
            cx={formatTenths(mx)}
            cy={formatTenths(mouthY)}
            r={formatTenths(0.07 * u)}
            className="mouth-in"
          />
        </>
      )}
    </g>
  );
}

/**
 * Draws the tube from the manifold on the wall to the receiver on the Triage
 * desk, which stands at `x` along the tube's line. The book sends capsules
 * along it; the room draws none.
 */
export function drawTubeToDesk(p: Projection, x: number): JSX.Element {
  const a = projectPoint(p, 0.02, TUBE_Y, MANIFOLD_Z);
  const b = projectPoint(p, x, TUBE_Y, MANIFOLD_Z);
  const c = projectPoint(p, x, TUBE_Y, DESK_SURFACE + 0.3);
  return (
    <g className="flow">
      {drawBox(p, x - 0.15, TUBE_Y - 0.15, DESK_SURFACE, 0.3, 0.3, 0.3, "var(--brass)", "brass")}
      <path
        className="tube tube--main"
        d={`M${formatTenths(a[0])} ${formatTenths(a[1])}L${formatTenths(b[0])} ${formatTenths(b[1])}L${formatTenths(c[0])} ${formatTenths(c[1])}`}
      />
    </g>
  );
}

/**
 * Draws a wing's inlaid field on the floor: a double border with stepped
 * corners, and the runner's name and `note` engraved in the aisle in front of
 * it, where no desk can stand over the words.
 */
export function drawWingField(
  p: Projection,
  wing: { readonly x: number; readonly y: number; readonly w: number; readonly d: number },
  label: readonly [number, number],
  runnerName: string,
  note: string,
): JSX.Element {
  const { x, y, w, d } = wing;
  const corners: ReadonlyArray<readonly [number, number]> = [
    [x + 0.08, y + 0.08],
    [x + w - 0.44, y + 0.08],
    [x + 0.08, y + d - 0.44],
    [x + w - 0.44, y + d - 0.44],
  ];
  return (
    <>
      {drawPatch(p, x, y, w, d, "field")}
      {drawPatch(p, x + 0.16, y + 0.16, w - 0.32, d - 0.32, "field-line")}
      {drawPatch(p, x + 0.34, y + 0.34, w - 0.68, d - 0.68, "field-line field-line--thin")}
      {corners.map(([cx, cy]) => (
        <Fragment key={`${cx},${cy}`}>{drawPatch(p, cx, cy, 0.36, 0.36, "field-corner")}</Fragment>
      ))}
      <g transform={placeOnFloor(p, label[0], label[1])}>
        <text className="engrave" style={{ fontSize: `${formatTenths(p.tile * 0.4)}px` }}>
          <tspan className="engrave-name">{runnerName}</tspan>
          {`   ${note}`}
        </text>
      </g>
    </>
  );
}

/** Draws the sunburst inlaid in the lobby floor, centred on `(cx, cy)`, `r` tiles across from its centre. */
function drawMedallion(p: Projection, cx: number, cy: number, r: number): JSX.Element {
  const R = r * p.tile;
  let rays = "";
  for (let i = 0; i < 16; i++) {
    const a0 = (i / 16) * Math.PI * 2;
    const a1 = a0 + Math.PI / 16;
    rays +=
      `M${formatTenths(R + Math.cos(a0) * R * 0.34)} ${formatTenths(R + Math.sin(a0) * R * 0.34)}` +
      `L${formatTenths(R + Math.cos(a0) * R * 0.86)} ${formatTenths(R + Math.sin(a0) * R * 0.86)}` +
      `L${formatTenths(R + Math.cos(a1) * R * 0.86)} ${formatTenths(R + Math.sin(a1) * R * 0.86)}Z`;
  }
  return (
    <g transform={placeOnFloor(p, cx - r, cy - r)}>
      <circle cx={formatTenths(R)} cy={formatTenths(R)} r={formatTenths(R)} className="med" />
      <circle
        cx={formatTenths(R)}
        cy={formatTenths(R)}
        r={formatTenths(R * 0.93)}
        className="med-line"
      />
      <path className="med-ray" d={rays} />
      <circle
        cx={formatTenths(R)}
        cy={formatTenths(R)}
        r={formatTenths(R * 0.3)}
        className="med-core"
      />
    </g>
  );
}

/**
 * Draws the shell of the room: the floor slab and its parquet, the walls with
 * their wainscot and rails, the windows, the wordmark and the clock, the
 * plaque rail, and the sunburst in the lobby floor.
 *
 * `parquetId` names the parquet's pattern, so it must be unique on the page.
 * With `gitHubConnected`, the GitHub plaque hangs on the rail.
 */
export function drawRoomShell(
  p: Projection,
  parquetId: string,
  gitHubConnected: boolean,
): JSX.Element {
  const W = ROOM_WIDTH;
  const D = ROOM_DEPTH;
  const H = WALL_HEIGHT;
  const at = (x: number, y: number, z: number) => projectPoint(p, x, y, z);
  const u = p.tile;
  let seams = "";
  for (let i = 1.15; i < W; i += 1.15)
    seams += `M${formatPoints([at(i, 0, 0.08)])}L${formatPoints([at(i, 0, 0.88)])}`;
  for (let i = 1.15; i < D; i += 1.15)
    seams += `M${formatPoints([at(0, i, 0.08)])}L${formatPoints([at(0, i, 0.88)])}`;
  return (
    <>
      {drawBox(p, 0, 0, -0.5, W, D, 0.5, "var(--room-floor)", "slab")}
      <g transform={placeOnFloor(p, 0, 0)}>
        <defs>
          <pattern
            id={parquetId}
            width={formatTenths(2 * u)}
            height={formatTenths(2 * u)}
            patternUnits="userSpaceOnUse"
          >
            <rect width={formatTenths(u)} height={formatTenths(u)} className="pq" />
            <rect
              x={formatTenths(u)}
              y={formatTenths(u)}
              width={formatTenths(u)}
              height={formatTenths(u)}
              className="pq"
            />
          </pattern>
        </defs>
        <rect
          width={formatTenths(W * u)}
          height={formatTenths(D * u)}
          fill={`url(#${parquetId})`}
        />
      </g>
      <g className="wall">
        {drawQuad(at(-0.4, -0.4, H), at(W, -0.4, H), at(W, 0, H), at(-0.4, 0, H), "wall-top")}
        {drawQuad(at(0, 0, 0), at(W, 0, 0), at(W, 0, H), at(0, 0, H), "wall-in wall-in--b")}
        {drawQuad(at(W, -0.4, -0.5), at(W, 0, -0.5), at(W, 0, H), at(W, -0.4, H), "wall-end")}
        {drawQuad(at(-0.4, 0, H), at(0, 0, H), at(0, D, H), at(-0.4, D, H), "wall-top")}
        {drawQuad(at(0, 0, 0), at(0, D, 0), at(0, D, H), at(0, 0, H), "wall-in wall-in--s")}
        {drawQuad(at(-0.4, D, -0.5), at(0, D, -0.5), at(0, D, H), at(-0.4, D, H), "wall-end")}
        {/* the wainscot: wood panels to hip height under a brass rail */}
        {drawQuad(at(0, 0, 0), at(W, 0, 0), at(W, 0, 0.95), at(0, 0, 0.95), "wainscot")}
        {drawQuad(at(0, 0, 0), at(0, D, 0), at(0, D, 0.95), at(0, 0, 0.95), "wainscot wainscot--s")}
        {drawQuad(at(0, 0, 0.95), at(W, 0, 0.95), at(W, 0, 1.0), at(0, 0, 1.0), "rail")}
        {drawQuad(at(0, 0, 0.95), at(0, D, 0.95), at(0, D, 1.0), at(0, 0, 1.0), "rail rail--s")}
        {drawQuad(
          at(0, 0, H - 0.08),
          at(W, 0, H - 0.08),
          at(W, 0, H - 0.05),
          at(0, 0, H - 0.05),
          "rail",
        )}
        {drawQuad(
          at(0, 0, H - 0.08),
          at(0, D, H - 0.08),
          at(0, D, H - 0.05),
          at(0, 0, H - 0.05),
          "rail rail--s",
        )}
      </g>
      <path className="seams" d={seams} />
      {drawPatch(p, 0, 0, W, 0.6, "ao")}
      {drawPatch(p, 0, 0, 0.6, D, "ao")}
      {drawWindowPair(p, 6.8, 10.0)}
      {drawWindowPair(p, 11.4, 14.6)}
      {drawWordmark(p, 10.6, 2.98)}
      {drawClock(p, 18.4, 2.3)}
      {drawTubeWall(p, gitHubConnected)}
      {drawMedallion(p, 16.6, 16.9, 1.2)}
    </>
  );
}
