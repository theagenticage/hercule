/**
 * PROTOTYPE - the office's architecture: floors, walls, columns, signs, the
 * lift, the tubes, and the outdoors. The layouts import every builder from
 * this module; the larger builders live in `architecture-<topic>.ts` files
 * next to it and are re-exported here.
 *
 * Every builder returns an object whose origin sits on the floor, in the
 * middle of its footprint, with its front facing +z, unless its comment says
 * otherwise.
 *
 * Real dimensions, in metres, at the colleagues' doll's-house scale:
 *
 * - a wall is `WALL_THICKNESS` (0.12) thick and `WALL_HEIGHT` (2.6) tall;
 *   its panelled dado stands 0.01 proud of the plaster on both faces and
 *   ends in a rail at `CUTAWAY_HEIGHT` (0.55); the cap on top is 0.026
 *   thick and 0.18 wide;
 * - a doorway is `DOOR_HEIGHT` (1.72) tall and as wide as the layout asks;
 *   its stepped architrave adds 0.085 at each side and 0.16 on top;
 * - a window is `WINDOW_WIDTH` (0.8) wide, from a sill at 0.8 to a head at
 *   2.12, spaced `WINDOW_PITCH` (1.7) apart along the wall.
 */
import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  Object3D,
  PlaneGeometry,
  type MeshStandardMaterial,
} from "three";
import {
  CUTAWAY,
  CUTAWAY_HEIGHT,
  LAMP,
  WALL_HEIGHT,
  type Cutaway,
  type Lamp,
} from "../engine/contracts";
import { paint, type Token } from "../engine/palette";
import {
  buildMergedMesh,
  buildPaintedMesh,
  buildSlabSides,
  mergeParts,
  paintMix,
  placeBox,
} from "./architecture-shared";

export { buildPlaque, buildWordmark, measurePlaque } from "./architecture-signs";
export { buildLift, LIFT_CAR_INTERIOR, LIFT_FOOTPRINT, type LiftHandle } from "./architecture-lift";
export { buildTubes, type TubeHandle, type TubeOptions } from "./architecture-tubes";
export { buildLamppost, buildLawn, buildPath, buildTree } from "./architecture-outdoors";

/** The thickness of every wall. */
export const WALL_THICKNESS = 0.12;
/** The clear height of a doorway. */
export const DOOR_HEIGHT = 1.72;
/** The width of one window. */
export const WINDOW_WIDTH = 0.8;
/** The distance between the centres of two windows on a wall. */
export const WINDOW_PITCH = 1.7;

// ---------------------------------------------------------------------------
// Floors.

/** The side of one parquet square. */
const PARQUET_SQUARE = 0.8;
/** How far the inlaid border sits in from the floor's edge, clear of the dado. */
const BORDER_MARGIN = 0.32;
/** The brass strip on each side of the border band. */
const BORDER_STRIP = 0.022;
/** The coloured band of the border. */
const BORDER_BAND = 0.15;
/** How far a stepped corner square reaches past the border on each side. */
const CORNER_REACH = 0.06;
/** The floor slab's thickness under its top. */
const FLOOR_SLAB = 0.1;

/** The parts of a floor's top, each drawn in its own material. */
type FloorPart = "light" | "dark" | "strip" | "band" | "corner";

/**
 * Builds a floor `width` by `depth`. Its top is at y = 0. A two-tone parquet
 * field fills it, framed by a Deco border: a coloured band between two brass
 * strips, with a stepped square at each corner. The band is painted in
 * `inlay`, a project's low-chroma tint for a code room, so the room's project
 * reads from above; without one it is the plain floor inlay.
 *
 * The top is a grid of rectangles that never overlap, so nothing on it can
 * flicker at any distance.
 */
export function buildFloor(
  width: number,
  depth: number,
  options: { readonly inlay?: Token } = {},
): Object3D {
  const inlay = options.inlay ?? "room-inlay";
  const materials: Record<FloorPart, MeshStandardMaterial> = {
    light: paint("room-floor", "matte"),
    dark: paint("room-floor", "matte", { dl: -0.018, dc: 0.004 }),
    strip: paint("brass", "brass"),
    band: paint(inlay, "matte"),
    corner: paint(inlay, "matte", { dl: -0.07, dc: 0.01 }),
  };
  // A small floor scales its border down, so a cupboard-sized room still has one.
  const scale = Math.min(1, Math.min(width, depth) / 3);
  const margin = BORDER_MARGIN * scale;
  const ring = [margin, BORDER_STRIP, BORDER_BAND * scale, BORDER_STRIP];
  const ringWidth = ring.slice(1).reduce((sum, part) => sum + part, 0);
  const reach = CORNER_REACH * scale;

  const breaksAlong = (size: number): number[] => {
    const breaks = new Set<number>([0, size]);
    for (let at = PARQUET_SQUARE; at < size; at += PARQUET_SQUARE) breaks.add(at);
    let at = 0;
    for (const part of ring) {
      at += part;
      breaks.add(at);
      breaks.add(size - at);
    }
    breaks.add(margin - reach);
    breaks.add(margin + ringWidth + reach);
    breaks.add(size - margin + reach);
    breaks.add(size - margin - ringWidth - reach);
    return [...breaks].filter((value) => value >= 0 && value <= size).sort((a, b) => a - b);
  };

  /** Returns the part of the floor at a point, measured from the floor's corner. */
  const classify = (x: number, z: number): FloorPart => {
    const fromX = Math.min(x, width - x);
    const fromZ = Math.min(z, depth - z);
    const inCorner = (distance: number) =>
      distance > margin - reach && distance < margin + ringWidth + reach;
    if (inCorner(fromX) && inCorner(fromZ)) return "corner";
    const distance = Math.min(fromX, fromZ);
    if (distance > margin && distance < margin + ringWidth) {
      const into = distance - margin;
      return into < BORDER_STRIP || into > ringWidth - BORDER_STRIP ? "strip" : "band";
    }
    const parity = Math.floor(x / PARQUET_SQUARE) + Math.floor(z / PARQUET_SQUARE);
    return parity % 2 === 0 ? "light" : "dark";
  };

  const xs = breaksAlong(width);
  const zs = breaksAlong(depth);
  const quads: Record<FloorPart, number[]> = {
    light: [],
    dark: [],
    strip: [],
    band: [],
    corner: [],
  };
  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = 0; j < zs.length - 1; j++) {
      const x0 = xs[i]!;
      const x1 = xs[i + 1]!;
      const z0 = zs[j]!;
      const z1 = zs[j + 1]!;
      if (x1 - x0 < 1e-5 || z1 - z0 < 1e-5) continue;
      const part = classify((x0 + x1) / 2, (z0 + z1) / 2);
      const ax = x0 - width / 2;
      const bx = x1 - width / 2;
      const az = z0 - depth / 2;
      const bz = z1 - depth / 2;
      // Two triangles, counter-clockwise seen from above.
      quads[part].push(ax, 0, az, ax, 0, bz, bx, 0, bz, ax, 0, az, bx, 0, bz, bx, 0, az);
    }
  }
  const tops = (Object.keys(quads) as FloorPart[]).map((part) => {
    const positions = quads[part];
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    const normals = new Float32Array(positions.length);
    for (let index = 1; index < normals.length; index += 3) normals[index] = 1;
    geometry.setAttribute("normal", new Float32BufferAttribute(normals, 3));
    return [materials[part], positions.length === 0 ? [] : [geometry]] as const;
  });
  const object = new Group();
  const mesh = buildPaintedMesh(
    [
      ...tops,
      // The slab's four sides and its underside; its top is the grid above.
      [paint("room-floor", "matte", { dl: -0.12 }), [buildSlabSides(width, depth, FLOOR_SLAB)]],
    ],
    { cast: false },
  );
  if (mesh !== null) object.add(mesh);
  return object;
}

// ---------------------------------------------------------------------------
// Walls.

/** What a wall has: its height, its doors and windows, and whether the camera may lower it. */
export interface WallOptions {
  /** Default WALL_HEIGHT. */
  readonly height?: number;
  /** The doorways, by their centre's distance from the wall's middle along x, and their width. */
  readonly doors?: ReadonlyArray<{ readonly at: number; readonly width: number }>;
  readonly windows?: boolean;
  /**
   * Makes the wall one the camera can lower to the dado rail, for the room
   * it bounds. Its outward side, local +z, must point out of that room.
   */
  readonly cutaway?: { readonly roomId: string; readonly exterior: boolean };
}

/** How far the panelling stands proud of the plaster on each face. */
const DADO_PROUD = 0.01;
/** The dado rail's height, at the top of the dado. */
const RAIL_HEIGHT = 0.045;
/** The layer on top of the rail painted like the cap: thick enough not to flicker, too thin to see from the side. */
const RAIL_TOP = 0.002;
/** The cap on top of the wall: its thickness and its overhang past each face. */
const CAP_THICKNESS = 0.026;
const CAP_OVERHANG = 0.03;
/** The two steps of the crown moulding under the cap. */
const CROWN_STEPS = [
  { height: 0.035, proud: 0.022 },
  { height: 0.035, proud: 0.011 },
] as const;
const WINDOW_SILL = 0.8;
const WINDOW_HEAD = 2.12;
/** The fan-shaped transom at the top of a window. */
const WINDOW_TRANSOM = 0.36;

/** One opening in a wall, along its x. */
interface Opening {
  readonly from: number;
  readonly to: number;
  readonly bottom: number;
  readonly top: number;
}

/** The parts of a wall, sorted by material and by whether they stay when the wall is cut. */
interface WallParts {
  /** The panelled dado and the lower architraves: stays. */
  readonly dado: BufferGeometry[];
  /** The top of the dado rail and of the door trim's stubs, painted like the cap, so a cut wall ends in the wall-top colour: stays. */
  readonly railTop: BufferGeometry[];
  /** The rail's brass bead and the door thresholds: stays. */
  readonly brass: BufferGeometry[];
  /** Plaster and crown above the dado: lowered with the cut. */
  readonly plaster: BufferGeometry[];
  /** Sills and upper architraves: lowered with the cut. */
  readonly trim: BufferGeometry[];
  /** The cap on top of the wall, over solid stretches and doorways alike: lowered with the cut. */
  readonly cap: BufferGeometry[];
  /** Window frames and mullions: lowered with the cut. */
  readonly frames: BufferGeometry[];
  readonly innerGlass: BufferGeometry[];
  readonly outerGlass: BufferGeometry[];
}

/**
 * Builds a wall `length` long, along local x, centred on the origin, its
 * base at y = 0. Its outward side is local +z.
 *
 * Below `CUTAWAY_HEIGHT` it is a panelled dado under a wood rail with a brass
 * bead; above, plaster up to a stepped crown and a cap. Doorways get a
 * stepped Deco architrave and a brass threshold. With `windows`, tall Deco
 * windows with a fan transom are spaced along the wall clear of the doors;
 * their outer panes store a `Lamp` in `userData[LAMP]`, so at night they glow
 * warm, lit from inside.
 *
 * A wall built with `cutaway` stores a `Cutaway` in its `userData[CUTAWAY]`.
 * Cutting it squashes everything above the dado, cap included, down onto the
 * rail, whose top is painted like the cap, so a lowered wall ends in the
 * wall-top colour. `setCut` only moves and scales one group.
 *
 * The wall is one painted mesh, plus one for its window glass inside and one
 * outside. A cutaway wall has one painted mesh below the dado line and one
 * above it, because the part above moves.
 */
export function buildWall(length: number, options: WallOptions = {}): Object3D {
  const height = Math.max(options.height ?? WALL_HEIGHT, CUTAWAY_HEIGHT + 0.2);
  const half = length / 2;
  const plasterTop = height - CAP_THICKNESS;
  const doorTop = Math.min(DOOR_HEIGHT, plasterTop - 0.3);
  const doors: Opening[] = (options.doors ?? [])
    .map((door) => ({
      from: Math.max(-half, door.at - door.width / 2),
      to: Math.min(half, door.at + door.width / 2),
      bottom: 0,
      top: doorTop,
    }))
    .filter((door) => door.to - door.from > 0.01)
    .sort((a, b) => a.from - b.from);
  const windows = options.windows === true ? placeWindows(length, doors, plasterTop) : [];
  const parts: WallParts = {
    dado: [],
    railTop: [],
    brass: [],
    plaster: [],
    trim: [],
    cap: [],
    frames: [],
    innerGlass: [],
    outerGlass: [],
  };

  // The solid stretches between the doorways.
  const solids: Array<readonly [number, number]> = [];
  let start = -half;
  for (const door of doors) {
    if (door.from - start > 0.005) solids.push([start, door.from]);
    start = Math.max(start, door.to);
  }
  if (half - start > 0.005) solids.push([start, half]);

  for (const [from, to] of solids) addDado(parts, from, to);
  addPlaster(parts, length, height, [...doors, ...windows]);
  for (const door of doors) addDoor(parts, door, height, options.cutaway !== undefined);
  for (const window of windows) addWindow(parts, window);
  parts.cap.push(placeBox(length, CAP_THICKNESS, WALL_THICKNESS + 2 * CAP_OVERHANG, 0, plasterTop));

  const object = new Group();
  const upper = new Group();
  // The wall's top is the design book's: 72% wall, 28% shade.
  const capMaterial = paintMix("room-wall", "room-shade", 0.28, "satin");
  const panel = paint("room-panel", "satin");
  const brass = paint("brass", "brass");
  const below = [
    [panel, parts.dado],
    [capMaterial, parts.railTop],
    [brass, parts.brass],
  ] as const;
  const above = [
    [paint("room-wall", "matte"), parts.plaster],
    [panel, parts.trim],
    [capMaterial, parts.cap],
    [brass, parts.frames],
  ] as const;
  const add = (parent: Object3D, mesh: Mesh | null) => {
    if (mesh !== null) parent.add(mesh);
    return mesh;
  };
  if (options.cutaway === undefined) {
    add(object, buildPaintedMesh([...below, ...above]));
  } else {
    add(object, buildPaintedMesh(below));
    add(upper, buildPaintedMesh(above));
  }
  const glass = paint("room-sun", "glass");
  add(upper, buildMergedMesh(glass, parts.innerGlass, { cast: false, receive: false }));
  const outer = add(
    upper,
    buildMergedMesh(glass, parts.outerGlass, { cast: false, receive: false }),
  );
  object.add(upper);
  if (outer !== null) {
    const lamp: Lamp = {
      setOn(on) {
        outer.material = on ? paint("brass", "glow", { dl: 0.1, dc: -0.02 }) : glass;
      },
    };
    outer.userData[LAMP] = lamp;
  }

  if (options.cutaway !== undefined) {
    let current = 0;
    const cutaway: Cutaway = {
      ...options.cutaway,
      setCut(amount) {
        const cut = Math.min(1, Math.max(0, amount));
        if (cut === current) return;
        current = cut;
        // The upper part keeps its base on the rail while it shrinks toward it.
        upper.scale.y = Math.max(1 - cut, 1e-4);
        upper.position.y = CUTAWAY_HEIGHT * cut;
        upper.visible = cut < 0.995;
      },
    };
    object.userData[CUTAWAY] = cutaway;
  }
  return object;
}

/**
 * Returns the windows along a wall: as many as fit at `WINDOW_PITCH`,
 * centred, leaving out any that would crowd a doorway or the wall's ends.
 */
function placeWindows(
  length: number,
  doors: ReadonlyArray<Opening>,
  plasterTop: number,
): Opening[] {
  const top = Math.min(WINDOW_HEAD, plasterTop - 0.3);
  if (top - WINDOW_SILL < 0.6) return [];
  const count = Math.floor((length - 0.5) / WINDOW_PITCH);
  const windows: Opening[] = [];
  for (let index = 0; index < count; index++) {
    const centre = (index - (count - 1) / 2) * WINDOW_PITCH;
    const from = centre - WINDOW_WIDTH / 2;
    const to = centre + WINDOW_WIDTH / 2;
    const crowded = doors.some((door) => from < door.to + 0.3 && to > door.from - 0.3);
    if (!crowded) windows.push({ from, to, bottom: WINDOW_SILL, top });
  }
  return windows;
}

/** Adds the panelled dado of one solid stretch, on both faces: skirting, panels, rail and bead. */
function addDado(parts: WallParts, from: number, to: number): void {
  const length = to - from;
  const middle = (from + to) / 2;
  const face = WALL_THICKNESS / 2 + DADO_PROUD;
  parts.dado.push(placeBox(length, CUTAWAY_HEIGHT - RAIL_HEIGHT, face * 2, middle));
  parts.dado.push(placeBox(length, 0.07, (face + 0.012) * 2, middle));
  const rail = (face + 0.014) * 2;
  parts.dado.push(
    placeBox(length, RAIL_HEIGHT - RAIL_TOP, rail, middle, CUTAWAY_HEIGHT - RAIL_HEIGHT),
  );
  parts.railTop.push(placeBox(length, RAIL_TOP, rail, middle, CUTAWAY_HEIGHT - RAIL_TOP));
  parts.brass.push(
    placeBox(length, 0.012, (face + 0.009) * 2, middle, CUTAWAY_HEIGHT - RAIL_HEIGHT - 0.016),
  );
  // Raised panels between stiles, about 0.75 apart, on each face.
  const stile = 0.055;
  const bays = Math.max(1, Math.round(length / 0.75));
  const bay = length / bays;
  const panelBottom = 0.07 + 0.05;
  const panelTop = CUTAWAY_HEIGHT - RAIL_HEIGHT - 0.06;
  if (bay - 2 * stile < 0.12) return;
  for (let index = 0; index < bays; index++) {
    const centre = from + bay * (index + 0.5);
    for (const side of [-1, 1]) {
      parts.dado.push(
        placeBox(
          bay - 2 * stile,
          panelTop - panelBottom,
          0.012,
          centre,
          panelBottom,
          side * (face + 0.003),
        ),
      );
    }
  }
}

/**
 * Adds the plaster above the dado and the crown under the cap. The plaster
 * is cut into vertical strips at every opening's edges, so each strip is a
 * plain box around its openings.
 */
function addPlaster(
  parts: WallParts,
  length: number,
  height: number,
  openings: ReadonlyArray<Opening>,
): void {
  const half = length / 2;
  const top = height - CAP_THICKNESS;
  const edges = new Set<number>([-half, half]);
  for (const opening of openings) {
    edges.add(opening.from);
    edges.add(opening.to);
  }
  const xs = [...edges].sort((a, b) => a - b);
  for (let index = 0; index < xs.length - 1; index++) {
    const from = xs[index]!;
    const to = xs[index + 1]!;
    if (to - from < 1e-4) continue;
    const middle = (from + to) / 2;
    const hole = openings.find((opening) => opening.from <= middle && opening.to >= middle);
    const spans: Array<readonly [number, number]> =
      hole === undefined
        ? [[CUTAWAY_HEIGHT, top]]
        : [
            [CUTAWAY_HEIGHT, Math.max(CUTAWAY_HEIGHT, hole.bottom)],
            [hole.top, top],
          ];
    for (const [bottom, upper] of spans) {
      if (upper - bottom < 1e-4) continue;
      parts.plaster.push(placeBox(to - from, upper - bottom, WALL_THICKNESS, middle, bottom));
    }
  }
  let below = top;
  for (const step of CROWN_STEPS) {
    below -= step.height;
    parts.plaster.push(placeBox(length, step.height, WALL_THICKNESS + 2 * step.proud, 0, below));
  }
}

/** The two layers of a door's stepped architrave: width beside the opening, and depth past the plaster. */
const ARCHITRAVE = [
  { width: 0.085, proud: 0.03 },
  { width: 0.04, proud: 0.042 },
] as const;

/**
 * Adds a doorway's trim: a stepped architrave on both faces with a stepped
 * head, a lining in the reveal, and a brass threshold. Below the dado line
 * the trim stays when the wall is cut; above it, it is lowered with the
 * plaster. In a wall that can be cut (`cutaway`), the trim below the line
 * ends in a thin top painted like the rail's top.
 */
function addDoor(parts: WallParts, door: Opening, height: number, cutaway: boolean): void {
  const { from, to, top } = door;
  const middle = (from + to) / 2;
  const width = to - from;
  /**
   * Adds a box spanning y0 to y1, split at the dado line. In a cutaway wall,
   * a box that crosses the line gets a thin top on its lower part, painted
   * like the rail's top: the stubs overlap the rail's end, and a cut doorway
   * would otherwise show two colours flickering in one plane there. Other
   * walls go without, because the thin top's edge shows as a hairline across
   * the architrave and nothing there ever needs covering.
   */
  const addTrim = (w: number, y0: number, y1: number, d: number, x: number, z: number) => {
    const split = Math.min(Math.max(CUTAWAY_HEIGHT, y0), y1);
    const crosses = cutaway && y0 < CUTAWAY_HEIGHT - RAIL_TOP && y1 > CUTAWAY_HEIGHT;
    const stub = crosses ? split - RAIL_TOP : split;
    if (stub - y0 > 1e-4) parts.dado.push(placeBox(w, stub - y0, d, x, y0, z));
    if (crosses) parts.railTop.push(placeBox(w, RAIL_TOP, d, x, stub, z));
    if (y1 - split > 1e-4) parts.trim.push(placeBox(w, y1 - split, d, x, split, z));
  };
  for (const side of [-1, 1]) {
    for (const layer of ARCHITRAVE) {
      const depth = layer.proud + 0.004;
      const z = side * (WALL_THICKNESS / 2 + layer.proud - depth / 2);
      addTrim(layer.width, 0, top + layer.width, depth, from - layer.width / 2, z);
      addTrim(layer.width, 0, top + layer.width, depth, to + layer.width / 2, z);
      addTrim(width, top, top + layer.width, depth, middle, z);
    }
    // The stepped head: two blocks over the middle, like a ziggurat.
    const outer = ARCHITRAVE[0];
    const stepDepth = outer.proud + 0.004;
    const z = side * (WALL_THICKNESS / 2 + outer.proud - stepDepth / 2);
    const headTop = top + outer.width;
    if (headTop + 0.08 < height - CAP_THICKNESS - 0.08) {
      addTrim(Math.min(0.34, width * 0.5), headTop, headTop + 0.045, stepDepth, middle, z);
      addTrim(Math.min(0.16, width * 0.25), headTop + 0.045, headTop + 0.08, stepDepth, middle, z);
    }
  }
  // The lining of the reveal, and its soffit.
  const lining = WALL_THICKNESS + 2 * 0.026;
  addTrim(0.014, 0, top, lining, from + 0.007, 0);
  addTrim(0.014, 0, top, lining, to - 0.007, 0);
  addTrim(width, top - 0.014, top, lining, middle, 0);
  parts.brass.push(placeBox(width, 0.006, WALL_THICKNESS + 0.06, middle));
}

/**
 * Adds a window: a brass frame with a transom, two mullions and a glazing
 * bar below it, a sunburst fan above it, a pane of glass on each side, and a
 * sill inside and out.
 */
function addWindow(parts: WallParts, window: Opening): void {
  const { from, to, bottom, top } = window;
  const width = to - from;
  const middle = (from + to) / 2;
  const frame = 0.03;
  const frameDepth = 0.05;
  const transom = top - WINDOW_TRANSOM;
  parts.frames.push(
    placeBox(frame, top - bottom, frameDepth, from + frame / 2, bottom),
    placeBox(frame, top - bottom, frameDepth, to - frame / 2, bottom),
    placeBox(width, frame, frameDepth, middle, top - frame),
    placeBox(width, frame, frameDepth, middle, bottom),
    placeBox(width, 0.022, 0.04, middle, transom - 0.011),
    placeBox(width, 0.014, 0.032, middle, (bottom + transom) / 2 - 0.007),
  );
  for (const third of [1, 2]) {
    parts.frames.push(placeBox(0.016, transom - bottom, 0.032, from + (width * third) / 3, bottom));
  }
  // The fan: rays from a boss on the transom bar, ringed by an arc.
  const radius = Math.min(width / 2, WINDOW_TRANSOM) - 0.07;
  for (let ray = 1; ray < 6; ray++) {
    const angle = (ray * Math.PI) / 6;
    const rayGeometry = placeBox(0.012, radius, 0.026, 0, 0)
      .rotateZ(angle - Math.PI / 2)
      .translate(middle, transom, 0);
    parts.frames.push(rayGeometry);
  }
  parts.frames.push(fanArc(radius, 0.008).translate(middle, transom, 0));
  parts.frames.push(fanArc(0.05, 0.022).translate(middle, transom, 0));
  // Two panes back to back: each is seen from its own side only.
  const pane = (facing: 1 | -1) => {
    const geometry = new PlaneGeometry(width - 0.01, top - bottom - 0.01);
    if (facing === -1) geometry.rotateY(Math.PI);
    return geometry.translate(middle, (bottom + top) / 2, facing * 0.004);
  };
  parts.innerGlass.push(pane(-1));
  parts.outerGlass.push(pane(1));
  // The sills: a deeper one inside, a narrower one outside.
  const inside = WALL_THICKNESS / 2 + 0.05;
  parts.trim.push(placeBox(width + 0.12, 0.03, inside, middle, bottom - 0.024, -inside / 2));
  const outside = WALL_THICKNESS / 2 + 0.035;
  parts.trim.push(placeBox(width + 0.08, 0.026, outside, middle, bottom - 0.03, outside / 2));
}

/** Returns a half ring of `radius` above the origin, in the x-y plane, made of a round bar `bar` thick. */
function fanArc(radius: number, bar: number): BufferGeometry {
  const segments = 22;
  const parts: BufferGeometry[] = [];
  for (let index = 0; index < segments; index++) {
    const a0 = (index / segments) * Math.PI;
    const a1 = ((index + 1) / segments) * Math.PI;
    const chord = 2 * radius * Math.sin((a1 - a0) / 2) + bar * 0.4;
    const angle = (a0 + a1) / 2;
    parts.push(
      placeBox(chord, bar, bar * 1.6, 0, -bar / 2)
        .rotateZ(angle - Math.PI / 2)
        .translate(Math.cos(angle) * radius, Math.sin(angle) * radius, 0),
    );
  }
  return mergeParts(parts)!;
}

// ---------------------------------------------------------------------------
// Columns.

/**
 * Builds a Deco pilaster `height` tall, 0.37 across at its capital: a dark
 * stepped base, a fluted shaft, and a stepped capital with a brass band.
 * Free-standing it reads as a square column; set into a wall, as a pilaster.
 */
export function buildColumn(height: number = WALL_HEIGHT): Object3D {
  const object = new Group();
  const base: BufferGeometry[] = [placeBox(0.37, 0.08, 0.37), placeBox(0.32, 0.06, 0.32, 0, 0.08)];
  const shaft: BufferGeometry[] = [];
  const brass: BufferGeometry[] = [];
  const shaftBottom = 0.14;
  const shaftTop = height - 0.3;
  const core = 0.24;
  shaft.push(placeBox(core, shaftTop - shaftBottom, core, 0, shaftBottom));
  // Four fillets per face stand proud of the core; the gaps between them read as flutes.
  const fillet = 0.026;
  for (let face = 0; face < 4; face++) {
    for (let index = 0; index < 4; index++) {
      const along = -core / 2 + fillet / 2 + (index * (core - fillet)) / 3;
      const geometry = placeBox(
        fillet,
        shaftTop - shaftBottom,
        0.016,
        along,
        shaftBottom,
        core / 2,
      );
      shaft.push(geometry.rotateY((face * Math.PI) / 2));
    }
  }
  brass.push(placeBox(0.285, 0.03, 0.285, 0, shaftTop));
  brass.push(placeBox(0.3, 0.012, 0.3, 0, shaftBottom - 0.006));
  const steps = [
    { size: 0.27, rise: 0.08 },
    { size: 0.31, rise: 0.07 },
    { size: 0.35, rise: 0.06 },
  ];
  let y = shaftTop + 0.03;
  for (const step of steps) {
    shaft.push(placeBox(step.size, step.rise, step.size, 0, y));
    y += step.rise;
  }
  base.push(placeBox(0.37, height - y, 0.37, 0, y));
  object.add(
    buildPaintedMesh([
      [paint("room-inlay-2", "gloss"), base],
      [paint("room-wall", "satin"), shaft],
      [paint("brass", "brass"), brass],
    ])!,
  );
  return object;
}
