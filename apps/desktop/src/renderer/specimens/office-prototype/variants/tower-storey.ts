/**
 * PROTOTYPE - one runner's storey of the Tower: the lift landing at the
 * west end, then one room per project, each with its sessions' desks in
 * rows facing the open front, so the camera sees every face.
 *
 * Every storey is as wide as the widest one needs, so the tower rises
 * straight. A storey with few sessions gets roomier rooms, and the desks it
 * could still seat show as inlaid outlines on the floor.
 */
import { Group, Mesh, PlaneGeometry, type Object3D } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { buildDesk } from "../kit/props";
import { buildFloor, buildPlaque, WALL_THICKNESS } from "../kit/architecture";
import { paint, type Token } from "../engine/palette";
import type { DeskHandle } from "../engine/contracts";
import type { PlannedRoom, PlannedStorey, RoomGroup } from "./tower-plan";
import {
  FRONT_KEEP_OUT,
  GALLERY_DEPTH,
  SLAB_BOTTOM,
  STOREY_HEIGHT,
  addRoom,
  addWall,
  buildRoomView,
  measureObject,
  placeObject,
  readFloorHeight,
  readSeat,
  type PlanRect,
  type TowerDraft,
} from "./tower-draft";
import { buildBlock, buildFrontRail, buildPendant, buildPier } from "./tower-shell";

/** Rows of desks in every room, front to back. */
export const DESK_ROWS = 3;
/** The space between two desks side by side. */
const DESK_GAP = 0.45;
/** The aisle between a row's chairs and the next row's desks. */
const ROW_AISLE = 0.75;
/** The aisle behind the back row's chairs. */
const BACK_AISLE = 0.7;
/** The walkway between a room's partition and its nearest desk. */
const ROOM_MARGIN = 0.8;
/** The narrowest a room may be. */
const ROOM_MIN_WIDTH = 3.2;
/** The rail's height along the open front. */
const RAIL_HEIGHT = 0.62;
/** The square piers' half width, at the tower's corners. */
const PIER_HALF = 0.23;

/** The floor inlay of each room group: a project's low-chroma tint, or the plain inlay. */
const GROUP_INLAY: Readonly<Record<RoomGroup, Token>> = {
  webshop: "proj-webshop",
  "payments-api": "proj-payments",
  ops: "proj-ops",
  reading: "room-inlay",
};

/** A desk's size with its chair pulled out, turned so its sitter faces south. */
export interface DeskUnit {
  readonly width: number;
  /** From the desk's origin south to the desk's front edge. */
  readonly front: number;
  /** From the desk's origin north to the chair's back. */
  readonly back: number;
}

/** Measures a clerk's desk and chair as the props kit builds them. */
export function measureDeskUnit(): DeskUnit {
  const box = measureObject(buildDesk().object);
  // Turned half round, the desk's +z side (its chair) points north.
  return { width: box.max.x - box.min.x, front: -box.min.z, back: box.max.z };
}

/** Returns how far apart two rows of desks stand. */
function measureRowPitch(unit: DeskUnit): number {
  return unit.front + unit.back + ROW_AISLE;
}

/** Returns the width a room needs for `sessions` desks. */
export function measureRoomWidth(sessions: number, unit: DeskUnit): number {
  const columns = Math.max(1, Math.ceil(sessions / DESK_ROWS));
  const desks = columns * unit.width + (columns - 1) * DESK_GAP;
  return Math.max(ROOM_MIN_WIDTH, desks + 2 * ROOM_MARGIN);
}

/** Returns the width a runner's storey needs, its lift core included. */
export function measureStoreyWidth(
  storey: PlannedStorey,
  unit: DeskUnit,
  coreWidth: number,
): number {
  return storey.rooms.reduce(
    (sum, room) => sum + measureRoomWidth(room.colleagues.length, unit),
    coreWidth,
  );
}

/** Returns the depth every runner storey needs, north wall to open front. */
export function measureStoreyDepth(unit: DeskUnit): number {
  return (
    GALLERY_DEPTH +
    DESK_ROWS * (unit.front + unit.back) +
    (DESK_ROWS - 1) * ROW_AISLE +
    BACK_AISLE +
    WALL_THICKNESS / 2
  );
}

/**
 * Splits a storey's width between its rooms, west to east after the core:
 * each room gets what it needs, and what is left over is shared in
 * proportion to that. Returns each room's west and east edge.
 */
function splitRooms(
  rooms: ReadonlyArray<PlannedRoom>,
  unit: DeskUnit,
  from: number,
  to: number,
): Array<readonly [number, number]> {
  const needs = rooms.map((room) => measureRoomWidth(room.colleagues.length, unit));
  const total = needs.reduce((sum, need) => sum + need, 0);
  const stretch = total > 0 ? (to - from) / total : 1;
  let x = from;
  return needs.map((need) => {
    const edges = [x, x + need * stretch] as const;
    x = edges[1];
    return edges;
  });
}

/** Builds the slab under a storey: the ceiling of the storey below, with a brass bead along its front. */
export function addSlab(parent: Object3D, rect: PlanRect): void {
  const width = rect.maxX - rect.minX;
  const depth = rect.maxZ - rect.minZ;
  const centreX = (rect.minX + rect.maxX) / 2;
  const centreZ = (rect.minZ + rect.maxZ) / 2;
  const height = -0.1 - SLAB_BOTTOM;
  parent.add(
    buildBlock(
      paint("room-panel", "satin", { dl: -0.03 }),
      width,
      height,
      depth,
      centreX,
      SLAB_BOTTOM,
      centreZ,
    ),
    buildBlock(paint("brass", "brass"), width + 0.02, 0.035, 0.035, centreX, -0.12, rect.maxZ),
  );
}

/**
 * Adds the inlaid outline of a desk the storey could still seat: a thin
 * rectangle where the desk and chair would stand, "room for one more".
 */
function addVacantOutline(parent: Object3D, x: number, z: number, unit: DeskUnit): void {
  const depth = unit.front + unit.back;
  const bar = 0.035;
  const sides = [
    new PlaneGeometry(unit.width, bar).translate(0, -depth / 2 + bar / 2, 0),
    new PlaneGeometry(unit.width, bar).translate(0, depth / 2 - bar / 2, 0),
    new PlaneGeometry(bar, depth).translate(-unit.width / 2 + bar / 2, 0, 0),
    new PlaneGeometry(bar, depth).translate(unit.width / 2 - bar / 2, 0, 0),
  ];
  const outline = new Mesh(
    mergeGeometries(sides).rotateX(-Math.PI / 2),
    paint("room-inlay", "matte", { dl: -0.06 }),
  );
  // Raised a few millimetres, so it never flickers into the floor from afar.
  outline.position.set(x, 0.006, z + (unit.front - unit.back) / 2);
  outline.receiveShadow = true;
  parent.add(outline);
}

/**
 * Builds one runner's storey into its group: the floors, the
 * walls, the rooms' desks with their sessions' homes, the pendants, the
 * front rail, the runner's plaque on the slab's front, the corner piers,
 * and the storey's nav floor.
 */
export function buildRunnerStorey(draft: TowerDraft, storey: PlannedStorey, unit: DeskUnit): void {
  const { frame, nav } = draft;
  const { floor, runner } = storey;
  const group = draft.storeys[floor]!;
  const width = frame.width;
  const depth = frame.depth;
  const half = WALL_THICKNESS / 2;
  const core = frame.coreWidth;
  const storeyRect: PlanRect = { minX: 0, maxX: width, minZ: -depth, maxZ: 0 };

  placeObject(group, buildFloor(core, depth, { inlay: "room-inlay-2" }), core / 2, -depth / 2);

  // The outer walls, anticlockwise from the north-east corner.
  addWall(draft, {
    floor,
    from: [width + half, -depth],
    to: [-half, -depth],
    options: { windows: true, cutaway: { roomId: runner.id, exterior: true } },
  });
  addWall(draft, {
    floor,
    from: [0, -depth + half],
    to: [0, 0],
    options: { cutaway: { roomId: runner.id, exterior: true } },
  });
  const lastRoom = storey.rooms.at(-1);
  addWall(draft, {
    floor,
    from: [width, 0],
    to: [width, -depth + half],
    options: {
      windows: true,
      cutaway: { roomId: lastRoom?.id ?? runner.id, exterior: true },
    },
  });

  // The rooms, west to east after the core; each one is separated from the
  // one west of it by a partition that stops short of the front walkway.
  const edges = splitRooms(storey.rooms, unit, core, width);
  const rowPitch = measureRowPitch(unit);
  let seated = 0;
  storey.rooms.forEach((room, index) => {
    const [west, east] = edges[index]!;
    const roomWidth = east - west;
    placeObject(
      group,
      buildFloor(roomWidth, depth, { inlay: GROUP_INLAY[room.group] }),
      (west + east) / 2,
      -depth / 2,
    );
    addWall(draft, {
      floor,
      from: [west, -GALLERY_DEPTH],
      to: [west, -depth + half],
      options: {
        cutaway: {
          roomId: index === 0 ? runner.id : storey.rooms[index - 1]!.id,
          exterior: false,
        },
      },
    });

    const count = room.colleagues.length;
    // The desks the runner could still seat, beyond its sessions, go in the
    // rooms from the west, filling each room's last column.
    const columns = Math.max(1, Math.ceil(count / DESK_ROWS));
    const spare = Math.max(
      0,
      Math.min(columns * DESK_ROWS - count, runner.slots - storey.sessions - seated),
    );
    seated += spare;
    const usable = roomWidth - 2 * ROOM_MARGIN;
    const pitch = Math.min(
      unit.width + DESK_GAP + 0.6,
      Math.max(unit.width + DESK_GAP, usable / columns),
    );
    const centre = (west + east) / 2;
    for (let slot = 0; slot < count + spare; slot++) {
      const column = Math.floor(slot / DESK_ROWS);
      const row = slot % DESK_ROWS;
      const x = centre + (column - (columns - 1) / 2) * pitch;
      const z = -GALLERY_DEPTH - row * rowPitch - unit.front;
      const colleague = room.colleagues[slot];
      if (colleague === undefined) {
        addVacantOutline(group, x, z, unit);
        continue;
      }
      const desk: DeskHandle = buildDesk();
      placeObject(group, desk.object, x, z, Math.PI);
      nav.blockObject(floor, desk.object);
      draft.homes.set(colleague.id, readSeat(desk.seatMarker, floor, "desk", room.id, desk));
    }

    const lamps = roomWidth > 6.5 ? 2 : 1;
    const deskMiddle = -GALLERY_DEPTH - ((DESK_ROWS - 1) * rowPitch) / 2 - unit.front;
    for (let lamp = 0; lamp < lamps; lamp++) {
      placeObject(group, buildPendant(), west + (roomWidth * (lamp + 0.5)) / lamps, deskMiddle);
    }
    const rect: PlanRect = { minX: west, maxX: east, minZ: -depth, maxZ: 0 };
    addRoom(draft, {
      id: room.id,
      label: room.label,
      kind: room.group === "reading" ? "reading-room" : "code",
      floor,
      rect,
      project: room.group === "reading" ? null : room.group,
    });
  });

  addRoom(draft, {
    id: runner.id,
    label: runner.name,
    kind: "floor",
    floor,
    rect: storeyRect,
    view: { ...buildRoomView(storeyRect, floor), azimuth: 24, elevation: 26 },
  });

  addStoreyFront(group, width, core, runner.name);
  addPiers(group, width, depth, 0, SLAB_BOTTOM);

  nav.addFloor(floor, readFloorHeight(floor), half, -depth + half, width - half, -FRONT_KEEP_OUT);
}

/**
 * Adds a storey's open front: the brass rail, and a plaque with the storey's
 * name on the slab's front under the lift landing, so a runner's storey reads
 * from outside the tower.
 */
export function addStoreyFront(group: Object3D, width: number, core: number, name: string): void {
  placeObject(group, buildFrontRail(width - 0.1, RAIL_HEIGHT), width / 2, -0.12);
  const plaque = buildPlaque(name);
  const size = measureObject(plaque);
  const tall = size.max.y - size.min.y;
  plaque.scale.setScalar(Math.min(2.2, 0.27 / Math.max(tall, 0.01)));
  placeObject(group, plaque, core / 2, 0.1, 0, (SLAB_BOTTOM - 0.1) / 2);
}

/**
 * Adds one storey's piece of the fluted piers, `STOREY_HEIGHT` tall from
 * `base`, at the south-west, south-east and north-east corners of a block
 * `width` wide whose north wall stands at z = -`depth` and whose front is at
 * z = `front`.
 */
export function addPiers(
  group: Object3D,
  width: number,
  depth: number,
  front: number,
  base: number,
): void {
  const half = WALL_THICKNESS / 2;
  const corners: Array<readonly [number, number]> = [
    [-half - PIER_HALF, front],
    [width + half + PIER_HALF, front],
    [width + half + PIER_HALF, -depth - half - PIER_HALF],
  ];
  const pierGroup = new Group();
  for (const [x, z] of corners) {
    placeObject(pierGroup, buildPier(STOREY_HEIGHT), x, z, 0, base);
  }
  group.add(pierGroup);
}
