/**
 * The Bureau floor's plan: where every room and corridor sits, and where the
 * walls, doors and windows between them go. Pure arithmetic on rectangles;
 * nothing here builds a mesh. This is the geometry of the Office Map's
 * `gallery-wings` growth rule.
 *
 * The storey reads, from north to south:
 *
 * - the project rooms, in one row north of the Gallery, or in two rows either
 *   side of the Arcade once there are enough of them to need it;
 * - the back row, which the Bureau leaves empty;
 * - the Gallery, the main corridor, from the west wall to the east wall;
 * - the front row of fixed rooms, ending in the Lobby on the south-east
 *   corner;
 * - the annex, when there is one: a fixed room south of one front-row room,
 *   as wide as that room and entered only through it. The building is then a
 *   T, and the ground either side of the annex, between the front row and the
 *   street, is lawn.
 *
 * The East Hall runs along the east facade from the Gallery up to the
 * project rooms, so a colleague walks in through the Lobby, up the East
 * Hall, and along a corridor to its room.
 */
import type { RoomKind } from "../engine/contracts";
import type { ProjectTint } from "../../screens/project-tile";

/** A rectangle on the floor, in world metres. North is -z. */
export interface Rect {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

/** The rows of the plan a room can sit in, plus the corridors. */
type Band = "north-code" | "south-code" | "back" | "front" | "annex" | "hall";

export type Side = "north" | "south" | "east" | "west";

/** A room the plan must fit: what it is, and the floor its furniture needs. */
export interface RoomRequest {
  readonly id: string;
  readonly label: string;
  readonly kind: RoomKind;
  /** The project tint the floor is inlaid with, or null. */
  readonly tint: ProjectTint | null;
  /** The width (x) and depth (z) the furniture needs, before the plan stretches the room. */
  readonly width: number;
  readonly depth: number;
  /**
   * Where along its corridor side the door sits, from 0 at the west end to 1
   * at the east end. Default 0.5.
   */
  readonly doorAt?: number;
}

/** A room or corridor with its place on the floor. */
export interface PlannedRoom extends RoomRequest {
  readonly rect: Rect;
  readonly band: Band;
  /**
   * The side its door is on, or null for the corridors and the lobby. The
   * door opens onto a corridor, or for the annex onto the room north of it.
   */
  readonly doorSide: Side | null;
}

/** A doorway in a wall: its centre along the wall's axis, in world metres, and its width. */
interface Doorway {
  readonly at: number;
  readonly width: number;
}

/** One straight wall between two rooms, or between a room and the street. */
export interface PlannedWall {
  /** "x" for a wall running east-west at z = `line`; "z" for one running north-south at x = `line`. */
  readonly axis: "x" | "z";
  readonly line: number;
  readonly from: number;
  readonly to: number;
  /** The room the wall hides from the default south-east camera: the camera lowers it for that room. */
  readonly ownerId: string;
  /** The room on the wall's other side, or null for an outer wall. */
  readonly otherId: string | null;
  readonly exterior: boolean;
  /** The way the wall's outward side, out of its owner, points. */
  readonly outward: Side;
  readonly doors: ReadonlyArray<Doorway>;
  readonly windows: boolean;
}

/** The front door: a doorway in the Lobby's south wall, which runs along x at z = `line`. */
interface FrontDoor extends Doorway {
  readonly line: number;
}

export interface FloorPlan {
  /** Every room and corridor. */
  readonly rooms: ReadonlyArray<PlannedRoom>;
  readonly walls: ReadonlyArray<PlannedWall>;
  /** The size of the rectangle round the building, from its north-west corner at the origin. */
  readonly width: number;
  readonly depth: number;
  /** The ground inside that rectangle that no room covers: either side of the annex. */
  readonly lawns: ReadonlyArray<Rect>;
  readonly frontDoor: FrontDoor;
}

/** What the plan is asked to fit. */
export interface PlanRequest {
  /** The project rooms, west to east. */
  readonly code: ReadonlyArray<RoomRequest>;
  /** The back row, west to east. */
  readonly back: ReadonlyArray<RoomRequest>;
  /** The front row, west to east; the last one is the Lobby, which takes the south-east corner. */
  readonly front: ReadonlyArray<RoomRequest>;
  /**
   * The room south of the front-row room whose id is `southOf`, or null. Its
   * door is in its north wall, at its `doorAt`. The front-row room widens to
   * the annex's width when the annex needs more. `planFloor` fails when no
   * front-row room has that id.
   */
  readonly annex: { readonly room: RoomRequest; readonly southOf: string } | null;
}

/** The corridors' widths. Two colleagues pass each other with room to spare. */
const ARCADE_WIDTH = 2.0;
const GALLERY_WIDTH = 2.2;
const EAST_HALL_WIDTH = 2.2;
/** A room's door, and the Lobby's front door. */
const DOOR_WIDTH = 1.0;
const FRONT_DOOR_WIDTH = 1.4;
/** The opening from the Lobby into the Gallery. */
const LOBBY_OPENING = 2.6;

/** The ids of the three corridors. */
export const HALL_IDS = { arcade: "arcade", gallery: "gallery", eastHall: "east-hall" } as const;

/** Returns the sum of the rooms' widths. */
function sumWidths(rooms: ReadonlyArray<RoomRequest>): number {
  return rooms.reduce((sum, room) => sum + room.width, 0);
}

/**
 * Splits the project rooms into a north and a south row of about the same
 * width: the widest room goes first, each into the row that is narrower so
 * far. Each row keeps the rooms' original order.
 */
function splitIntoRows(rooms: ReadonlyArray<RoomRequest>): {
  readonly north: ReadonlyArray<RoomRequest>;
  readonly south: ReadonlyArray<RoomRequest>;
} {
  const north = new Set<RoomRequest>();
  let northWidth = 0;
  let southWidth = 0;
  for (const room of [...rooms].sort((a, b) => b.width - a.width)) {
    if (northWidth <= southWidth) {
      north.add(room);
      northWidth += room.width;
    } else southWidth += room.width;
  }
  return {
    north: rooms.filter((room) => north.has(room)),
    south: rooms.filter((room) => !north.has(room)),
  };
}

/**
 * Lays rooms west to east across [minX, maxX], each stretched by the same
 * factor so the row fills the span exactly.
 */
function layRow(
  rooms: ReadonlyArray<RoomRequest>,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  band: Band,
  doorSide: Side | null,
): PlannedRoom[] {
  const scale = (maxX - minX) / Math.max(sumWidths(rooms), 0.001);
  let x = minX;
  return rooms.map((room, index) => {
    const to = index === rooms.length - 1 ? maxX : x + room.width * scale;
    const planned: PlannedRoom = {
      ...room,
      rect: { minX: x, minZ, maxX: to, maxZ },
      band,
      doorSide,
    };
    x = to;
    return planned;
  });
}

/** Returns a corridor as a planned room. */
function buildHall(id: string, label: string, rect: Rect): PlannedRoom {
  return {
    id,
    label,
    kind: "hall",
    tint: null,
    width: rect.maxX - rect.minX,
    depth: rect.maxZ - rect.minZ,
    rect,
    band: "hall",
    doorSide: null,
  };
}

/**
 * Plans the storey: decides whether the project rooms need one row or two,
 * stretches every row to the building's width, and places the corridors.
 * One row is kept while it stretches no row much more than two rows would.
 *
 * The Arcade runs between two rows of project rooms; with one row, its rooms
 * open straight onto the Gallery. An empty row takes no floor, and the plan
 * still holds the Gallery and the front row when there are no project rooms.
 * The annex grows the building south, so a deeper annex never widens it.
 *
 * Throws an Error when the annex names a room that is not in the front row.
 */
export function planFloor(request: PlanRequest): FloorPlan {
  const { annex } = request;
  if (annex !== null && !request.front.some((room) => room.id === annex.southOf)) {
    const ids = request.front.map((room) => room.id).join(", ");
    throw new Error(
      `The annex "${annex.room.id}" is set to stand south of "${annex.southOf}", but the front row has no room with that id (it has: ${ids}). Set the annex's southOf to the id of a front-row room.`,
    );
  }
  const frontRequests = request.front.map((room) =>
    room.id === annex?.southOf ? { ...room, width: Math.max(room.width, annex.room.width) } : room,
  );
  const backWidth = sumWidths(request.back);
  const frontWidth = sumWidths(frontRequests) - EAST_HALL_WIDTH;
  const rows = splitIntoRows(request.code);
  const singleWidth = sumWidths(request.code);
  const doubleWidth = Math.max(sumWidths(rows.north), sumWidths(rows.south));
  // How much the widest row stretches the narrowest one that holds any room.
  const decideStretch = (codeWidth: number): number => {
    const widths = [codeWidth, backWidth, frontWidth].filter((width) => width > 0);
    return Math.max(...widths) / Math.min(...widths);
  };
  const double =
    request.code.length > 1 && decideStretch(doubleWidth) < decideStretch(singleWidth) * 0.85;
  const codeWidth = double ? doubleWidth : singleWidth;
  const innerWidth = Math.max(codeWidth, backWidth, frontWidth);
  const width = innerWidth + EAST_HALL_WIDTH;

  const measureMaxDepth = (rooms: ReadonlyArray<RoomRequest>): number =>
    rooms.reduce((depth, room) => Math.max(depth, room.depth), 0);
  const northRooms = double ? rows.north : request.code;
  const southRooms = double ? rows.south : [];
  const northDepth = measureMaxDepth(northRooms);
  const southDepth = measureMaxDepth(southRooms);
  const backDepth = measureMaxDepth(request.back);
  const frontDepth = measureMaxDepth(frontRequests);

  const arcadeZ = northDepth;
  const southZ = arcadeZ + (double ? ARCADE_WIDTH : 0);
  const backZ = southZ + southDepth;
  const galleryZ = backZ + backDepth;
  const frontZ = galleryZ + GALLERY_WIDTH;
  const streetZ = frontZ + frontDepth;
  const depth = streetZ + (annex?.room.depth ?? 0);

  const rooms: PlannedRoom[] = [];
  rooms.push(...layRow(northRooms, 0, innerWidth, 0, arcadeZ, "north-code", "south"));
  if (double) {
    rooms.push(...layRow(southRooms, 0, innerWidth, southZ, backZ, "south-code", "north"));
    rooms.push(
      buildHall(HALL_IDS.arcade, "The Arcade", {
        minX: 0,
        minZ: arcadeZ,
        maxX: innerWidth,
        maxZ: southZ,
      }),
    );
  }
  rooms.push(...layRow(request.back, 0, innerWidth, backZ, galleryZ, "back", "south"));
  const front = layRow(frontRequests, 0, width, frontZ, streetZ, "front", "north");
  // The Lobby's door is the front door and its opening into the Gallery, not a room door.
  front[front.length - 1] = { ...front[front.length - 1]!, doorSide: null };
  rooms.push(...front);
  rooms.push(
    buildHall(HALL_IDS.gallery, "The Gallery", {
      minX: 0,
      minZ: galleryZ,
      maxX: width,
      maxZ: frontZ,
    }),
  );
  if (galleryZ > 0) {
    rooms.push(
      buildHall(HALL_IDS.eastHall, "The East Hall", {
        minX: innerWidth,
        minZ: 0,
        maxX: width,
        maxZ: galleryZ,
      }),
    );
  }

  const lawns: Rect[] = [];
  if (annex !== null) {
    const { minX, maxX } = front.find((room) => room.id === annex.southOf)!.rect;
    rooms.push({
      ...annex.room,
      rect: { minX, minZ: streetZ, maxX, maxZ: depth },
      band: "annex",
      doorSide: "north",
    });
    if (minX > 0) lawns.push({ minX: 0, minZ: streetZ, maxX: minX, maxZ: depth });
    if (maxX < width) lawns.push({ minX: maxX, minZ: streetZ, maxX: width, maxZ: depth });
  }

  const lobby = front[front.length - 1]!;
  const frontDoor: FrontDoor = {
    at: (lobby.rect.minX + lobby.rect.maxX) / 2,
    width: FRONT_DOOR_WIDTH,
    line: lobby.rect.maxZ,
  };
  const walls = planWalls(rooms, frontDoor, lobby.id);
  return { rooms, walls, width, depth, lawns, frontDoor };
}

/** One piece of a wall line between two breakpoints, with the rooms on either side. */
interface WallPiece {
  readonly from: number;
  readonly to: number;
  /** The room north of an east-west line, or west of a north-south one. */
  readonly before: PlannedRoom | null;
  /** The room south of an east-west line, or east of a north-south one. */
  readonly after: PlannedRoom | null;
}

const EPSILON = 0.001;

/** Returns the rooms whose edge lies on a line, with the span they cover along it. */
function findEdges(
  rooms: ReadonlyArray<PlannedRoom>,
  axis: "x" | "z",
  line: number,
  edge: "min" | "max",
): Array<{ readonly room: PlannedRoom; readonly from: number; readonly to: number }> {
  return rooms.flatMap((room) => {
    const { rect } = room;
    const value =
      axis === "x"
        ? edge === "max"
          ? rect.maxZ
          : rect.minZ
        : edge === "max"
          ? rect.maxX
          : rect.minX;
    if (Math.abs(value - line) > EPSILON) return [];
    return axis === "x"
      ? [{ room, from: rect.minX, to: rect.maxX }]
      : [{ room, from: rect.minZ, to: rect.maxZ }];
  });
}

/**
 * Cuts one wall line into pieces at every room corner on it, and returns
 * each piece with the rooms on its two sides. Neighbouring pieces with the
 * same two rooms are merged.
 */
function cutLine(rooms: ReadonlyArray<PlannedRoom>, axis: "x" | "z", line: number): WallPiece[] {
  const before = findEdges(rooms, axis, line, "max");
  const after = findEdges(rooms, axis, line, "min");
  const breaks = [...new Set([...before, ...after].flatMap((edge) => [edge.from, edge.to]))].sort(
    (a, b) => a - b,
  );
  const pieces: WallPiece[] = [];
  for (let index = 0; index < breaks.length - 1; index++) {
    const from = breaks[index]!;
    const to = breaks[index + 1]!;
    if (to - from < EPSILON) continue;
    const middle = (from + to) / 2;
    const findCoveringRoom = (edges: typeof before) =>
      edges.find((edge) => edge.from <= middle && middle <= edge.to)?.room ?? null;
    const piece: WallPiece = {
      from,
      to,
      before: findCoveringRoom(before),
      after: findCoveringRoom(after),
    };
    if (piece.before === null && piece.after === null) continue;
    const last = pieces[pieces.length - 1];
    if (
      last !== undefined &&
      Math.abs(last.to - from) < EPSILON &&
      last.before === piece.before &&
      last.after === piece.after
    ) {
      pieces[pieces.length - 1] = { ...last, to };
    } else pieces.push(piece);
  }
  return pieces;
}

/**
 * Returns the side of a room that faces a wall piece running along `axis`:
 * south or east for the room before the piece (`isBefore`), north or west for
 * the room after it.
 */
function decideNeighbourSide(axis: "x" | "z", isBefore: boolean): Side {
  if (axis === "x") return isBefore ? "south" : "north";
  return isBefore ? "east" : "west";
}

/**
 * Returns every wall of the plan, with its doors and windows. A wall between
 * two corridors is left out: the corridors run into each other. A wall
 * belongs to the room north or west of it, the one it hides from a camera
 * in the south-east; an outer wall belongs to the room inside it.
 */
function planWalls(
  rooms: ReadonlyArray<PlannedRoom>,
  frontDoor: Doorway,
  lobbyId: string,
): PlannedWall[] {
  const walls: PlannedWall[] = [];
  const lines = {
    x: [...new Set(rooms.flatMap((room) => [room.rect.minZ, room.rect.maxZ]))],
    z: [...new Set(rooms.flatMap((room) => [room.rect.minX, room.rect.maxX]))],
  };
  for (const axis of ["x", "z"] as const) {
    for (const line of lines[axis]) {
      for (const piece of cutLine(rooms, axis, line)) {
        const { before, after } = piece;
        if (before?.kind === "hall" && after?.kind === "hall") continue;
        const owner = (before ?? after)!;
        const other = before === null ? null : after;
        const exterior = before === null || after === null;
        const outward: Side =
          axis === "x" ? (before === null ? "north" : "south") : before === null ? "west" : "east";
        const doors: Doorway[] = [];
        const addDoor = (room: PlannedRoom, side: Side): void => {
          if (room.doorSide !== side) return;
          const span =
            axis === "x" ? [room.rect.minX, room.rect.maxX] : [room.rect.minZ, room.rect.maxZ];
          const at = span[0]! + (span[1]! - span[0]!) * (room.doorAt ?? 0.5);
          const clamped = Math.min(
            Math.max(at, piece.from + DOOR_WIDTH / 2 + 0.2),
            piece.to - DOOR_WIDTH / 2 - 0.2,
          );
          doors.push({ at: clamped, width: DOOR_WIDTH });
        };
        if (before !== null) addDoor(before, decideNeighbourSide(axis, true));
        if (after !== null) addDoor(after, decideNeighbourSide(axis, false));
        const lobbyAndHall =
          (before?.id === lobbyId && after?.kind === "hall") ||
          (after?.id === lobbyId && before?.kind === "hall");
        if (lobbyAndHall) {
          const opening = Math.min(LOBBY_OPENING, piece.to - piece.from - 1.2);
          doors.push({ at: (piece.from + piece.to) / 2, width: opening });
        }
        // The front door belongs in the lobby's south wall, the front of the
        // building, and in none of the lobby's other outer walls.
        const lobbyFront = axis === "x" && before?.id === lobbyId && after === null;
        if (lobbyFront) doors.push({ at: frontDoor.at, width: frontDoor.width });
        walls.push({
          axis,
          line,
          from: piece.from,
          to: piece.to,
          ownerId: owner.id,
          otherId: other?.id ?? null,
          exterior,
          outward,
          doors,
          windows: exterior && piece.to - piece.from > 1.6,
        });
      }
    }
  }
  return walls;
}
