/**
 * The contracts between the office's parts. Each part lives in its own
 * files, and these types are the only thing the parts agree on:
 *
 * - kit/character: a colleague's 3D body, `ColleagueRig`;
 * - kit/props and kit/architecture: furniture and rooms, `DeskHandle`;
 * - variants/*: a whole office, `OfficeLayout`;
 * - engine/nav and engine/sim: walking and behaviour, `NavGraph` and `Sim`;
 * - engine/camera-rig, engine/overlay, engine/picking: how the user looks
 *   around and points at things.
 *
 * Units are metres. +y is up, -z is north, +x is east. The default camera
 * looks from the south-east, down at the office.
 */
import type { Box3, Object3D, Vector3 } from "three";
import type { ProjectTint } from "../../screens/project-tile";
import type { Pose } from "@hercule/client-core";
import type { Colleague, OfficeRequest, World } from "../world/types";
import type { Frame, Stage } from "./stage";

// ---------------------------------------------------------------------------
// Scale. Furniture is built to the colleagues' size, like a doll's house.

/** The height of a chair's seat. A sitting colleague's hips rest here. */
export const SEAT_HEIGHT = 0.42;
/** The height of a desk's top. */
export const DESK_HEIGHT = 0.7;
/** The height of a room's walls. */
export const WALL_HEIGHT = 2.6;
/** The height a cut-away wall drops to: the dado rail. */
export const CUTAWAY_HEIGHT = 0.55;
/** The colleagues' walking speed, m/s. */
export const WALK_SPEED = 1.1;

// ---------------------------------------------------------------------------
// Places.

/** A place to stand or sit: a point on a floor, and the way to face there. */
export interface Spot {
  readonly position: Vector3;
  /** Yaw in radians. 0 faces +z (south, toward the default camera); PI/2 faces +x. */
  readonly facing: number;
  /** The storey, 0 for the ground floor. Only the tower has more than one. */
  readonly floor: number;
}

/** Where a colleague belongs when nothing else calls them away: its desk, or an armchair. */
export interface Seat extends Spot {
  readonly kind: "desk" | "armchair" | "stool" | "standing";
  readonly roomId: string;
  /** The desk at the seat, when there is one, so the sim can light its lamp. */
  readonly desk: DeskHandle | null;
}

// ---------------------------------------------------------------------------
// The colleagues.

/** What a colleague's body is doing. The face shows the pose separately, see `ColleagueRig.setFace`. */
export type Action =
  /** Standing, breathing, glancing around now and then. */
  | "stand"
  /** The walk cycle. Feet plant on the floor; nothing floats. */
  | "walk"
  /** Sitting on a chair, hands in the lap. */
  | "sit"
  /** Sitting at a desk, typing on the typewriter. */
  | "type"
  /** Sitting, reading a document or a book. */
  | "read"
  /** Sitting with a cup of tisane, sipping now and then. */
  | "sip"
  /** Standing, one arm up with the marigold palm, a small wave: waiting on the user. */
  | "raise-hand"
  /** Standing, gesturing, as in a conversation. */
  | "talk"
  /** Standing, nodding, as the other side of a conversation. */
  | "listen"
  /** Asleep: slumped in an armchair, eyes closed. */
  | "sleep"
  /** One happy hop on the spot, then back to standing. */
  | "hop";

/**
 * One colleague's 3D body. The root's origin sits between the feet on the
 * floor, and the rig faces +z when the root's rotation is 0. Sitting lowers
 * the body onto a seat at `SEAT_HEIGHT` without moving the root, so a
 * colleague sits by standing on the chair's spot.
 */
export interface ColleagueRig {
  readonly colleague: Colleague;
  readonly object: Object3D;
  /** The height above the root of the top of the head or hat, for tags and bubbles. */
  readonly headHeight: number;
  setAction(action: Action): void;
  /** Draws the face and badge the Bureau book gives a pose: eyes, mouth, plaster, check, Zzz. */
  setFace(pose: Pose): void;
  /** Sets the gait's cadence to a walking speed in m/s. */
  setWalkSpeed(speed: number): void;
  /** Turns the head toward a world point, or back to straight ahead with null. */
  lookAt(point: Vector3 | null): void;
  setHovered(hovered: boolean): void;
  setSelected(selected: boolean): void;
  /** Advances the animation. Returns true while anything on the rig still moves. */
  update(frame: Frame): boolean;
  dispose(): void;
}

export type BuildColleagueRig = (colleague: Colleague) => ColleagueRig;

// ---------------------------------------------------------------------------
// Walls.

/** The key under which a wall that can drop to the dado rail stores its `Cutaway`, in `userData`. */
export const CUTAWAY = "cutaway";

/**
 * What a wall that can be cut away tells the camera. The camera decides which
 * walls to lower, so the user always sees into the rooms; the wall decides
 * how it looks lowered. A wall's outward side is its local +z: a layout
 * places each wall with +z pointing out of the room it bounds.
 */
export interface Cutaway {
  /** The room the wall bounds. */
  readonly roomId: string;
  /** True for the building's outer walls, which stay up longest. */
  readonly exterior: boolean;
  /** Lowers the wall: 0 is full height, 1 is down to the dado rail. */
  setCut(amount: number): void;
}

// ---------------------------------------------------------------------------
// Room lights.

/** The key under which a room light stores its `Lamp`, in `userData`. */
export const LAMP = "lamp";

/**
 * A light the office switches on in the evening, such as a standard lamp, a
 * lantern outdoors, or a window's outer panes. The director finds every
 * `Lamp` under a layout's root and switches them all with the time of day. A
 * desk's banker's lamp is not one: the sim lights it while the desk's owner
 * works.
 */
export interface Lamp {
  /**
   * Switches the lamp on or off. The director calls it after every change of
   * theme too, with the same value or not, so a lamp repaints its light in
   * the new theme's colours here.
   */
  setOn(on: boolean): void;
}

// ---------------------------------------------------------------------------
// Furniture.

/** A piece of furniture to sit on: the object, and the seat's spot in the object's own space. */
export interface SeatProp {
  readonly object: Object3D;
  /** Stand here, facing the way the marker faces, to sit down. */
  readonly seatMarker: Object3D;
}

/** Furniture with several seats: a bench, a long table. */
export interface SeatsProp {
  readonly object: Object3D;
  readonly seatMarkers: ReadonlyArray<Object3D>;
}

/** A desk with its chair, lamp and typewriter, which the sim changes as its owner's state changes. */
export interface DeskHandle {
  readonly object: Object3D;
  /** The chair's spot, in the desk's own space: stand here, facing the desk, to sit down. */
  readonly seatMarker: Object3D;
  /** Lights the green banker's lamp: the desk's owner is working. */
  setLamp(on: boolean): void;
  /** Shows the marigold note left on the desk while its owner waits on the user. */
  setNote(on: boolean): void;
  /** Shows a cup of tisane on the desk: its owner is idle. */
  setCup(on: boolean): void;
}

// ---------------------------------------------------------------------------
// The office.

/** Where the camera looks from: a target, a distance, and two angles in degrees. */
export interface CameraView {
  readonly target: Vector3;
  readonly distance: number;
  /** Degrees around the y axis, from +z toward +x. 45 looks from the south-east. */
  readonly azimuth: number;
  /** Degrees above the horizon. */
  readonly elevation: number;
}

/**
 * The kinds of rooms. A project room seats the threads of one project, or the
 * threads with no project; the others are the fixed rooms, the corridors, and
 * the storeys.
 */
export type RoomKind =
  "project" | "triage-room" | "your-office" | "lounge" | "lobby" | "hall" | "floor";

/** A room the user can jump to. */
export interface RoomInfo {
  readonly id: string;
  readonly label: string;
  readonly kind: RoomKind;
  readonly floor: number;
  /** The room's box in world space, floor to ceiling. */
  readonly bounds: Box3;
  readonly view: CameraView;
  /** The project tint whose low-chroma inlay tints the floor, when the room seats a project. */
  readonly tint: ProjectTint | null;
}

/**
 * Returns the room of kind "floor" that stands for `room`, such as a storey of
 * the Tower or a pavilion of the Campus: the smallest one on the same storey
 * whose plan holds the middle of `room`. Returns null for a "floor" room
 * itself, and for a room outside every "floor" room.
 */
export function findFloorRoom(room: RoomInfo, rooms: ReadonlyArray<RoomInfo>): RoomInfo | null {
  if (room.kind === "floor") return null;
  const x = (room.bounds.min.x + room.bounds.max.x) / 2;
  const z = (room.bounds.min.z + room.bounds.max.z) / 2;
  let smallest: RoomInfo | null = null;
  let smallestArea = Infinity;
  for (const candidate of rooms) {
    const { min, max } = candidate.bounds;
    if (candidate.kind !== "floor" || candidate.floor !== room.floor) continue;
    if (x < min.x || x > max.x || z < min.z || z > max.z) continue;
    const area = (max.x - min.x) * (max.z - min.z);
    if (area < smallestArea) {
      smallest = candidate;
      smallestArea = area;
    }
  }
  return smallest;
}

/** The fixed places the sim sends colleagues to. */
interface OfficeSpots {
  /** Where the user's desk is; the queue faces it. */
  readonly yourDesk: Spot;
  /** The queue of colleagues waiting on the user, head of the queue first. */
  readonly queue: ReadonlyArray<Spot>;
  /** Places to sit when idle away from the desk: the lounge's chairs. */
  readonly lounge: ReadonlyArray<Seat>;
  /** Spots by the filing cabinets, where a colleague files a Task. */
  readonly records: Spot | null;
  /** Where a newly arrived colleague comes in: the front door, inside, facing in. */
  readonly entrance: Spot;
  /** Where a colleague fetches tea: in front of the tea trolley, facing it. */
  readonly tea: Spot | null;
}

/** One whole office: what a variant builds from the world. */
export interface OfficeLayout {
  readonly root: Object3D;
  readonly rooms: ReadonlyArray<RoomInfo>;
  /** Every colleague's home seat, by colleague id. Every colleague of the world has one. */
  readonly homes: ReadonlyMap<string, Seat>;
  readonly spots: OfficeSpots;
  readonly nav: NavGraph;
  /** The view the office opens on, which shows all of it. */
  readonly overview: CameraView;
  /** The box the whole office fits in, for the sun's shadow and the camera's limits. */
  readonly bounds: Box3;
  /** Shows on the "now serving" sign how many colleagues wait on the user. */
  setWaitingCount?(count: number): void;
  dispose(): void;
}

/** What a variant gets to build its office. */
interface LayoutContext {
  readonly world: World;
  /** The nav graph the variant fills with floors, obstacles and doors. */
  readonly nav: NavBuilder;
}

export type BuildOfficeLayout = (context: LayoutContext) => OfficeLayout;

// ---------------------------------------------------------------------------
// Walking.

/** One point of a path. */
export interface Waypoint {
  readonly position: Vector3;
  readonly floor: number;
}

/** What a layout tells the nav graph while it builds. */
export interface NavBuilder {
  /** Declares a walkable storey: its floor's height, and the rectangle (x, z) it covers. */
  addFloor(floor: number, y: number, minX: number, minZ: number, maxX: number, maxZ: number): void;
  /** Marks a rectangle of a storey as not walkable: a wall, a desk, a cabinet. */
  block(floor: number, minX: number, minZ: number, maxX: number, maxZ: number): void;
  /** Marks an object's footprint, its world box grown by `padding`, as not walkable. */
  blockObject(floor: number, object: Object3D, padding?: number): void;
  /** Marks a rectangle walkable again: a door through a wall. */
  open(floor: number, minX: number, minZ: number, maxX: number, maxZ: number): void;
  /** Finishes the graph. Call it once, after every floor and obstacle. */
  build(): NavGraph;
}

/** Finds paths through the office. */
export interface NavGraph {
  /**
   * Returns a path from one spot to another: walkable, around every obstacle,
   * through doors, smoothed into as few points as possible. The path ends
   * exactly at `to`, even when `to` is inside an obstacle (a chair behind a
   * desk). Returns null when no path exists, as between two storeys.
   */
  findPath(from: Spot, to: Spot): ReadonlyArray<Waypoint> | null;
}

// ---------------------------------------------------------------------------
// Behaviour.

/**
 * A colleague's state as the sim holds it now. It starts as the world's
 * `Colleague` and changes as things happen: an answered colleague works
 * again, a failed one shows its plaster.
 */
export interface ColleagueState {
  readonly pose: Pose;
  /** The request the colleague waits on the user with, or null. */
  readonly request: OfficeRequest | null;
  /** The short state the name tag shows when there is no request, such as "typing" or "idle 2h". */
  readonly stateLabel: string;
}

/** The office's life: who walks where, and what each colleague is doing. */
export interface Sim {
  /** Advances everyone. Returns true while anyone moves. */
  update(frame: Frame): boolean;
  /**
   * Moves a colleague into the state its thread is in now, after the
   * thread's pose or Request changed. The colleague's tag shows `state` at
   * once, and when the pose changed the colleague walks where the new pose
   * takes it:
   * - `waiting`: to the back of the queue, or beside its desk when the queue is full;
   * - `working`: back to its desk, with a hop first when it was waiting;
   * - `idle`: to a free Lounge armchair when `inLounge` is true, else to its desk.
   * Walks happen at every liveliness, because they show a real change.
   */
  setColleagueState(colleagueId: string, state: ColleagueState, inLounge: boolean): void;
  /**
   * Sets how lively the office is: 0 still (only state changes move anyone),
   * 1 calm, 2 bustling.
   */
  setLiveliness(level: 0 | 1 | 2): void;
  /**
   * Returns every colleague's state now, by id, including colleagues who
   * arrived after the office opened. Returns the same map until a state
   * changes, so a React panel can read it with `useSyncExternalStore`.
   */
  readStates(): ReadonlyMap<string, ColleagueState>;
  /** Calls `listener` after any colleague's state changes. Returns the function that unsubscribes. */
  subscribeStates(listener: () => void): () => void;
  dispose(): void;
}

/** What the sim gets to run the office. */
export interface SimContext {
  readonly world: World;
  readonly layout: OfficeLayout;
  readonly rigs: ReadonlyMap<string, ColleagueRig>;
  readonly stage: Stage;
}

export type BuildSim = (context: SimContext) => Sim;
