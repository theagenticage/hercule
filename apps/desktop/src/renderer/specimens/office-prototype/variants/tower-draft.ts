/**
 * PROTOTYPE - what the Tower's builders share while they build: the tower's
 * measurements, the storey groups, the rooms, homes and nav they fill, and
 * small helpers to place furniture and read spots off it.
 *
 * The tower's plan, seen from above: x runs east from the west wall at
 * x = 0, and z runs south from the north wall at z = -depth to the open
 * front at z = 0. Every storey is a group raised to its floor's height, so
 * an object's position inside a storey is its position on that floor.
 */
import { Box3, Euler, Group, Quaternion, Vector3, type Object3D } from "three";
import {
  WALL_HEIGHT,
  type CameraView,
  type DeskHandle,
  type NavBuilder,
  type RoomInfo,
  type RoomKind,
  type Seat,
  type Spot,
} from "../engine/contracts";
import { WALL_THICKNESS, buildWall, type WallOptions } from "../kit/architecture";

/** The height from one floor to the next. Walls are `WALL_HEIGHT` tall; the slab fills the rest. */
export const STOREY_HEIGHT = 3;
/** The bottom of a storey's structural slab, below its floor. The slab is the ceiling of the storey below. */
export const SLAB_BOTTOM = WALL_HEIGHT - STOREY_HEIGHT;
/** The depth of the walkway along each storey's open front, in front of the rooms. */
export const GALLERY_DEPTH = 1.5;
/** How far inside the open front the walkable floor stops, so nobody walks along the edge. */
export const FRONT_KEEP_OUT = 0.35;

/** The measurements every storey shares. */
export interface TowerFrame {
  /** The runner storeys' width, west wall to east wall. */
  readonly width: number;
  /** The runner storeys' depth, north wall to the open front. */
  readonly depth: number;
  /** The width of the lift core at the west end of every storey. */
  readonly coreWidth: number;
  /** The lobby's width; it is wider than the storeys above it. */
  readonly lobbyWidth: number;
  /** How far the lobby reaches south of the storeys' open front. */
  readonly lobbyFront: number;
  /** The penthouse salon's width, from the west wall. The terrace fills the rest of the roof. */
  readonly salonWidth: number;
  /** The lift shaft's footprint, in the tower's plan. */
  readonly shaft: Box3;
  /** The middle of the lift car's floor, in the tower's plan. */
  readonly car: Vector3;
}

/** What the builders fill while they build the tower. */
export interface TowerDraft {
  readonly frame: TowerFrame;
  /** One group per storey from the lobby up, each raised to its floor's height. */
  readonly storeys: ReadonlyArray<Group>;
  readonly rooms: RoomInfo[];
  readonly homes: Map<string, Seat>;
  readonly nav: NavBuilder;
}

/** Returns the height of a storey's floor. */
export function readFloorHeight(floor: number): number {
  return floor * STOREY_HEIGHT;
}

/**
 * Adds `object` to `parent` at (x, z) on the parent's floor, turned by
 * `yaw` (0 faces +z), raised by `y`. Returns the object.
 */
export function placeObject<T extends Object3D>(
  parent: Object3D,
  object: T,
  x: number,
  z: number,
  yaw = 0,
  y = 0,
): T {
  object.position.set(x, y, z);
  object.rotation.y = yaw;
  parent.add(object);
  object.updateWorldMatrix(true, true);
  return object;
}

/** Returns a spot at a marker's place in the world, facing the way the marker faces. */
export function readSpot(marker: Object3D, floor: number): Spot {
  marker.updateWorldMatrix(true, false);
  const position = marker.getWorldPosition(new Vector3());
  const turn = marker.getWorldQuaternion(new Quaternion());
  return { position, facing: new Euler().setFromQuaternion(turn, "YXZ").y, floor };
}

/** Returns a seat at a marker's place in the world. */
export function readSeat(
  marker: Object3D,
  floor: number,
  kind: Seat["kind"],
  roomId: string,
  desk: DeskHandle | null,
): Seat {
  return { ...readSpot(marker, floor), kind, roomId, desk };
}

/** Returns a spot at a point of a storey's plan. */
export function buildSpot(x: number, z: number, facing: number, floor: number): Spot {
  return { position: new Vector3(x, readFloorHeight(floor), z), facing, floor };
}

/** Returns the box an object fills in its own space, with nothing turned or moved. */
export function measureObject(object: Object3D): Box3 {
  object.updateWorldMatrix(true, true);
  return new Box3().setFromObject(object);
}

/** A rectangle of a storey's plan. */
export interface PlanRect {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/**
 * Returns the camera's view into a room: from the south-east, a little
 * above, far enough back that the whole rectangle fits the pane.
 */
export function buildRoomView(rect: PlanRect, floor: number): CameraView {
  const width = rect.maxX - rect.minX;
  const depth = rect.maxZ - rect.minZ;
  const target = new Vector3(
    (rect.minX + rect.maxX) / 2,
    readFloorHeight(floor) + 0.5,
    (rect.minZ + rect.maxZ) / 2,
  );
  // About 1.75 times the width fills the pane's width at the camera's field of view.
  const distance = Math.max(7, 1.75 * Math.max(width, depth * 0.9));
  return { target, distance, azimuth: 26, elevation: 32 };
}

/** What a room needs to be listed: its name, kind, storey, rectangle and project. */
export interface RoomSpec {
  readonly id: string;
  readonly label: string;
  readonly kind: RoomKind;
  readonly floor: number;
  readonly rect: PlanRect;
  readonly project?: string | null;
  readonly view?: CameraView;
}

/** Lists a room the user can jump to, its box floor to ceiling. */
export function addRoom(draft: TowerDraft, spec: RoomSpec): void {
  const y = readFloorHeight(spec.floor);
  draft.rooms.push({
    id: spec.id,
    label: spec.label,
    kind: spec.kind,
    floor: spec.floor,
    bounds: new Box3(
      new Vector3(spec.rect.minX, y, spec.rect.minZ),
      new Vector3(spec.rect.maxX, y + WALL_HEIGHT, spec.rect.maxZ),
    ),
    view: spec.view ?? buildRoomView(spec.rect, spec.floor),
    project: spec.project ?? null,
  });
}

/** Where a wall stands: its two ends on the plan, and which side is out. */
export interface WallPlacement {
  readonly floor: number;
  /** One end, on the plan. */
  readonly from: readonly [number, number];
  /** The other end. Seen from `from` toward `to`, the wall's outward side is on the right. */
  readonly to: readonly [number, number];
  readonly options?: WallOptions;
}

/**
 * Builds a wall between two points of a storey's plan, blocks it in the nav
 * graph, and opens its doorways. The wall's outward side, its local +z, is
 * on the right seen from `from` toward `to`. Walking round a room
 * anticlockwise, seen from above with north up, puts every wall's outside
 * out of the room: the north wall runs from east to west. Returns the wall.
 */
export function addWall(draft: TowerDraft, placement: WallPlacement): Object3D {
  const [x0, z0] = placement.from;
  const [x1, z1] = placement.to;
  const length = Math.hypot(x1 - x0, z1 - z0);
  // Local +x runs from `from` to `to`; local +z is that direction turned a
  // quarter to the right, seen from above.
  const yaw = Math.atan2(z0 - z1, x1 - x0);
  const wall = buildWall(length, placement.options ?? {});
  const storey = draft.storeys[placement.floor]!;
  placeObject(storey, wall, (x0 + x1) / 2, (z0 + z1) / 2, yaw);
  draft.nav.blockObject(placement.floor, wall);
  const along = new Vector3(x1 - x0, 0, z1 - z0).normalize();
  for (const door of placement.options?.doors ?? []) {
    const centre = new Vector3((x0 + x1) / 2, 0, (z0 + z1) / 2).addScaledVector(along, door.at);
    const halfAlong = door.width / 2 - 0.05;
    const halfAcross = WALL_THICKNESS / 2 + 0.3;
    const halfX = Math.abs(along.x) * halfAlong + Math.abs(along.z) * halfAcross;
    const halfZ = Math.abs(along.z) * halfAlong + Math.abs(along.x) * halfAcross;
    draft.nav.open(
      placement.floor,
      centre.x - halfX,
      centre.z - halfZ,
      centre.x + halfX,
      centre.z + halfZ,
    );
  }
  return wall;
}
