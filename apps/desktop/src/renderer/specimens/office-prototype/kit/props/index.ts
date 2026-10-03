/**
 * PROTOTYPE - the office's furniture. STUB: plain boxes, until the props kit
 * replaces them. Keep every exported name and signature: the layouts import
 * them.
 *
 * Every builder returns an object whose origin sits on the floor, in the
 * middle of its footprint, with its front facing +z, unless its comment says
 * otherwise.
 */
import { BoxGeometry, Group, Mesh, Object3D, type Material } from "three";
import type { DeskHandle, SeatProp, SeatsProp } from "../../engine/contracts";
import { DESK_HEIGHT, SEAT_HEIGHT } from "../../engine/contracts";
import { paint } from "../../engine/palette";

/** Returns a box of the given size whose base sits at `y`, centred at (x, z). */
function block(
  material: Material,
  width: number,
  height: number,
  depth: number,
  x = 0,
  y = 0,
  z = 0,
): Mesh {
  const mesh = new Mesh(new BoxGeometry(width, height, depth), material);
  mesh.position.set(x, y + height / 2, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Returns a marker at (x, z), facing `facing` (yaw; 0 faces +z). */
function marker(x: number, z: number, facing: number): Object3D {
  const object = new Object3D();
  object.position.set(x, 0, z);
  object.rotation.y = facing;
  return object;
}

/**
 * Builds a clerk's desk with its chair, lamp and typewriter. The chair is on
 * the desk's +z side, so its sitter faces -z, across the desk.
 */
export function buildDesk(): DeskHandle {
  const object = new Group();
  const lamp = block(paint("room-lamp", "glass"), 0.2, 0.1, 0.12, -0.4, DESK_HEIGHT + 0.2, -0.15);
  object.add(
    block(paint("room-desk", "lacquer"), 1.3, 0.06, 0.72, 0, DESK_HEIGHT - 0.06),
    block(paint("room-wood"), 1.2, DESK_HEIGHT - 0.06, 0.62),
    block(paint("room-fabric", "fabric"), 0.5, SEAT_HEIGHT, 0.5, 0, 0, 0.75),
    lamp,
  );
  const seatMarker = marker(0, 0.75, Math.PI);
  object.add(seatMarker);
  return {
    object,
    seatMarker,
    setLamp(on) {
      lamp.material = paint("room-lamp", on ? "glow" : "glass");
    },
    setNote() {},
    setCup() {},
  };
}

/**
 * Builds the user's own desk: a partner desk, wider than a clerk's, with
 * the user's chair on its -z side, so the user faces +z, toward visitors.
 * Its `seatMarker` is the user's chair. A visitor stands at (0, 0, 0.95),
 * facing -z.
 */
export function buildYourDesk(): DeskHandle {
  const object = new Group();
  object.add(
    block(paint("room-desk", "lacquer"), 1.9, 0.07, 0.9, 0, DESK_HEIGHT - 0.07),
    block(paint("room-wood"), 1.8, DESK_HEIGHT - 0.07, 0.8),
    block(paint("you", "fabric"), 0.6, SEAT_HEIGHT + 0.4, 0.55, 0, 0, -0.85),
  );
  const seatMarker = marker(0, -0.85, 0);
  object.add(seatMarker);
  return { object, seatMarker, setLamp() {}, setNote() {}, setCup() {} };
}

/** Builds an armchair. Its sitter faces +z. */
export function buildArmchair(): SeatProp {
  const object = new Group();
  object.add(block(paint("room-fabric", "fabric"), 0.8, SEAT_HEIGHT, 0.75));
  object.add(block(paint("room-fabric", "fabric"), 0.8, 0.5, 0.18, 0, SEAT_HEIGHT, -0.3));
  const seatMarker = marker(0, 0.05, 0);
  object.add(seatMarker);
  return { object, seatMarker };
}

/** Builds a bar stool. Its sitter faces +z. */
export function buildStool(): SeatProp {
  const object = new Group();
  object.add(block(paint("room-wood"), 0.36, SEAT_HEIGHT, 0.36));
  const seatMarker = marker(0, 0, 0);
  object.add(seatMarker);
  return { object, seatMarker };
}

/** Builds a waiting bench of `seats` seats, along x. Its sitters face +z. */
export function buildBench(seats: number): SeatsProp {
  const object = new Group();
  const width = seats * 0.6;
  object.add(block(paint("room-wood"), width, SEAT_HEIGHT, 0.45));
  const seatMarkers = Array.from({ length: seats }, (_, index) =>
    marker(-width / 2 + 0.3 + index * 0.6, 0.05, 0),
  );
  object.add(...seatMarkers);
  return { object, seatMarkers };
}

/**
 * Builds a long reading table with `seats` chairs on each long side, along
 * x: the first half of the markers on the +z side facing -z, then the -z
 * side facing +z.
 */
export function buildLongTable(seats: number): SeatsProp {
  const object = new Group();
  const width = seats * 0.8;
  object.add(block(paint("room-wood", "lacquer"), width, DESK_HEIGHT, 1.0));
  const seatMarkers = [
    ...Array.from({ length: seats }, (_, index) =>
      marker(-width / 2 + 0.4 + index * 0.8, 0.75, Math.PI),
    ),
    ...Array.from({ length: seats }, (_, index) =>
      marker(-width / 2 + 0.4 + index * 0.8, -0.75, 0),
    ),
  ];
  object.add(...seatMarkers);
  return { object, seatMarkers };
}

/** Builds a filing cabinet, 0.5 wide, 1.3 tall, 0.6 deep. */
export function buildCabinet(): Object3D {
  return block(paint("room-metal", "metal"), 0.5, 1.3, 0.6);
}

/** Builds a bookshelf `width` wide, 2 tall, 0.35 deep. */
export function buildBookshelf(width: number): Object3D {
  return block(paint("room-wood"), width, 2, 0.35);
}

/** A cork board of Proposals, which shows how many there are and how many burn. */
export interface CaseBoardHandle {
  readonly object: Object3D;
  /** Where Triage stands to pin a card, in the board's own space, facing the board. */
  readonly pinMarker: Object3D;
  setCards(total: number, burning: number): void;
}

/** Builds the Case Room's board, `width` wide, mounted on a wall: its back is at z = 0. */
export function buildCaseBoard(width: number): CaseBoardHandle {
  const object = new Group();
  object.add(block(paint("room-cork", "matte"), width, 1.2, 0.06, 0, 0.8, 0.03));
  const pinMarker = marker(0, 0.7, Math.PI);
  object.add(pinMarker);
  return { object, pinMarker, setCards() {} };
}

/** Builds a potted plant. */
export function buildPlant(size: "small" | "tall"): Object3D {
  const height = size === "tall" ? 1.4 : 0.6;
  const object = new Group();
  object.add(block(paint("room-panel"), 0.35, 0.35, 0.35));
  object.add(block(paint("room-plant", "satin"), 0.5, height - 0.35, 0.5, 0, 0.35));
  return object;
}

/** Builds a rug `width` by `depth`, lying flat on the floor. */
export function buildRug(width: number, depth: number): Object3D {
  const rug = block(paint("room-fabric", "fabric"), width, 0.01, depth);
  rug.castShadow = false;
  return rug;
}

/** Builds a tea trolley. */
export function buildTeaTrolley(): Object3D {
  return block(paint("room-wood"), 0.8, 0.8, 0.45);
}

/** Builds a coat stand. */
export function buildCoatStand(): Object3D {
  return block(paint("room-wood"), 0.12, 1.7, 0.12);
}

/** A standard lamp, which the office lights in the evening. */
export interface FloorLampHandle {
  readonly object: Object3D;
  setOn(on: boolean): void;
}

/** Builds a standard lamp. */
export function buildFloorLamp(): FloorLampHandle {
  const object = new Group();
  object.add(block(paint("room-metal", "brass"), 0.06, 1.5, 0.06));
  const shade = block(paint("room-paper", "glass"), 0.4, 0.3, 0.4, 0, 1.4);
  object.add(shade);
  return {
    object,
    setOn(on) {
      shade.material = paint("room-paper", on ? "glow" : "glass");
    },
  };
}

/** Builds the sunburst wall clock, hung on a wall: its back is at z = 0, its centre at y = 0. */
export function buildWallClock(): Object3D {
  return block(paint("brass", "brass"), 0.5, 0.5, 0.05, 0, -0.25, 0.025);
}

/** The "Now serving" sign over the user's desk. */
export interface NowServingHandle {
  readonly object: Object3D;
  /** Shows how many colleagues wait in the queue. */
  setNumber(count: number): void;
}

/** Builds the "Now serving" sign, hung on a wall: its back is at z = 0, its bottom at y = 0. */
export function buildNowServing(): NowServingHandle {
  return { object: block(paint("ink", "lacquer"), 0.9, 0.35, 0.05, 0, 0, 0.025), setNumber() {} };
}

/** Builds the Post Room's pigeonholes, against a wall: its back is at z = -0.2. */
export function buildPigeonholes(): Object3D {
  return block(paint("room-wood"), 1.6, 1.6, 0.4);
}

/** Builds a stack of wrapped parcels, for Dispatch. */
export function buildParcels(): Object3D {
  return block(paint("room-cork", "paper"), 0.7, 0.5, 0.5);
}
