/**
 * PROTOTYPE - the Tower's ground floor, the lobby. West to east: the lift
 * core, Triage's case room with the case board and the filing cabinets, the
 * user's office with the partner desk and the queue in front of it, the
 * lounge with the tea trolley, and the foyer with the front door.
 *
 * The lobby is wider than the storeys above it and reaches further south, so
 * the tower stands on a podium. Its north wall lines up with theirs, so the
 * lift rises straight through every storey.
 */
import type { OfficeSpots, RoomKind, Seat, Spot } from "../engine/contracts";
import { buildFloor, WALL_THICKNESS } from "../kit/architecture";
import {
  buildArmchair,
  buildBench,
  buildCabinet,
  buildCaseBoard,
  buildCoatStand,
  buildDesk,
  buildFloorLamp,
  buildNowServing,
  buildPlant,
  buildRug,
  buildTeaTrolley,
  buildWallClock,
  buildYourDesk,
  type CaseBoardHandle,
} from "../kit/props";
import type { Token } from "../engine/palette";
import type { World } from "../world/types";
import type { TowerPlan } from "./tower-plan";
import {
  addRoom,
  addWall,
  buildSpot,
  placeObject,
  readSeat,
  readSpot,
  type PlanRect,
  type TowerDraft,
} from "./tower-draft";
import { buildFrontRail, buildPendant } from "./tower-shell";
import { addPiers, addSlab } from "./tower-storey";

/** One of the lobby's rooms: its id's last part, its name and kind, its least width and its floor's inlay. */
interface LobbyRoom {
  readonly key: string;
  readonly label: string;
  readonly kind: RoomKind;
  readonly need: number;
  readonly inlay: Token;
}

/** The lobby's rooms after the core, west to east. */
const LOBBY_ROOMS: ReadonlyArray<LobbyRoom> = [
  { key: "case-room", label: "Case room", kind: "case-room", need: 4.6, inlay: "room-inlay" },
  { key: "your-office", label: "Your office", kind: "your-office", need: 5.2, inlay: "you" },
  { key: "lounge", label: "Lounge", kind: "lounge", need: 4.6, inlay: "room-inlay-2" },
  { key: "foyer", label: "Foyer", kind: "lobby", need: 3.6, inlay: "room-inlay" },
];

/** How far south of the lobby's north wall the partitions between its rooms reach. */
const PARTITION_END = -1.5;
/** How many places the queue in front of the user's desk has. */
const QUEUE_LENGTH = 7;
const QUEUE_PITCH = 0.7;
/** The front door's width. */
const DOOR_WIDTH = 1.3;

/** What the lobby gives the rest of the tower. */
export interface LobbyHandle {
  readonly spots: OfficeSpots;
  readonly caseBoard: CaseBoardHandle;
}

/** Returns the width the lobby needs, its lift core included. */
export function measureLobbyWidth(coreWidth: number): number {
  return LOBBY_ROOMS.reduce((sum, room) => sum + room.need, coreWidth);
}

/**
 * Builds the lobby into the ground storey's group, the podium's roof into
 * the first storey's group, and lists the lobby's rooms. Returns the office's
 * spots and the case board.
 */
export function buildLobby(draft: TowerDraft, plan: TowerPlan, world: World): LobbyHandle {
  const { frame, nav } = draft;
  const group = draft.storeys[0]!;
  const depth = frame.depth;
  const front = frame.lobbyFront;
  const width = frame.lobbyWidth;
  const core = frame.coreWidth;
  const half = WALL_THICKNESS / 2;
  const north = -depth + half;

  // The rooms' edges, west to east after the core, sharing out the spare width.
  const needed = LOBBY_ROOMS.reduce((sum, room) => sum + room.need, 0);
  const stretch = (width - core) / needed;
  let edge = core;
  const rects = LOBBY_ROOMS.map((room): PlanRect => {
    const rect = { minX: edge, maxX: edge + room.need * stretch, minZ: -depth, maxZ: front };
    edge = rect.maxX;
    return rect;
  });
  const [caseRoom, office, lounge, foyer] = rects as [PlanRect, PlanRect, PlanRect, PlanRect];
  const roomId = (index: number): string => `lobby/${LOBBY_ROOMS[index]!.key}`;

  // Floors: the core, then one per room, each with its own inlay.
  placeObject(
    group,
    buildFloor(core, depth + front, { inlay: "room-inlay-2" }),
    core / 2,
    (front - depth) / 2,
  );
  rects.forEach((rect, index) => {
    placeObject(
      group,
      buildFloor(rect.maxX - rect.minX, depth + front, { inlay: LOBBY_ROOMS[index]!.inlay }),
      (rect.minX + rect.maxX) / 2,
      (front - depth) / 2,
    );
  });

  // The outer walls, anticlockwise from the north-east corner. The front
  // door is in the foyer, in the south wall.
  const foyerX = (foyer.minX + foyer.maxX) / 2;
  addWall(draft, {
    floor: 0,
    from: [width + half, -depth],
    to: [-half, -depth],
    options: { windows: true, cutaway: { roomId: "lobby", exterior: true } },
  });
  addWall(draft, {
    floor: 0,
    from: [0, north],
    to: [0, front - half],
    options: { cutaway: { roomId: "lobby", exterior: true } },
  });
  addWall(draft, {
    floor: 0,
    from: [-half, front],
    to: [width + half, front],
    options: {
      windows: true,
      doors: [{ at: foyerX - width / 2, width: DOOR_WIDTH }],
      cutaway: { roomId: "lobby", exterior: true },
    },
  });
  addWall(draft, {
    floor: 0,
    from: [width, front - half],
    to: [width, north],
    options: { windows: true, cutaway: { roomId: roomId(3), exterior: true } },
  });
  // The partitions between the rooms stop short of the front, so the
  // walkway along it joins the front door to the lift.
  rects.forEach((rect, index) => {
    addWall(draft, {
      floor: 0,
      from: [rect.minX, PARTITION_END],
      to: [rect.minX, north],
      options: {
        cutaway: { roomId: index === 0 ? "lobby" : roomId(index - 1), exterior: false },
      },
    });
  });

  const caseBoard = furnishCaseRoom(draft, plan, caseRoom, roomId(0), world);
  const { yourDesk, queue } = furnishOffice(draft, office, world);
  const { seats, tea } = furnishLounge(draft, lounge, roomId(2));

  // The foyer: a mat inside the front door, a coat stand beside it, a bench
  // to wait on, a clock over it, and a tall plant.
  placeObject(group, buildRug(1.6, 1.1), foyerX, front - 0.75);
  const coats = placeObject(group, buildCoatStand(), foyerX + DOOR_WIDTH / 2 + 0.5, front - 0.4);
  nav.blockObject(0, coats);
  const bench = placeObject(
    group,
    buildBench(3).object,
    width - half - 0.3,
    -depth / 2,
    -Math.PI / 2,
  );
  nav.blockObject(0, bench);
  placeObject(group, buildWallClock(), foyerX, north, 0, 2.05);
  nav.blockObject(0, placeObject(group, buildPlant("tall"), width - 0.5, north + 0.45));
  placeObject(group, buildPendant(), foyerX, -depth / 2);

  rects.forEach((rect, index) => {
    const room = LOBBY_ROOMS[index]!;
    addRoom(draft, { id: roomId(index), label: room.label, kind: room.kind, floor: 0, rect });
  });
  const lobbyRect: PlanRect = { minX: 0, maxX: width, minZ: -depth, maxZ: front };
  // The whole storey is a room of kind "floor", like every storey above it,
  // so from afar the overlay shows its one label and not its rooms' labels.
  addRoom(draft, { id: "lobby", label: "Ground floor", kind: "floor", floor: 0, rect: lobbyRect });

  addPiers(group, width, depth, front, -0.1);
  addPodiumRoof(draft);
  nav.addFloor(0, 0, half, north, width - half, front - half);

  return {
    caseBoard,
    spots: {
      yourDesk,
      queue,
      lounge: seats,
      caseBoard: readSpot(caseBoard.pinMarker, 0),
      records: buildSpot(caseRoom.maxX - 0.96, north + 1.1, Math.PI, 0),
      entrance: buildSpot(foyerX, front - 0.9, Math.PI, 0),
      tea,
    },
  };
}

/**
 * Furnishes Triage's case room: the case board on the north wall with the
 * filing cabinets beside it, and Triage's desk facing the open front.
 * Returns the case board.
 */
function furnishCaseRoom(
  draft: TowerDraft,
  plan: TowerPlan,
  rect: PlanRect,
  roomId: string,
  world: World,
): CaseBoardHandle {
  const group = draft.storeys[0]!;
  const north = rect.minZ + WALL_THICKNESS / 2;
  // Three cabinets against the north wall at the east end; the board fills the rest.
  for (let index = 0; index < 3; index++) {
    const cabinet = placeObject(
      group,
      buildCabinet(),
      rect.maxX - 0.41 - index * 0.55,
      north + 0.3,
    );
    draft.nav.blockObject(0, cabinet);
  }
  const boardWest = rect.minX + 0.4;
  const boardEast = rect.maxX - 0.41 - 2 * 0.55 - 0.25 - 0.3;
  const boardWidth = Math.min(2.6, Math.max(1.6, boardEast - boardWest));
  const board = buildCaseBoard(boardWidth);
  placeObject(group, board.object, boardWest + boardWidth / 2, north);
  draft.nav.blockObject(0, board.object);
  board.setCards(world.proposals.total, world.proposals.burning);

  // Triage's desk in the middle of the room, facing the open front with the
  // board behind it.
  const middle = (rect.minX + rect.maxX) / 2;
  const deskZ = (rect.minZ + PARTITION_END) / 2;
  plan.triage.forEach((colleague, index) => {
    const desk = buildDesk();
    const x = middle + (index - (plan.triage.length - 1) / 2) * 1.8;
    placeObject(group, desk.object, x, deskZ, Math.PI);
    draft.nav.blockObject(0, desk.object);
    draft.homes.set(colleague.id, readSeat(desk.seatMarker, 0, "desk", roomId, desk));
  });
  placeObject(group, buildPendant(), middle, deskZ);
  return board;
}

/**
 * Furnishes the user's office: the partner desk near the north wall under
 * the "Now serving" sign, and the queue straight south of it. Returns the
 * user's chair and the queue, head first.
 */
function furnishOffice(
  draft: TowerDraft,
  rect: PlanRect,
  world: World,
): { yourDesk: Spot; queue: Spot[] } {
  const group = draft.storeys[0]!;
  const north = rect.minZ + WALL_THICKNESS / 2;
  const middle = (rect.minX + rect.maxX) / 2;
  const deskZ = north + 1.56;
  const desk = buildYourDesk();
  placeObject(group, desk.object, middle, deskZ);
  draft.nav.blockObject(0, desk.object);
  const sign = buildNowServing();
  placeObject(group, sign.object, middle, north, 0, 1.75);
  sign.setNumber(world.colleagues.filter((colleague) => colleague.request !== null).length);
  addOfficeCorners(draft, rect, north);
  placeObject(group, buildPendant(), middle, deskZ + 0.6);
  // The visitor's place is 0.95 south of the desk's middle; the queue starts there.
  const queue = Array.from({ length: QUEUE_LENGTH }, (_, index) =>
    buildSpot(middle, deskZ + 0.95 + index * QUEUE_PITCH, Math.PI, 0),
  );
  return { yourDesk: readSpot(desk.seatMarker, 0), queue };
}

/** Puts a standard lamp and a tall plant in the office's two north corners. */
function addOfficeCorners(draft: TowerDraft, rect: PlanRect, north: number): void {
  const group = draft.storeys[0]!;
  draft.nav.blockObject(
    0,
    placeObject(group, buildFloorLamp().object, rect.minX + 0.45, north + 0.4),
  );
  draft.nav.blockObject(0, placeObject(group, buildPlant("tall"), rect.maxX - 0.45, north + 0.4));
}

/**
 * Furnishes the lounge: two pairs of armchairs facing each other across a
 * rug, the tea trolley against the north wall, a standard lamp and a plant.
 * Returns the armchairs' seats and the spot in front of the trolley.
 */
function furnishLounge(
  draft: TowerDraft,
  rect: PlanRect,
  roomId: string,
): { seats: Seat[]; tea: Spot } {
  const group = draft.storeys[0]!;
  const north = rect.minZ + WALL_THICKNESS / 2;
  const middle = (rect.minX + rect.maxX) / 2;
  // The seating sits in the middle of the room, clear of the trolley.
  const rugZ = (rect.minZ + PARTITION_END) / 2 + 0.4;
  placeObject(group, buildRug(2.8, 2.2), middle, rugZ);
  const seats: Seat[] = [];
  for (const side of [-1, 1]) {
    for (const along of [-0.55, 0.55]) {
      const chair = buildArmchair();
      // The western pair faces east, the eastern pair faces west.
      placeObject(group, chair.object, middle + side * 1.2, rugZ + along, (-side * Math.PI) / 2);
      draft.nav.blockObject(0, chair.object);
      seats.push(readSeat(chair.seatMarker, 0, "armchair", roomId, null));
    }
  }
  const trolley = placeObject(group, buildTeaTrolley(), middle, north + 0.4);
  draft.nav.blockObject(0, trolley);
  draft.nav.blockObject(
    0,
    placeObject(group, buildFloorLamp().object, rect.minX + 0.45, north + 0.4),
  );
  draft.nav.blockObject(0, placeObject(group, buildPlant("small"), rect.maxX - 0.45, north + 0.4));
  placeObject(group, buildPendant(), middle, rugZ);
  return { seats, tea: buildSpot(middle, north + 1.25, Math.PI, 0) };
}

/**
 * Builds the podium's roof into the first storey's group: the slab over the
 * whole lobby, and a brass rail round the part of it the storeys above do
 * not cover.
 */
function addPodiumRoof(draft: TowerDraft): void {
  const { frame } = draft;
  const group = draft.storeys[1]!;
  const half = WALL_THICKNESS / 2;
  const width = frame.lobbyWidth;
  const depth = frame.depth;
  const front = frame.lobbyFront;
  addSlab(group, { minX: -half, maxX: width + half, minZ: -depth - half, maxZ: front + half });
  const height = 0.62;
  placeObject(group, buildFrontRail(width - 0.1, height), width / 2, front - 0.1);
  placeObject(
    group,
    buildFrontRail(depth + front - 0.2, height),
    width - 0.1,
    (front - depth) / 2,
    Math.PI / 2,
  );
  const terrace = width - frame.width;
  if (terrace > 0.6) {
    placeObject(
      group,
      buildFrontRail(terrace - 0.3, height),
      frame.width + terrace / 2,
      -depth + 0.1,
    );
  }
}
