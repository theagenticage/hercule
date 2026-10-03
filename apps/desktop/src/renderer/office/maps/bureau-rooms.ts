/**
 * The Bureau floor's rooms: which rooms the world needs, how much floor each
 * one asks the plan for, and how each one is furnished once the plan has
 * placed it. The Office Map decides which fixed rooms exist, their names,
 * their furniture and the spots they offer; this file decides where each
 * piece stands. Every size comes from measuring the furniture, so the rooms
 * follow the props kit when its pieces change.
 *
 * A room is furnished in world space, from its rectangle. Furniture that
 * stands on the floor is placed with `Fitter.place`; anything that hangs on a
 * wall goes through `Fitter.hang`, which hides it while the camera lowers
 * that wall, so nothing is left floating over a cut-away wall.
 */
import { Box3, BoxGeometry, Group, Mesh, Vector3, type BufferGeometry, type Object3D } from "three";
import type { DeskHandle, RoomKind, Seat, Spot } from "../engine/contracts";
import { paint } from "../engine/palette";
import type { ProjectTint } from "../../screens/project-tile";
import { WALL_THICKNESS } from "../kit/architecture";
import {
  buildArmchair,
  buildBench,
  buildCabinet,
  buildCaseBoard,
  buildCoatStand,
  buildDesk,
  buildNowServing,
  buildPlant,
  buildRug,
  buildTeaTrolley,
  buildWallClock,
  buildYourDesk,
  type CaseBoardHandle,
  type NowServingHandle,
} from "../kit/props";
import type { FixedRoom, Furniture, OfficeMap, SpotKind } from "./office-map";
import type { Colleague, ThreadRoom, World } from "../world/types";
import type { PlannedRoom, PlanRequest, Rect, RoomRequest } from "./bureau-plan";

/** The floor an object covers, and where the middle of that floor sits from the object's origin. */
export interface Footprint {
  readonly width: number;
  readonly depth: number;
  readonly centreX: number;
  readonly centreZ: number;
}

/**
 * Measures the floor an object covers when it is turned to `facing`. Only
 * visible meshes count, so a desk's hidden pool of lamplight does not widen
 * the desk. Leaves the object turned to `facing`, at the origin.
 */
export function measureFootprint(object: Object3D, facing: number): Footprint {
  object.rotation.y = facing;
  object.position.set(0, 0, 0);
  object.updateMatrixWorld(true);
  const box = new Box3();
  object.traverseVisible((child) => {
    if (!(child instanceof Mesh)) return;
    const geometry = child.geometry as BufferGeometry;
    geometry.computeBoundingBox();
    if (geometry.boundingBox !== null) {
      box.union(geometry.boundingBox.clone().applyMatrix4(child.matrixWorld));
    }
  });
  if (box.isEmpty()) return { width: 0, depth: 0, centreX: 0, centreZ: 0 };
  return {
    width: box.max.x - box.min.x,
    depth: box.max.z - box.min.z,
    centreX: (box.min.x + box.max.x) / 2,
    centreZ: (box.min.z + box.max.z) / 2,
  };
}

/** What a room's furnishing calls to put things in the office. `bureau.ts` implements it. */
export interface Fitter {
  /**
   * Places furniture so the middle of its footprint lands on (x, z), turned
   * to `facing`, and returns the footprint's rectangle. Colleagues walk
   * around it, unless it is `walkable` (a rug).
   */
  place(object: Object3D, x: number, z: number, facing?: number, walkable?: boolean): Rect;
  /**
   * Hangs an ornament on the wall nearest to (x, z), its back on the wall's
   * face, at height y, facing `facing`. It hides while the camera lowers that
   * wall.
   */
  hang(object: Object3D, x: number, y: number, z: number, facing: number): void;
  /** Places a standard lamp, which the office lights in the evening. */
  placeLamp(x: number, z: number): void;
  /** Returns the spot at a marker of furniture already placed, in world space. */
  readSpot(marker: Object3D): Spot;
}

/** What the rooms give the built office: seats, spots, and the pieces the office animates. */
export interface Fittings {
  readonly homes: Map<string, Seat>;
  readonly lounge: Seat[];
  readonly queue: Spot[];
  /** Every desk with an owner, and the runner its owner runs on, for the fleet's desk tags. */
  readonly ownedDesks: Array<{ readonly desk: DeskHandle; readonly runnerId: string | null }>;
  yourDesk: Spot | null;
  tea: Spot | null;
  entrance: Spot | null;
  board: CaseBoardHandle | null;
  nowServing: NowServingHandle | null;
}

/** One room the world needs: what it asks of the plan, and how it is furnished once placed. */
interface RoomDesign {
  readonly request: RoomRequest;
  furnish(room: PlannedRoom, fitter: Fitter, fittings: Fittings): void;
}

/** Everything `designRooms` decides: the plan's request, and the furnishing of each room by id. */
interface RoomDesigns {
  readonly request: PlanRequest;
  readonly designs: ReadonlyMap<string, RoomDesign>;
}

/** The gap between two desks side by side, and the aisle behind a row of chairs. */
const DESK_GAP = 0.5;
const DESK_AISLE = 0.9;
/** The space between two places in the queue. */
const QUEUE_PITCH = 0.72;
/** Half a wall: a room's rectangle runs to the walls' middles. */
const HALF_WALL = WALL_THICKNESS / 2;

/** The furniture sizes the rooms are planned around, measured once per build. */
interface KitSizes {
  /** A clerk's desk with its chair, turned so its sitter faces +z. */
  readonly desk: Footprint;
  readonly cabinet: Footprint;
}

/** Rows and columns of desks, and the floor they cover. */
interface DeskGrid {
  readonly count: number;
  readonly cols: number;
  readonly rows: number;
  readonly width: number;
  readonly depth: number;
}

/** Returns the grid for `count` desks, at most `maxCols` side by side. */
function planDeskGrid(count: number, maxCols: number, desk: Footprint): DeskGrid {
  if (count === 0) return { count, cols: 0, rows: 0, width: 0, depth: 0 };
  const rows = Math.ceil(count / maxCols);
  const cols = Math.ceil(count / rows);
  return {
    count,
    cols,
    rows,
    width: cols * desk.width + (cols - 1) * DESK_GAP,
    depth: rows * desk.depth + (rows - 1) * DESK_AISLE,
  };
}

/**
 * Returns how many desks a room puts side by side: three, or more for a big
 * group, so a room with many desks grows wider rather than deeper. Its row of
 * the floor is as deep as its deepest room, so one deep room would leave its
 * neighbours deep and empty.
 */
function decideColumnLimit(count: number): number {
  return Math.max(3, Math.ceil(Math.sqrt(count * 2)));
}

/** Returns the rooms' sizes, measured from the props kit. */
function measureKit(): KitSizes {
  return {
    desk: measureFootprint(buildDesk().object, Math.PI),
    cabinet: measureFootprint(buildCabinet(), 0),
  };
}

/**
 * Seats colleagues at a grid of clerk's desks centred on (x, z). Every desk
 * faces south, so its sitter faces the camera; the last row is centred when
 * it is not full.
 */
function seatAtDesks(
  colleagues: ReadonlyArray<Colleague>,
  grid: DeskGrid,
  x: number,
  z: number,
  roomId: string,
  sizes: KitSizes,
  fitter: Fitter,
  fittings: Fittings,
): void {
  const pitchX = sizes.desk.width + DESK_GAP;
  const pitchZ = sizes.desk.depth + DESK_AISLE;
  colleagues.forEach((colleague, index) => {
    const row = Math.floor(index / grid.cols);
    const inRow = Math.min(grid.cols, colleagues.length - row * grid.cols);
    const col = index % grid.cols;
    const deskX = x - ((inRow - 1) * pitchX) / 2 + col * pitchX;
    const deskZ = z - grid.depth / 2 + sizes.desk.depth / 2 + row * pitchZ;
    const desk = buildDesk();
    fitter.place(desk.object, deskX, deskZ, Math.PI);
    fittings.homes.set(colleague.id, {
      ...fitter.readSpot(desk.seatMarker),
      kind: "desk",
      roomId,
      desk,
    });
    fittings.ownedDesks.push({ desk, runnerId: colleague.runnerId });
  });
}

/** Returns the room's floor inside its walls. */
function computeFloorInsideWalls(rect: Rect): Rect {
  return {
    minX: rect.minX + HALF_WALL,
    minZ: rect.minZ + HALF_WALL,
    maxX: rect.maxX - HALF_WALL,
    maxZ: rect.maxZ - HALF_WALL,
  };
}

/** Builds a seating group on a rug: two armchairs facing south, one each side facing in. */
function placeSeatingGroup(
  x: number,
  z: number,
  roomId: string,
  fitter: Fitter,
  into: Seat[] | null,
): void {
  fitter.place(buildRug(2.7, 2.3), x, z + 0.05, 0, true);
  const chairs: Array<readonly [number, number, number]> = [
    [-0.55, -0.62, 0],
    [0.55, -0.62, 0],
    [-1.12, 0.42, Math.PI / 2],
    [1.12, 0.42, -Math.PI / 2],
  ];
  for (const [dx, dz, facing] of chairs) {
    const chair = buildArmchair();
    fitter.place(chair.object, x + dx, z + dz, facing);
    into?.push({ ...fitter.readSpot(chair.seatMarker), kind: "armchair", roomId, desk: null });
  }
}

/**
 * Builds a sign on a stand: a wooden post on a square foot, with `sign` on
 * the post's front, its bottom at `height`. The sign's back must be at z = 0.
 */
function buildSignStand(sign: Object3D, height: number): Object3D {
  const stand = new Group();
  const wood = paint("room-wood", "lacquer");
  const foot = new Mesh(new BoxGeometry(0.34, 0.04, 0.34), wood);
  foot.position.set(0, 0.02, -0.04);
  const post = new Mesh(new BoxGeometry(0.05, height + 0.2, 0.05), wood);
  post.position.set(0, (height + 0.2) / 2, -0.04);
  for (const mesh of [foot, post]) mesh.castShadow = mesh.receiveShadow = true;
  sign.position.set(0, height, -0.012);
  stand.add(foot, post, sign);
  return stand;
}

/**
 * Builds a free-standing frame for a board that is made to hang on a wall:
 * two wooden legs behind it, from the floor to its top, so the board stays
 * standing when the wall behind it is lowered.
 */
function buildBoardStand(board: Object3D, width: number, top: number): Object3D {
  const stand = new Group();
  const wood = paint("room-wood", "lacquer");
  for (const side of [-1, 1]) {
    const leg = new Mesh(new BoxGeometry(0.06, top, 0.06), wood);
    leg.position.set(side * (width / 2 - 0.12), top / 2, -0.04);
    const foot = new Mesh(new BoxGeometry(0.08, 0.04, 0.42), wood);
    foot.position.set(side * (width / 2 - 0.12), 0.02, -0.04);
    for (const mesh of [leg, foot]) mesh.castShadow = mesh.receiveShadow = true;
    stand.add(leg, foot);
  }
  stand.add(board);
  return stand;
}

/** Returns a room request with the plan's minimum size applied. */
function requestRoom(
  id: string,
  label: string,
  kind: RoomKind,
  tint: ProjectTint | null,
  width: number,
  depth: number,
  doorAt?: number,
): RoomRequest {
  const size = {
    id,
    label,
    kind,
    tint,
    width: Math.max(4.2, width),
    depth: Math.max(4.4, depth),
  };
  return doorAt === undefined ? size : { ...size, doorAt };
}

/**
 * Returns the checks a fixed room's furnishing asks: whether the map puts a
 * piece of furniture in the room, and whether the room offers a kind of spot.
 */
function readFixedRoom(room: FixedRoom): {
  readonly has: (piece: Furniture) => boolean;
  readonly offers: (spot: SpotKind) => boolean;
} {
  return {
    has: (piece) => room.furniture.includes(piece),
    offers: (spot) => room.spots.includes(spot),
  };
}

/**
 * Decides the rooms the world needs and how each is furnished:
 *
 * - one room per thread room of the world, in its order, with a desk for each
 *   of its colleagues in desk order;
 * - the fixed rooms of `map`, in its order, along the street, the last one
 *   holding the front door. The Lounge grows a seating group as the fleet
 *   grows.
 *
 * `directory` is the fleet's board, which stands in the Lobby.
 */
export function designRooms(world: World, map: OfficeMap, directory: Object3D): RoomDesigns {
  const sizes = measureKit();
  const designs = new Map<string, RoomDesign>();
  const colleagues = new Map(world.colleagues.map((colleague) => [colleague.id, colleague]));
  const add = (design: RoomDesign): RoomRequest => {
    designs.set(design.request.id, design);
    return design.request;
  };
  const code = world.rooms.map((room) =>
    add(
      designThreadRoom(
        room,
        room.colleagueIds.flatMap((id) => colleagues.get(id) ?? []),
        sizes,
      ),
    ),
  );
  const loungeGroups = world.colleagues.length <= 24 ? 2 : world.colleagues.length <= 60 ? 3 : 4;
  const front = map.fixedRooms.map((room) => {
    switch (room.kind) {
      case "triage-room":
        return add(designTriageRoom(room, sizes));
      case "lounge":
        return add(designLounge(room, loungeGroups));
      case "your-office":
        return add(designYourOffice(room));
      case "lobby":
        return add(designLobby(room, directory));
    }
  });
  return { request: { code, back: [], front, connections: [] }, designs };
}

/** Designs a thread room: desks in rows facing the camera, a plant by the far wall, a lamp. */
function designThreadRoom(
  room: ThreadRoom,
  colleagues: ReadonlyArray<Colleague>,
  sizes: KitSizes,
): RoomDesign {
  const grid = planDeskGrid(colleagues.length, decideColumnLimit(colleagues.length), sizes.desk);
  // A metre each side for the aisles, and a strip on the east for a plant and a lamp.
  const dressing = 0.95;
  return {
    request: requestRoom(
      room.id,
      room.name,
      "project",
      room.tint,
      grid.width + 2.0 + dressing,
      grid.depth + 2.4,
    ),
    furnish(planned, fitter, fittings) {
      const inside = computeFloorInsideWalls(planned.rect);
      const centreX = (inside.minX + inside.maxX - dressing) / 2;
      const centreZ = (inside.minZ + inside.maxZ) / 2;
      seatAtDesks(colleagues, grid, centreX, centreZ, room.id, sizes, fitter, fittings);
      // The far wall is the one away from the corridor: the window wall in the north row.
      const farZ = planned.doorSide === "south" ? inside.minZ : inside.maxZ;
      const nearZ = planned.doorSide === "south" ? inside.maxZ : inside.minZ;
      const towardNear = Math.sign(nearZ - farZ);
      fitter.place(buildPlant("tall"), inside.maxX - 0.42, farZ + towardNear * 0.42);
      // No wall clock here: the far wall of a north-row room is an outside wall, and the kit
      // places the windows on it, so a clock could land on a window.
      fitter.placeLamp(inside.maxX - 0.35, nearZ - towardNear * 0.9);
    },
  };
}

/**
 * Designs the Triage room: Triage's desk before the case board. The desk
 * stays empty, because no Triage character is drawn, and the board shows no
 * cards, because the Office does not read Proposals yet.
 */
function designTriageRoom(fixed: FixedRoom, sizes: KitSizes): RoomDesign {
  const { has } = readFixedRoom(fixed);
  const boardWidth = 2.2;
  const boardZone = 3.0;
  return {
    request: requestRoom(
      "triage-room",
      fixed.name,
      "triage-room",
      null,
      Math.max(sizes.desk.width + 1.8, 5.4),
      boardZone + 1.0,
      0.86,
    ),
    furnish(room, fitter, fittings) {
      const inside = computeFloorInsideWalls(room.rect);
      if (has("case-board")) {
        const boardX = (inside.minX + inside.maxX) / 2 + 0.3;
        const board = buildCaseBoard(boardWidth);
        board.setCards(0, 0);
        const boardTop = new Box3().setFromObject(board.object).max.y;
        fitter.place(
          buildBoardStand(board.object, boardWidth, boardTop),
          boardX,
          inside.minZ + 0.3,
        );
        fittings.board = board;
      }
      // Triage's own desk, west of the board.
      if (has("clerks-desk")) {
        const desk = buildDesk();
        fitter.place(desk.object, inside.minX + 1.1, inside.minZ + 1.75, Math.PI);
        desk.setLamp(false);
      }
      if (has("plant")) fitter.place(buildPlant("tall"), inside.maxX - 0.4, inside.maxZ - 0.4);
      if (has("lamp")) fitter.placeLamp(inside.minX + 0.35, inside.maxZ - 0.45);
    },
  };
}

/** Designs the Lounge: seating groups on rugs, the tea trolley, plants by the windows. */
function designLounge(fixed: FixedRoom, groups: number): RoomDesign {
  const { has, offers } = readFixedRoom(fixed);
  const cols = Math.min(groups, 2);
  const rows = Math.ceil(groups / cols);
  // A seating group is open to the south, so a colleague reaches its
  // armchairs from inside it. The cells leave about 1.2 metres between
  // groups, and between rows, to walk round to that open side.
  const cellWidth = 4.3;
  const cellDepth = 3.1;
  return {
    request: requestRoom(
      "lounge",
      fixed.name,
      "lounge",
      null,
      cols * cellWidth + 1.2,
      rows * cellDepth + 2.3,
      0.3,
    ),
    furnish(room, fitter, fittings) {
      const inside = computeFloorInsideWalls(room.rect);
      if (has("tea-trolley")) {
        const trolley = fitter.place(buildTeaTrolley(), inside.maxX - 1.0, inside.minZ + 0.32);
        if (offers("stand")) {
          fittings.tea = {
            position: new Vector3((trolley.minX + trolley.maxX) / 2, 0, trolley.maxZ + 0.42),
            facing: Math.PI,
            floor: 0,
          };
        }
      }
      const x = (inside.minX + inside.maxX) / 2;
      const z = (inside.minZ + 1.4 + inside.maxZ) / 2;
      for (let index = 0; has("armchairs") && index < groups; index++) {
        const col = index % cols;
        const row = Math.floor(index / cols);
        const groupX = x + (col - (cols - 1) / 2) * cellWidth;
        const groupZ = z + (row - (rows - 1) / 2) * cellDepth;
        placeSeatingGroup(
          groupX,
          groupZ,
          "lounge",
          fitter,
          offers("seat") ? fittings.lounge : null,
        );
        // The lamp stands at the group's outer back corner, clear of the walk between groups.
        if (has("lamp"))
          fitter.placeLamp(groupX + (col < (cols - 1) / 2 ? -1.45 : 1.45), groupZ - 0.85);
      }
      if (has("plant")) {
        fitter.place(buildPlant("tall"), inside.minX + 0.4, inside.maxZ - 0.4);
        fitter.place(buildPlant("tall"), inside.maxX - 0.4, inside.maxZ - 0.4);
        fitter.place(buildPlant("small"), inside.minX + 0.35, inside.minZ + 0.35);
      }
    },
  };
}

/**
 * Designs Your Office: the partner desk near the street windows, the user
 * facing north, toward the queue. The queue runs north from the visitor's
 * place at the desk, then turns east toward the door, so a newcomer joins at
 * the tail just inside it.
 */
function designYourOffice(fixed: FixedRoom): RoomDesign {
  const { has, offers } = readFixedRoom(fixed);
  return {
    request: requestRoom("your-office", fixed.name, "your-office", null, 6.6, 6.2, 0.84),
    furnish(room, fitter, fittings) {
      const inside = computeFloorInsideWalls(room.rect);
      const deskX = inside.minX + 2.2;
      const deskZ = inside.maxZ - 1.75;
      if (has("partner-desk")) {
        const desk = buildYourDesk();
        fitter.place(buildRug(3.6, 2.9), deskX, deskZ + 0.1, 0, true);
        const deskRect = fitter.place(desk.object, deskX, deskZ, Math.PI);
        if (offers("seat")) fittings.yourDesk = fitter.readSpot(desk.seatMarker);
        desk.setLamp(true);
        // The queue: from the visitor's place, north, then east to the door.
        // The head stands a step clear of the desk's front edge.
        if (offers("queue")) {
          const head = new Vector3(deskX, 0, deskRect.minZ - 0.45);
          const turn = new Vector3(deskX, 0, inside.minZ + 1.25);
          const end = new Vector3(inside.maxX - 0.95, 0, inside.minZ + 1.25);
          fittings.queue.push(...layQueue([head, turn, end]));
        }
      }
      if (has("now-serving")) {
        const sign = buildNowServing();
        fitter.place(buildSignStand(sign.object, 1.55), deskX - 1.45, deskZ - 0.55, Math.PI / 2);
        fittings.nowServing = sign;
      }
      if (has("bench")) {
        const bench = buildBench(3);
        fitter.place(bench.object, inside.minX + 0.3, (inside.minZ + deskZ) / 2 - 0.2, Math.PI / 2);
      }
      if (has("plant")) {
        fitter.place(buildPlant("tall"), inside.minX + 0.4, inside.maxZ - 0.4);
        fitter.place(buildPlant("tall"), inside.maxX - 0.4, inside.maxZ - 0.4);
      }
      // The lamp stands at the bench's north end. Behind the desk it would
      // close off the user's chair, which is reached from the east.
      if (has("lamp")) fitter.placeLamp(inside.minX + 0.35, inside.minZ + 0.4);
      if (has("wall-clock"))
        fitter.hang(buildWallClock(), inside.minX, 1.95, deskZ - 0.3, Math.PI / 2);
      // A corner to sit and talk in, east of the desk, when the room is wide enough.
      const cornerWidth = inside.maxX - (deskX + 2.0);
      if (has("armchairs") && cornerWidth >= 2.6) {
        const cornerX = inside.maxX - cornerWidth / 2 - 0.15;
        const cornerZ = (deskZ + inside.minZ + 2.0) / 2 + 0.4;
        fitter.place(buildRug(2.2, 1.8), cornerX, cornerZ, 0, true);
        fitter.place(buildArmchair().object, cornerX - 0.55, cornerZ, Math.PI / 2);
        fitter.place(buildArmchair().object, cornerX + 0.55, cornerZ, -Math.PI / 2);
      }
    },
  };
}

/**
 * Returns the queue's places along a path, `QUEUE_PITCH` apart, head first.
 * The head faces south, toward the desk; everyone else faces the back of the
 * one ahead.
 */
function layQueue(path: ReadonlyArray<Vector3>): Spot[] {
  const points: Vector3[] = [];
  let start = 0;
  for (let index = 0; index < path.length - 1; index++) {
    const from = path[index]!;
    const to = path[index + 1]!;
    const length = from.distanceTo(to);
    let at = start;
    for (; at <= length + 1e-6; at += QUEUE_PITCH) {
      points.push(from.clone().lerp(to, length === 0 ? 0 : at / length));
    }
    // The next leg starts where this one's spacing left off, so the pitch holds round the turn.
    start = at - length;
  }
  return points.map((position, index) => {
    const ahead = points[index - 1];
    const facing = ahead === undefined ? 0 : Math.atan2(ahead.x - position.x, ahead.z - position.z);
    return { position, facing, floor: 0 };
  });
}

/** Designs the Lobby: the front door, a coat stand, a bench, and the fleet's directory. */
function designLobby(fixed: FixedRoom, directory: Object3D): RoomDesign {
  const { has, offers } = readFixedRoom(fixed);
  return {
    request: requestRoom("lobby", fixed.name, "lobby", null, 5.6, 5.0),
    furnish(room, fitter, fittings) {
      const inside = computeFloorInsideWalls(room.rect);
      const doorX = (room.rect.minX + room.rect.maxX) / 2;
      if (offers("stand")) {
        fittings.entrance = {
          position: new Vector3(doorX, 0, inside.maxZ - 0.75),
          facing: Math.PI,
          floor: 0,
        };
      }
      fitter.place(buildRug(2.2, 1.6), doorX, inside.maxZ - 1.0, 0, true);
      if (has("coat-stand")) fitter.place(buildCoatStand(), doorX - 1.25, inside.maxZ - 0.35);
      if (has("plant")) {
        fitter.place(buildPlant("tall"), inside.minX + 0.4, inside.maxZ - 0.4);
        fitter.place(buildPlant("tall"), inside.maxX - 0.4, inside.maxZ - 0.4);
      }
      if (has("bench")) {
        const bench = buildBench(3);
        fitter.place(
          bench.object,
          inside.maxX - 0.3,
          (inside.minZ + inside.maxZ) / 2 + 0.2,
          -Math.PI / 2,
        );
      }
      if (has("lamp")) fitter.placeLamp(inside.maxX - 0.4, inside.minZ + 0.45);
      if (has("directory")) {
        fitter.place(
          directory,
          inside.minX + 0.25,
          (inside.minZ + inside.maxZ) / 2 + 0.3,
          Math.PI / 2,
        );
      }
      if (has("wall-clock"))
        fitter.hang(buildWallClock(), inside.maxX - 0.75, 1.95, inside.minZ, 0);
      // Two armchairs to wait in, against the west wall and facing into the room, so they keep
      // clear of the opening into the Gallery even in the narrowest Lobby.
      if (has("armchairs")) {
        const waitX = inside.minX + 0.5;
        fitter.place(buildRug(1.4, 1.9), waitX + 0.2, inside.minZ + 1.25, 0, true);
        fitter.place(buildArmchair().object, waitX, inside.minZ + 0.8, Math.PI / 2);
        fitter.place(buildArmchair().object, waitX, inside.minZ + 1.7, Math.PI / 2);
      }
    },
  };
}
