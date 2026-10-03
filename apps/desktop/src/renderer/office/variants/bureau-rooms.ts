/**
 * PROTOTYPE - the Bureau floor's rooms: which rooms the world needs, how much
 * floor each one asks the plan for, and how each one is furnished once the
 * plan has placed it. Every size comes from measuring the furniture, so the
 * rooms follow the props kit when its pieces change.
 *
 * A room is furnished in world space, from its rectangle. Furniture that
 * stands on the floor is placed with `Fitter.place`; anything that hangs on a
 * wall goes through `Fitter.hang`, which hides it while the camera lowers
 * that wall, so nothing is left floating over a cut-away wall.
 */
import { Box3, BoxGeometry, Group, Mesh, Vector3, type BufferGeometry, type Object3D } from "three";
import type { DeskHandle, RoomKind, Seat, Spot } from "../engine/contracts";
import { paint } from "../engine/palette";
import { WALL_THICKNESS } from "../kit/architecture";
import {
  buildArmchair,
  buildBench,
  buildBookshelf,
  buildCabinet,
  buildCaseBoard,
  buildCoatStand,
  buildDesk,
  buildLongTable,
  buildNowServing,
  buildParcels,
  buildPigeonholes,
  buildPlant,
  buildRug,
  buildTeaTrolley,
  buildWallClock,
  buildYourDesk,
  type CaseBoardHandle,
  type NowServingHandle,
} from "../kit/props";
import {
  AREA_PROJECT,
  type Area,
  type Colleague,
  type ProjectKey,
  type World,
} from "../world/types";
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

/** What the rooms leave behind for the layout: seats, spots, and the pieces the office animates. */
export interface Fittings {
  readonly homes: Map<string, Seat>;
  readonly lounge: Seat[];
  readonly queue: Spot[];
  /** Every desk with an owner, and the runner its owner runs on, for the fleet's desk tags. */
  readonly ownedDesks: Array<{ readonly desk: DeskHandle; readonly runnerId: string | null }>;
  yourDesk: Spot | null;
  caseBoard: Spot | null;
  records: Spot | null;
  tea: Spot | null;
  entrance: Spot | null;
  board: CaseBoardHandle | null;
  nowServing: NowServingHandle | null;
  /** The tube's mouth in the Post Room and its end at Triage's desk, at the height of the mouths. */
  tubeStart: Vector3 | null;
  tubeEnd: Vector3 | null;
}

/** One room the world needs: what it asks of the plan, and how it is furnished once placed. */
export interface RoomDesign {
  readonly request: RoomRequest;
  furnish(room: PlannedRoom, fitter: Fitter, fittings: Fittings): void;
}

/** Everything `designRooms` decides: the plan's request, and the furnishing of each room by id. */
export interface RoomDesigns {
  readonly request: PlanRequest;
  readonly designs: ReadonlyMap<string, RoomDesign>;
}

/** The gap between two desks side by side, and the aisle behind a row of chairs. */
const DESK_GAP = 0.5;
const DESK_AISLE = 0.9;
/** The most desks a code room holds before the area gets a second room. */
const DESKS_PER_ROOM = 9;
/** The space between two places in the queue. */
const QUEUE_PITCH = 0.72;
/** Half a wall: a room's rectangle runs to the walls' middles. */
const HALF_WALL = WALL_THICKNESS / 2;

/** The labels of the code areas. */
const AREA_LABELS: Readonly<Partial<Record<Area, string>>> = {
  checkout: "Checkout",
  cart: "Cart",
  webhooks: "Webhooks",
  payouts: "Payouts",
  infra: "Infra",
  dashboards: "Dashboards",
  secrets: "Secrets",
};

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
 * Returns how many desks a meta room puts side by side: three, or more for a
 * big group, so a room with many desks grows wider rather than deeper. Its
 * row of the floor is as deep as its deepest room, so one deep room would
 * leave its neighbours deep and empty.
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
function insideWalls(rect: Rect): Rect {
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

/** Splits `items` into `parts` runs of nearly equal length, in order. */
function splitEvenly<T>(items: ReadonlyArray<T>, parts: number): T[][] {
  const runs: T[][] = [];
  let start = 0;
  for (let part = 0; part < parts; part++) {
    const end = start + Math.ceil((items.length - start) / (parts - part));
    runs.push(items.slice(start, end));
    start = end;
  }
  return runs;
}

/** Returns a room request with the plan's minimum size applied. */
function requestRoom(
  id: string,
  label: string,
  kind: RoomKind,
  project: ProjectKey | null,
  width: number,
  depth: number,
  doorAt?: number,
): RoomRequest {
  const size = {
    id,
    label,
    kind,
    project,
    width: Math.max(4.2, width),
    depth: Math.max(4.4, depth),
  };
  return doorAt === undefined ? size : { ...size, doorAt };
}

/**
 * Decides the rooms the world needs and how each is furnished. Code rooms
 * follow the areas, one per nine desks; the Reading Room appears once there
 * is review work, and the Lounge grows a seating group as the fleet grows.
 * `directory` is the fleet's board, which stands in the Lobby.
 */
export function designRooms(world: World, directory: Object3D): RoomDesigns {
  const sizes = measureKit();
  const designs = new Map<string, RoomDesign>();
  const byArea = new Map<Area, Colleague[]>();
  let triage: Colleague | null = null;
  for (const colleague of world.colleagues) {
    if (colleague.role === "triage") {
      triage = colleague;
      continue;
    }
    byArea.set(colleague.area, [...(byArea.get(colleague.area) ?? []), colleague]);
  }
  const colleaguesIn = (area: Area): Colleague[] => byArea.get(area) ?? [];
  const add = (design: RoomDesign): RoomRequest => {
    designs.set(design.request.id, design);
    return design.request;
  };

  // The code rooms, one wing per project.
  const code = world.projects.map((project) => {
    const areas = (Object.keys(AREA_PROJECT) as Area[]).filter(
      (area) => AREA_PROJECT[area] === project && colleaguesIn(area).length > 0,
    );
    const rooms = areas.flatMap((area) => {
      const colleagues = colleaguesIn(area);
      const runs = splitEvenly(colleagues, Math.ceil(colleagues.length / DESKS_PER_ROOM));
      return runs.map((run, index) => {
        const id = index === 0 ? area : `${area}-${String(index + 1)}`;
        const label = `${AREA_LABELS[area] ?? area}${index === 0 && runs.length === 1 ? "" : ` ${"I".repeat(index + 1)}`}`;
        return add(designCodeRoom(id, label, project, run, sizes));
      });
    });
    return { project, rooms };
  });

  const loungeGroups = world.colleagues.length <= 24 ? 2 : world.colleagues.length <= 60 ? 3 : 4;
  const review = colleaguesIn("review");
  const back = [
    add(designDispatch(colleaguesIn("release"), sizes)),
    add(designLibrary(colleaguesIn("research"), sizes)),
    ...(review.length > 0 ? [add(designReadingRoom(review))] : []),
    add(designParlour(colleaguesIn("assistants"), sizes)),
    add(designRecords(world.openTasks, sizes)),
  ];
  const front = [
    add(designPostRoom(colleaguesIn("correspondence"), sizes)),
    add(designCaseRoom(triage, colleaguesIn("triage"), world, sizes)),
    add(designLounge(loungeGroups)),
    add(designYourOffice()),
    add(designLobby(directory)),
  ];
  return {
    request: {
      code,
      back,
      front,
      connections: [
        { between: ["post-room", "case-room"], at: 0.72 },
        ...(review.length > 0 ? [{ between: ["library", "reading-room"] as const, at: 0.7 }] : []),
      ],
    },
    designs,
  };
}

/** Designs a code room: desks in rows facing the camera, a plant by the far wall, a lamp. */
function designCodeRoom(
  id: string,
  label: string,
  project: ProjectKey,
  colleagues: ReadonlyArray<Colleague>,
  sizes: KitSizes,
): RoomDesign {
  const grid = planDeskGrid(colleagues.length, 3, sizes.desk);
  // A metre each side for the aisles, and a strip on the east for a plant and a lamp.
  const dressing = 0.95;
  return {
    request: requestRoom(id, label, "code", project, grid.width + 2.0 + dressing, grid.depth + 2.4),
    furnish(room, fitter, fittings) {
      const inside = insideWalls(room.rect);
      const centreX = (inside.minX + inside.maxX - dressing) / 2;
      const centreZ = (inside.minZ + inside.maxZ) / 2;
      seatAtDesks(colleagues, grid, centreX, centreZ, id, sizes, fitter, fittings);
      // The far wall is the one away from the corridor: the window wall in the north row.
      const farZ = room.doorSide === "south" ? inside.minZ : inside.maxZ;
      const nearZ = room.doorSide === "south" ? inside.maxZ : inside.minZ;
      const towardNear = Math.sign(nearZ - farZ);
      fitter.place(buildPlant("tall"), inside.maxX - 0.42, farZ + towardNear * 0.42);
      // No wall clock here: the far wall of a north-row room is an outside wall, and the kit
      // places the windows on it, so a clock could land on a window.
      fitter.placeLamp(inside.maxX - 0.35, nearZ - towardNear * 0.9);
    },
  };
}

/** Designs Dispatch: the release desks, and parcels stacked along the back wall. */
function designDispatch(colleagues: ReadonlyArray<Colleague>, sizes: KitSizes): RoomDesign {
  const grid = planDeskGrid(colleagues.length, decideColumnLimit(colleagues.length), sizes.desk);
  return {
    request: requestRoom(
      "dispatch",
      "Dispatch",
      "dispatch",
      null,
      grid.width + 2.4,
      grid.depth + 3.0,
    ),
    furnish(room, fitter, fittings) {
      const inside = insideWalls(room.rect);
      seatAtDesks(
        colleagues,
        grid,
        (inside.minX + inside.maxX) / 2,
        (inside.minZ + 1.2 + inside.maxZ) / 2,
        "dispatch",
        sizes,
        fitter,
        fittings,
      );
      fitter.place(buildParcels(), inside.minX + 0.55, inside.minZ + 0.4);
      fitter.place(buildParcels(), inside.minX + 1.35, inside.minZ + 0.4, 0.2);
      fitter.place(buildCabinet(), inside.maxX - 0.45, inside.minZ + 0.35);
      fitter.place(buildCabinet(), inside.maxX - 1.0, inside.minZ + 0.35);
      fitter.place(buildPlant("small"), inside.minX + 0.35, inside.maxZ - 0.35);
      fitter.hang(buildWallClock(), (inside.minX + inside.maxX) / 2, 1.95, inside.minZ, 0);
    },
  };
}

/** Designs the Library: shelves along the back wall, the research desks, and a reading corner. */
function designLibrary(colleagues: ReadonlyArray<Colleague>, sizes: KitSizes): RoomDesign {
  const grid = planDeskGrid(colleagues.length, decideColumnLimit(colleagues.length), sizes.desk);
  const corner = 2.9;
  return {
    request: requestRoom(
      "library",
      "The Library",
      "library",
      null,
      Math.max(grid.width + 1.8, 3.4) + corner,
      grid.depth + 3.2,
      0.3,
    ),
    furnish(room, fitter, fittings) {
      const inside = insideWalls(room.rect);
      const shelfWidth = 1.5;
      const shelves = Math.max(
        1,
        Math.floor((inside.maxX - inside.minX - 0.8) / (shelfWidth + 0.06)),
      );
      const startX = (inside.minX + inside.maxX) / 2 - ((shelves - 1) * (shelfWidth + 0.06)) / 2;
      for (let index = 0; index < shelves; index++) {
        fitter.place(
          buildBookshelf(shelfWidth),
          startX + index * (shelfWidth + 0.06),
          inside.minZ + 0.22,
        );
      }
      const deskSpan = inside.maxX - corner - inside.minX;
      seatAtDesks(
        colleagues,
        grid,
        inside.minX + deskSpan / 2,
        (inside.minZ + 1.3 + inside.maxZ) / 2,
        "library",
        sizes,
        fitter,
        fittings,
      );
      // The reading corner: two armchairs on a rug, a lamp between them.
      const cornerX = inside.maxX - corner / 2;
      const cornerZ = inside.maxZ - 1.3;
      fitter.place(buildRug(2.4, 1.9), cornerX, cornerZ, 0, true);
      for (const [dx, facing] of [
        [-0.55, 0.35],
        [0.55, -0.35],
      ] as const) {
        fitter.place(buildArmchair().object, cornerX + dx, cornerZ - 0.2, facing);
      }
      fitter.placeLamp(cornerX, cornerZ - 0.55);
      fitter.place(buildPlant("tall"), inside.maxX - 0.4, inside.maxZ - 0.4);
    },
  };
}

/**
 * Designs the Reading Room: long tables for the review work, which carry
 * their own reading lamps, a palm in one corner and a standard lamp in the
 * other. The tables' ends stay clear, so a reader can get up from an end seat.
 */
function designReadingRoom(colleagues: ReadonlyArray<Colleague>): RoomDesign {
  const perSide = 4;
  const tables = Math.ceil(colleagues.length / (perSide * 2));
  const table = measureFootprint(buildLongTable(perSide).object, 0);
  const pitch = table.depth + 1.0;
  return {
    request: requestRoom(
      "reading-room",
      "The Reading Room",
      "reading-room",
      null,
      table.width + 2.8,
      tables * pitch + 1.6,
      0.6,
    ),
    furnish(room, fitter, fittings) {
      const inside = insideWalls(room.rect);
      const x = (inside.minX + inside.maxX) / 2;
      const top = (inside.minZ + inside.maxZ) / 2 - ((tables - 1) * pitch) / 2;
      const seats: Seat[] = [];
      for (let index = 0; index < tables; index++) {
        const z = top + index * pitch;
        const longTable = buildLongTable(perSide);
        fitter.place(longTable.object, x, z);
        // The north side first: its readers face south, toward the camera.
        const markers = [
          ...longTable.seatMarkers.slice(perSide),
          ...longTable.seatMarkers.slice(0, perSide),
        ];
        for (const marker of markers) {
          seats.push({
            ...fitter.readSpot(marker),
            kind: "desk",
            roomId: "reading-room",
            desk: null,
          });
        }
      }
      colleagues.forEach((colleague, index) => {
        const seat = seats[index];
        if (seat !== undefined) fittings.homes.set(colleague.id, seat);
      });
      fitter.place(buildPlant("tall"), inside.minX + 0.4, inside.minZ + 0.4);
      fitter.placeLamp(inside.maxX - 0.35, inside.minZ + 0.35);
      fitter.hang(buildWallClock(), x, 1.95, inside.minZ, 0);
    },
  };
}

/**
 * Designs the assistants' Parlour: a writing desk each on one long rug, and
 * an armchair each side of the door, which is in the middle of the south wall.
 */
function designParlour(colleagues: ReadonlyArray<Colleague>, sizes: KitSizes): RoomDesign {
  const grid = planDeskGrid(colleagues.length, decideColumnLimit(colleagues.length), sizes.desk);
  // Each armchair stands this far from the door's middle, so a colleague walks
  // in between them, and the lamp still fits in the corner past the east one.
  const armchairX = 1.65;
  return {
    request: requestRoom(
      "parlour",
      "The Parlour",
      "lounge",
      null,
      Math.max(grid.width + 2.2, 2 * (armchairX + 1.3)),
      grid.depth + 3.7,
    ),
    furnish(room, fitter, fittings) {
      const inside = insideWalls(room.rect);
      const x = (inside.minX + inside.maxX) / 2;
      // As in the code rooms, 1.2 metres behind the first row of chairs to
      // walk along and to stand beside them.
      const z = inside.minZ + 1.2 + grid.depth / 2;
      fitter.place(buildRug(grid.width + 0.9, grid.depth + 0.7), x, z, 0, true);
      seatAtDesks(colleagues, grid, x, z, "parlour", sizes, fitter, fittings);
      // Turned a little toward the room's middle, their backs to the door's wall.
      fitter.place(buildArmchair().object, x - armchairX, inside.maxZ - 0.62, Math.PI * 0.9);
      fitter.place(buildArmchair().object, x + armchairX, inside.maxZ - 0.62, -Math.PI * 0.9);
      fitter.place(buildPlant("tall"), inside.minX + 0.4, inside.minZ + 0.4);
      fitter.placeLamp(inside.maxX - 0.4, inside.maxZ - 0.5);
    },
  };
}

/** Designs Records: a line of filing cabinets along the back wall, one per dozen open Tasks. */
function designRecords(openTasks: number, sizes: KitSizes): RoomDesign {
  const cabinets = Math.min(12, Math.max(4, Math.ceil(openTasks / 14) + 3));
  const run = cabinets * (sizes.cabinet.width + 0.02);
  return {
    request: requestRoom("records", "Records", "records", null, run + 2.0, 4.2, 0.35),
    furnish(room, fitter, fittings) {
      const inside = insideWalls(room.rect);
      const x = (inside.minX + inside.maxX) / 2 + 0.3;
      const z = inside.minZ + sizes.cabinet.depth / 2 + 0.04;
      for (let index = 0; index < cabinets; index++) {
        fitter.place(buildCabinet(), x - run / 2 + (index + 0.5) * (sizes.cabinet.width + 0.02), z);
      }
      fittings.records = {
        position: new Vector3(x, 0, z + sizes.cabinet.depth / 2 + 0.45),
        facing: Math.PI,
        floor: 0,
      };
      // Tables to read the files at, in the floor south of the cabinets, as many rows as fit.
      const seats = Math.min(4, Math.max(2, Math.floor((inside.maxX - inside.minX - 2.4) / 1.6)));
      const table = measureFootprint(buildLongTable(seats).object, 0);
      const firstZ = z + sizes.cabinet.depth / 2 + 1.2 + table.depth / 2;
      for (
        let tableZ = firstZ;
        tableZ + table.depth / 2 <= inside.maxZ - 0.5;
        tableZ += table.depth + 1.0
      ) {
        fitter.place(buildLongTable(seats).object, x + 0.3, tableZ);
      }
      fitter.place(buildPlant("small"), inside.maxX - 0.35, inside.maxZ - 0.35);
      fitter.placeLamp(inside.minX + 0.35, inside.maxZ - 0.45);
    },
  };
}

/** Designs the Post Room: pigeonholes, the tube's mouth beside them, and the correspondence desks. */
function designPostRoom(colleagues: ReadonlyArray<Colleague>, sizes: KitSizes): RoomDesign {
  const grid = planDeskGrid(colleagues.length, decideColumnLimit(colleagues.length), sizes.desk);
  return {
    request: requestRoom(
      "post-room",
      "The Post Room",
      "post-room",
      null,
      grid.width + 2.2,
      grid.depth + 3.2,
      0.2,
    ),
    furnish(room, fitter, fittings) {
      const inside = insideWalls(room.rect);
      const pigeonholes = fitter.place(buildPigeonholes(), inside.maxX - 1.5, inside.minZ + 0.22);
      fittings.tubeStart = new Vector3(pigeonholes.maxX + 0.22, 1.0, inside.minZ + 0.16);
      seatAtDesks(
        colleagues,
        grid,
        (inside.minX + inside.maxX) / 2,
        (inside.minZ + 1.6 + inside.maxZ) / 2,
        "post-room",
        sizes,
        fitter,
        fittings,
      );
      fitter.place(buildParcels(), inside.minX + 0.5, inside.maxZ - 0.4);
      fitter.place(buildPlant("tall"), inside.maxX - 0.4, inside.maxZ - 0.4);
    },
  };
}

/** Designs the Case Room: Triage's desk before the case board, and the triage desks. */
function designCaseRoom(
  triage: Colleague | null,
  colleagues: ReadonlyArray<Colleague>,
  world: World,
  sizes: KitSizes,
): RoomDesign {
  const grid = planDeskGrid(colleagues.length, 5, sizes.desk);
  const boardWidth = 2.2;
  const boardZone = 3.0;
  return {
    request: requestRoom(
      "case-room",
      "The Case Room",
      "case-room",
      null,
      Math.max(grid.width + 1.8, 5.4),
      boardZone + grid.depth + 1.0,
      0.86,
    ),
    furnish(room, fitter, fittings) {
      const inside = insideWalls(room.rect);
      const boardX = (inside.minX + inside.maxX) / 2 + 0.3;
      const board = buildCaseBoard(boardWidth);
      board.setCards(world.proposals.total, world.proposals.burning);
      const boardTop = new Box3().setFromObject(board.object).max.y;
      fitter.place(buildBoardStand(board.object, boardWidth, boardTop), boardX, inside.minZ + 0.3);
      fittings.board = board;
      fittings.caseBoard = fitter.readSpot(board.pinMarker);
      // Triage's own desk, west of the board, under the tube's end.
      const triageX = inside.minX + 1.1;
      if (triage !== null) {
        const desk = buildDesk();
        fitter.place(desk.object, triageX, inside.minZ + 1.75, Math.PI);
        fittings.homes.set(triage.id, {
          ...fitter.readSpot(desk.seatMarker),
          kind: "desk",
          roomId: "case-room",
          desk,
        });
        fittings.ownedDesks.push({ desk, runnerId: triage.runnerId });
      }
      fittings.tubeEnd = new Vector3(inside.minX + 0.3, 1.05, inside.minZ + 0.16);
      seatAtDesks(
        colleagues,
        grid,
        (inside.minX + inside.maxX) / 2,
        (inside.minZ + boardZone + inside.maxZ) / 2,
        "case-room",
        sizes,
        fitter,
        fittings,
      );
      fitter.place(buildPlant("tall"), inside.maxX - 0.4, inside.maxZ - 0.4);
      fitter.placeLamp(inside.minX + 0.35, inside.maxZ - 0.45);
    },
  };
}

/** Designs the Lounge: seating groups on rugs, the tea trolley, plants by the windows. */
function designLounge(groups: number): RoomDesign {
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
      "The Lounge",
      "lounge",
      null,
      cols * cellWidth + 1.2,
      rows * cellDepth + 2.3,
      0.3,
    ),
    furnish(room, fitter, fittings) {
      const inside = insideWalls(room.rect);
      const trolley = fitter.place(buildTeaTrolley(), inside.maxX - 1.0, inside.minZ + 0.32);
      fittings.tea = {
        position: new Vector3((trolley.minX + trolley.maxX) / 2, 0, trolley.maxZ + 0.42),
        facing: Math.PI,
        floor: 0,
      };
      const x = (inside.minX + inside.maxX) / 2;
      const z = (inside.minZ + 1.4 + inside.maxZ) / 2;
      for (let index = 0; index < groups; index++) {
        const col = index % cols;
        const row = Math.floor(index / cols);
        const groupX = x + (col - (cols - 1) / 2) * cellWidth;
        const groupZ = z + (row - (rows - 1) / 2) * cellDepth;
        placeSeatingGroup(groupX, groupZ, "lounge", fitter, fittings.lounge);
        // The lamp stands at the group's outer back corner, clear of the walk between groups.
        fitter.placeLamp(groupX + (col < (cols - 1) / 2 ? -1.45 : 1.45), groupZ - 0.85);
      }
      fitter.place(buildPlant("tall"), inside.minX + 0.4, inside.maxZ - 0.4);
      fitter.place(buildPlant("tall"), inside.maxX - 0.4, inside.maxZ - 0.4);
      fitter.place(buildPlant("small"), inside.minX + 0.35, inside.minZ + 0.35);
    },
  };
}

/**
 * Designs Your Office: the partner desk near the street windows, the user
 * facing north, toward the queue. The queue runs north from the visitor's
 * place at the desk, then turns east toward the door, so a newcomer joins at
 * the tail just inside it.
 */
function designYourOffice(): RoomDesign {
  return {
    request: requestRoom("your-office", "Your Office", "your-office", null, 6.6, 6.2, 0.84),
    furnish(room, fitter, fittings) {
      const inside = insideWalls(room.rect);
      const desk = buildYourDesk();
      const deskX = inside.minX + 2.2;
      const deskZ = inside.maxZ - 1.75;
      fitter.place(buildRug(3.6, 2.9), deskX, deskZ + 0.1, 0, true);
      const deskRect = fitter.place(desk.object, deskX, deskZ, Math.PI);
      fittings.yourDesk = fitter.readSpot(desk.seatMarker);
      desk.setLamp(true);

      // The queue: from the visitor's place, north, then east to the door.
      // The head stands a step clear of the desk's front edge.
      const head = new Vector3(deskX, 0, deskRect.minZ - 0.45);
      const turn = new Vector3(deskX, 0, inside.minZ + 1.25);
      const end = new Vector3(inside.maxX - 0.95, 0, inside.minZ + 1.25);
      fittings.queue.push(...layQueue([head, turn, end]));

      const sign = buildNowServing();
      fitter.place(buildSignStand(sign.object, 1.55), deskX - 1.45, deskZ - 0.55, Math.PI / 2);
      fittings.nowServing = sign;
      const bench = buildBench(3);
      fitter.place(bench.object, inside.minX + 0.3, (inside.minZ + deskZ) / 2 - 0.2, Math.PI / 2);
      fitter.place(buildPlant("tall"), inside.minX + 0.4, inside.maxZ - 0.4);
      fitter.place(buildPlant("tall"), inside.maxX - 0.4, inside.maxZ - 0.4);
      // The lamp stands at the bench's north end. Behind the desk it would
      // close off the user's chair, which is reached from the east.
      fitter.placeLamp(inside.minX + 0.35, inside.minZ + 0.4);
      fitter.hang(buildWallClock(), inside.minX, 1.95, deskZ - 0.3, Math.PI / 2);
      // A corner to sit and talk in, east of the desk, when the room is wide enough.
      const cornerWidth = inside.maxX - (deskX + 2.0);
      if (cornerWidth >= 2.6) {
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
function designLobby(directory: Object3D): RoomDesign {
  return {
    request: requestRoom("lobby", "The Lobby", "lobby", null, 5.6, 5.0),
    furnish(room, fitter, fittings) {
      const inside = insideWalls(room.rect);
      const doorX = (room.rect.minX + room.rect.maxX) / 2;
      fittings.entrance = {
        position: new Vector3(doorX, 0, inside.maxZ - 0.75),
        facing: Math.PI,
        floor: 0,
      };
      fitter.place(buildRug(2.2, 1.6), doorX, inside.maxZ - 1.0, 0, true);
      fitter.place(buildCoatStand(), doorX - 1.25, inside.maxZ - 0.35);
      fitter.place(buildPlant("tall"), inside.minX + 0.4, inside.maxZ - 0.4);
      fitter.place(buildPlant("tall"), inside.maxX - 0.4, inside.maxZ - 0.4);
      const bench = buildBench(3);
      fitter.place(
        bench.object,
        inside.maxX - 0.3,
        (inside.minZ + inside.maxZ) / 2 + 0.2,
        -Math.PI / 2,
      );
      fitter.placeLamp(inside.maxX - 0.4, inside.minZ + 0.45);
      fitter.place(
        directory,
        inside.minX + 0.25,
        (inside.minZ + inside.maxZ) / 2 + 0.3,
        Math.PI / 2,
      );
      fitter.hang(buildWallClock(), inside.maxX - 0.75, 1.95, inside.minZ, 0);
      // Two armchairs to wait in, against the west wall and facing into the room, so they keep
      // clear of the opening into the Gallery even in the narrowest Lobby.
      const waitX = inside.minX + 0.5;
      fitter.place(buildRug(1.4, 1.9), waitX + 0.2, inside.minZ + 1.25, 0, true);
      fitter.place(buildArmchair().object, waitX, inside.minZ + 0.8, Math.PI / 2);
      fitter.place(buildArmchair().object, waitX, inside.minZ + 1.7, Math.PI / 2);
    },
  };
}
