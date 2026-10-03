/**
 * PROTOTYPE - the small pieces every building of the campus shares: reading
 * spots and seats from markers, collecting the nav graph's obstacles, walls
 * around a rectangle, rugs in a project's tint, and the Deco portal that
 * stands at a building's door with its name on it.
 *
 * The campus is built in world space: every building is a group at the
 * origin whose children sit at their world positions, and nothing is ever
 * turned by anything but a quarter turn, so an object's world box is its
 * footprint and the nav graph can block it as is.
 */
import { Box3, Group, Mesh, Object3D, Vector3 } from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type {
  CameraView,
  DeskHandle,
  NavBuilder,
  RoomInfo,
  RoomKind,
  Seat,
  Spot,
} from "../engine/contracts";
import { WALL_HEIGHT } from "../engine/contracts";
import { paint, type Token } from "../engine/palette";
import { buildColumn, buildPlaque, buildWall, WALL_THICKNESS } from "../kit/architecture";
import type { ProjectKey } from "../world/types";

/** A rectangle on the ground, in world x and z. */
export interface Rect {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

/** The four sides of a rectangle, by the compass: north is -z, east is +x. */
export type Side = "north" | "south" | "east" | "west";

/** Returns the rectangle `width` by `depth` centred on (x, z). */
export function centreRect(x: number, z: number, width: number, depth: number): Rect {
  return { minX: x - width / 2, minZ: z - depth / 2, maxX: x + width / 2, maxZ: z + depth / 2 };
}

/** Returns a rectangle's centre on the ground, at y = 0. */
export function readRectCentre(rect: Rect): Vector3 {
  return new Vector3((rect.minX + rect.maxX) / 2, 0, (rect.minZ + rect.maxZ) / 2);
}

// ---------------------------------------------------------------------------
// Rooms.

/** The camera's vertical field of view, in degrees. */
const FIELD_OF_VIEW = 28;
/** The narrowest canvas a view has to fit: the window less the sidebar, width over height. */
const ASPECT = 1.3;

/**
 * Returns the camera view of a rectangle from the south-east: the camera
 * backs off until every corner of the rectangle, from the floor to the
 * height of a desk lamp, is on screen, with `margin` to spare. Room views
 * and the overview use it.
 */
export function frameRect(rect: Rect, margin = 1.04): CameraView {
  const azimuth = 40;
  const elevation = 44;
  const az = (azimuth * Math.PI) / 180;
  const el = (elevation * Math.PI) / 180;
  const back = new Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
  const right = new Vector3(0, 1, 0).cross(back).normalize();
  const up = back.clone().cross(right).normalize();
  // Along the ground, away from the camera: moving the target this way moves the picture down.
  const forward = new Vector3(-back.x, 0, -back.z).normalize();
  const tanY = Math.tan(((FIELD_OF_VIEW / 2) * Math.PI) / 180);
  const tanX = tanY * ASPECT;
  const corners: Vector3[] = [];
  for (const x of [rect.minX, rect.maxX]) {
    for (const z of [rect.minZ, rect.maxZ]) {
      for (const y of [0, 1.2]) corners.push(new Vector3(x, y, z));
    }
  }
  const offset = new Vector3();
  const measureDistance = (target: Vector3): number => {
    let distance = 0;
    for (const corner of corners) {
      offset.copy(corner).sub(target);
      // A corner nearer the camera needs the camera farther back to fit it.
      const toward = offset.dot(back);
      distance = Math.max(
        distance,
        toward + Math.abs(offset.dot(right)) / tanX,
        toward + Math.abs(offset.dot(up)) / tanY,
      );
    }
    return distance;
  };
  const target = readRectCentre(rect).setY(0.4);
  let distance = measureDistance(target);
  // Perspective draws the near corners larger, so a frame round the centre
  // leaves more room above the picture than below it. The target moves until
  // the corners sit evenly round the middle of the screen.
  for (let pass = 0; pass < 4; pass++) {
    let left = Infinity;
    let rightmost = -Infinity;
    let bottom = Infinity;
    let top = -Infinity;
    for (const corner of corners) {
      offset.copy(corner).sub(target);
      const depth = distance - offset.dot(back);
      left = Math.min(left, offset.dot(right) / depth);
      rightmost = Math.max(rightmost, offset.dot(right) / depth);
      bottom = Math.min(bottom, offset.dot(up) / depth);
      top = Math.max(top, offset.dot(up) / depth);
    }
    target.addScaledVector(right, ((left + rightmost) / 2) * distance);
    target.addScaledVector(forward, (((bottom + top) / 2) * distance) / Math.sin(el));
    distance = measureDistance(target);
  }
  return { target, distance: distance * margin, azimuth, elevation };
}

/** Returns the room info of a rectangle, its box from the floor to the top of the walls. */
export function buildRoomInfo(
  id: string,
  label: string,
  kind: RoomKind,
  rect: Rect,
  project: string | null,
): RoomInfo {
  return {
    id,
    label,
    kind,
    floor: 0,
    bounds: new Box3(
      new Vector3(rect.minX, 0, rect.minZ),
      new Vector3(rect.maxX, WALL_HEIGHT, rect.maxZ),
    ),
    view: frameRect(rect),
    project,
  };
}

// ---------------------------------------------------------------------------
// Spots and seats.

const direction = new Vector3();

/**
 * Reads a spot from a marker: its world position, and the way its local +z
 * points as a yaw. The marker's world matrix must be up to date.
 */
export function readSpot(marker: Object3D): Spot {
  marker.getWorldDirection(direction);
  return {
    position: marker.getWorldPosition(new Vector3()).setY(0),
    facing: Math.atan2(direction.x, direction.z),
    floor: 0,
  };
}

/** Reads a seat from a marker, see `readSpot`. */
export function readSeat(
  marker: Object3D,
  kind: Seat["kind"],
  roomId: string,
  desk: DeskHandle | null,
): Seat {
  return { ...readSpot(marker), kind, roomId, desk };
}

/** Returns a marker at (x, z) on the ground, facing `facing` (yaw; 0 faces +z). */
export function placeMarker(parent: Object3D, x: number, z: number, facing: number): Object3D {
  const marker = new Object3D();
  marker.position.set(x, 0, z);
  marker.rotation.y = facing;
  parent.add(marker);
  return marker;
}

// ---------------------------------------------------------------------------
// The nav graph's obstacles.

/**
 * The obstacles and doors a building declares while it is built. They reach
 * the nav graph only through `applyTo`, after the whole campus is placed,
 * because `blockObject` reads an object's world box.
 */
export interface NavPlan {
  blockObject(object: Object3D, padding?: number): void;
  block(rect: Rect): void;
  open(rect: Rect): void;
  /**
   * Hands every obstacle, then every opening, to the nav builder. The nav
   * replays its marks in call order, so the doors must come last.
   */
  applyTo(nav: NavBuilder): void;
}

/** Creates an empty nav plan. */
export function createNavPlan(): NavPlan {
  const objects: Array<{ readonly object: Object3D; readonly padding: number }> = [];
  const blocks: Rect[] = [];
  const openings: Rect[] = [];
  return {
    blockObject(object, padding = 0) {
      objects.push({ object, padding });
    },
    block(rect) {
      blocks.push(rect);
    },
    open(rect) {
      openings.push(rect);
    },
    applyTo(nav) {
      for (const { object, padding } of objects) nav.blockObject(0, object, padding);
      for (const rect of blocks) nav.block(0, rect.minX, rect.minZ, rect.maxX, rect.maxZ);
      for (const rect of openings) nav.open(0, rect.minX, rect.minZ, rect.maxX, rect.maxZ);
    },
  };
}

// ---------------------------------------------------------------------------
// Walls.

/** One wall along a side of a room's rectangle. */
export interface WallSpec {
  readonly side: Side;
  /** Doors by their centre along the side, in world x (north, south) or z (east, west). */
  readonly doors?: ReadonlyArray<{ readonly at: number; readonly width: number }>;
  readonly windows?: boolean;
  /** Makes the wall one the camera can lower, for the room the rectangle is. */
  readonly cutaway?: { readonly roomId: string; readonly exterior: boolean };
  readonly height?: number;
}

/** The yaw that turns a wall's local +z out of the room through `side`. */
const OUTWARD_YAW: Readonly<Record<Side, number>> = {
  south: 0,
  north: Math.PI,
  east: Math.PI / 2,
  west: -Math.PI / 2,
};

/**
 * Builds a wall along one side of `rect`, its outward side out of the room,
 * adds it to `parent` and blocks it in the nav plan with its doors open.
 * Returns the wall.
 */
export function placeWall(parent: Object3D, rect: Rect, spec: WallSpec, nav: NavPlan): Object3D {
  const alongX = spec.side === "north" || spec.side === "south";
  const from = alongX ? rect.minX : rect.minZ;
  const to = alongX ? rect.maxX : rect.maxZ;
  const middle = (from + to) / 2;
  // A wall's local +x runs along +x on the south side, and turns with the wall elsewhere.
  const sign = spec.side === "south" || spec.side === "west" ? 1 : -1;
  const wall = buildWall(to - from, {
    ...(spec.height === undefined ? {} : { height: spec.height }),
    ...(spec.cutaway === undefined ? {} : { cutaway: spec.cutaway }),
    windows: spec.windows === true,
    doors: (spec.doors ?? []).map((door) => ({ at: sign * (door.at - middle), width: door.width })),
  });
  const line =
    spec.side === "north"
      ? rect.minZ
      : spec.side === "south"
        ? rect.maxZ
        : spec.side === "west"
          ? rect.minX
          : rect.maxX;
  if (alongX) wall.position.set(middle, 0, line);
  else wall.position.set(line, 0, middle);
  wall.rotation.y = OUTWARD_YAW[spec.side];
  parent.add(wall);
  nav.blockObject(wall, 0.02);
  for (const door of spec.doors ?? []) {
    const half = door.width / 2 - 0.04;
    const across = 0.6;
    nav.open(
      alongX
        ? { minX: door.at - half, minZ: line - across, maxX: door.at + half, maxZ: line + across }
        : { minX: line - across, minZ: door.at - half, maxX: line + across, maxZ: door.at + half },
    );
  }
  return wall;
}

/** Stands a Deco column on each corner of `rect`, so a lowered wall still shows the building's shape. */
export function placeCornerColumns(
  parent: Object3D,
  rect: Rect,
  nav: NavPlan,
  height?: number,
): void {
  for (const x of [rect.minX, rect.maxX]) {
    for (const z of [rect.minZ, rect.maxZ]) {
      const column = buildColumn(height);
      column.position.set(x, 0, z);
      parent.add(column);
      nav.blockObject(column, 0.02);
    }
  }
}

export { WALL_THICKNESS };

// ---------------------------------------------------------------------------
// Rugs.

/** The low-chroma inlay token of each project; areas of no project lie on the plain inlay. */
export function readProjectToken(project: ProjectKey | null): Token {
  switch (project) {
    case "webshop":
      return "proj-webshop";
    case "payments-api":
      return "proj-payments";
    case "ops":
      return "proj-ops";
    case null:
      return "room-inlay";
  }
}

/**
 * Builds a rug `width` by `depth` in a token's colour, with a darker border,
 * lying on the floor: its top is at about y = 0.016.
 */
export function buildTintedRug(width: number, depth: number, token: Token): Object3D {
  const rug = new Group();
  const border = new Mesh(
    new RoundedBoxGeometry(width, 0.012, depth, 1, 0.05),
    paint(token, "fabric", { dl: -0.09, dc: 0.01 }),
  );
  border.position.y = 0.006;
  const field = new Mesh(
    new RoundedBoxGeometry(width - 0.16, 0.012, depth - 0.16, 1, 0.04),
    paint(token, "fabric"),
  );
  field.position.y = 0.01;
  for (const mesh of [border, field]) mesh.receiveShadow = true;
  rug.add(border, field);
  return rug;
}

// ---------------------------------------------------------------------------
// The portal at a building's door.

/** A portal: the object, and its two pylons, which the nav graph blocks. */
export interface Portal {
  readonly object: Object3D;
  readonly pylons: ReadonlyArray<Object3D>;
}

/**
 * Builds a Deco portal for a door `doorWidth` wide: two pylons and a stepped
 * lintel with `name` on a plaque, on both faces so it reads from either
 * side. Its origin is on the ground in the middle of the doorway, at the
 * wall's outer face; it faces +z, out of the building, and stands clear of
 * the wall, so it stays up when the camera lowers the wall.
 */
export function buildPortal(
  name: string,
  doorWidth: number,
  options: { readonly height?: number; readonly subtitle?: string } = {},
): Portal {
  const object = new Group();
  const height = options.height ?? 2.95;
  const plaque = buildPlaque(name);
  const plaqueSize = new Box3().setFromObject(plaque).getSize(new Vector3());
  const span = Math.max(doorWidth + 0.7, plaqueSize.x + 0.5);
  const lintelHeight = Math.max(0.36, plaqueSize.y + 0.16);
  const depth = 0.34;
  const z = WALL_THICKNESS / 2 + depth / 2 + 0.05;
  const pylons = [-1, 1].map((side) => {
    const pylon = buildColumn(height - lintelHeight);
    pylon.position.set(side * (span / 2 - 0.15), 0, z);
    object.add(pylon);
    return pylon;
  });
  const stone = paint("room-panel", "satin");
  const lintel = new Mesh(new RoundedBoxGeometry(span, lintelHeight, depth, 2, 0.04), stone);
  lintel.position.set(0, height - lintelHeight / 2, z);
  // The Deco step: a narrower course on top of the lintel.
  const crown = new Mesh(
    new RoundedBoxGeometry(span * 0.56, 0.14, depth * 0.8, 2, 0.03),
    paint("room-panel", "satin", { dl: 0.04 }),
  );
  crown.position.set(0, height + 0.07, z);
  const cap = new Mesh(
    new RoundedBoxGeometry(span * 0.22, 0.12, depth * 0.6, 2, 0.03),
    paint("room-panel", "satin", { dl: 0.08 }),
  );
  cap.position.set(0, height + 0.2, z);
  for (const mesh of [lintel, crown, cap]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  }
  object.add(lintel, crown, cap);
  const plaqueY = height - lintelHeight / 2;
  plaque.position.set(0, plaqueY, z + depth / 2);
  object.add(plaque);
  const back = buildPlaque(name);
  back.position.set(0, plaqueY, z - depth / 2);
  back.rotation.y = Math.PI;
  object.add(back);
  if (options.subtitle !== undefined) {
    const subtitle = buildPlaque(options.subtitle);
    const size = new Box3().setFromObject(subtitle).getSize(new Vector3());
    const scale = Math.min(1, (span * 0.5) / Math.max(size.x, 0.01), 0.7);
    subtitle.scale.setScalar(scale);
    // Hung from the underside of the lintel, flush with its front face.
    subtitle.position.set(0, height - lintelHeight - (size.y * scale) / 2, z + depth / 2);
    object.add(subtitle);
  }
  return { object, pylons };
}

/** Builds a flat floor plaque: a plaque laid face up, its text reading from the south. */
export function buildFloorPlaque(text: string): Object3D {
  const plaque = buildPlaque(text);
  plaque.rotation.x = -Math.PI / 2;
  const holder = new Group();
  holder.add(plaque);
  holder.position.y = 0.018;
  return holder;
}
