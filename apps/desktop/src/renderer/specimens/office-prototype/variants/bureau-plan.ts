/**
 * PROTOTYPE - the Bureau floor's plan: where every room and corridor sits,
 * and where the walls, doors and windows between them go. Pure arithmetic on
 * rectangles; nothing here builds a mesh.
 *
 * The storey reads, from north to south:
 *
 * - the code rooms, one row along the Arcade's north side, and a second row
 *   along its south side once the fleet is large enough to need it;
 * - the Arcade, the corridor of the code wings;
 * - the back row of meta rooms (Dispatch, the Library, the Reading Room...);
 * - the Gallery, the main corridor, from the west wall to the east wall;
 * - the front row along the street (the Post Room, the Case Room, the
 *   Lounge, Your Office), ending in the Lobby on the south-east corner.
 *
 * The East Hall runs along the east facade from the Gallery up to the
 * Arcade, so a colleague walks in through the Lobby, up the East Hall, and
 * along a corridor to its room.
 */
import type { RoomKind } from "../engine/contracts";
import type { ProjectKey } from "../world/types";

/** A rectangle on the floor, in world metres. North is -z. */
export interface Rect {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

/** The rows of the plan a room can sit in, plus the corridors. */
export type Band = "north-code" | "south-code" | "back" | "front" | "hall";

export type Side = "north" | "south" | "east" | "west";

/** A room the plan must fit: what it is, and the floor its furniture needs. */
export interface RoomRequest {
  readonly id: string;
  readonly label: string;
  readonly kind: RoomKind;
  readonly project: ProjectKey | null;
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
  /** The side its door to a corridor is on, or null for the corridors and the lobby. */
  readonly doorSide: Side | null;
}

/** A doorway in a wall: its centre along the wall's axis, in world metres, and its width. */
export interface Doorway {
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

/** A project's stretch of the code rows, west to east: its wing. */
export interface Wing {
  readonly project: ProjectKey;
  readonly minX: number;
  readonly maxX: number;
}

export interface FloorPlan {
  /** Every room and corridor. */
  readonly rooms: ReadonlyArray<PlannedRoom>;
  readonly walls: ReadonlyArray<PlannedWall>;
  readonly wings: ReadonlyArray<Wing>;
  readonly width: number;
  readonly depth: number;
  /** The front door in the Lobby's south wall: its centre's x, and its width. */
  readonly frontDoor: Doorway;
}

/** What the plan is asked to fit. */
export interface PlanRequest {
  /** The code rooms, one group per project, west to east. */
  readonly code: ReadonlyArray<{
    readonly project: ProjectKey;
    readonly rooms: ReadonlyArray<RoomRequest>;
  }>;
  /** The back row, west to east. */
  readonly back: ReadonlyArray<RoomRequest>;
  /** The front row, west to east; the last one is the Lobby, which takes the south-east corner. */
  readonly front: ReadonlyArray<RoomRequest>;
  /** Pairs of neighbouring rooms joined by a door of their own, beside their corridor doors. */
  readonly connections: ReadonlyArray<{
    readonly between: readonly [string, string];
    /** Where along the shared wall, from 0 at its north or west end to 1 at the other. */
    readonly at: number;
  }>;
}

/** The corridors' widths. Two colleagues pass each other with room to spare. */
export const ARCADE_WIDTH = 2.0;
export const GALLERY_WIDTH = 2.2;
export const EAST_HALL_WIDTH = 2.2;
/** A room's door, and the Lobby's front door. */
export const DOOR_WIDTH = 1.0;
export const FRONT_DOOR_WIDTH = 1.4;
/** The opening from the Lobby into the Gallery. */
const LOBBY_OPENING = 2.6;

/** The ids of the three corridors. */
export const HALL_IDS = { arcade: "arcade", gallery: "gallery", eastHall: "east-hall" } as const;

/** Returns the sum of the rooms' widths. */
function sumWidths(rooms: ReadonlyArray<RoomRequest>): number {
  return rooms.reduce((sum, room) => sum + room.width, 0);
}

/**
 * Splits one project's rooms into a north and a south row of about the same
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
    project: null,
    width: rect.maxX - rect.minX,
    depth: rect.maxZ - rect.minZ,
    rect,
    band: "hall",
    doorSide: null,
  };
}

/**
 * Plans the storey: decides whether the code rooms need one row or two,
 * stretches every row to the building's width, and places the corridors.
 * One row is kept while it stretches no row much more than two rows would.
 */
export function planFloor(request: PlanRequest): FloorPlan {
  const backWidth = sumWidths(request.back);
  const frontWidth = sumWidths(request.front) - EAST_HALL_WIDTH;
  const groups = request.code.map((group) => ({
    project: group.project,
    rooms: group.rooms,
    ...splitIntoRows(group.rooms),
  }));
  const singleWidth = groups.reduce((sum, group) => sum + sumWidths(group.rooms), 0);
  const doubleWidth = groups.reduce(
    (sum, group) => sum + Math.max(sumWidths(group.north), sumWidths(group.south)),
    0,
  );
  const decideStretch = (codeWidth: number): number => {
    const inner = Math.max(codeWidth, backWidth, frontWidth);
    return inner / Math.min(codeWidth, backWidth, frontWidth);
  };
  const double = decideStretch(doubleWidth) < decideStretch(singleWidth) * 0.85;
  const codeWidth = double ? doubleWidth : singleWidth;
  const innerWidth = Math.max(codeWidth, backWidth, frontWidth);
  const width = innerWidth + EAST_HALL_WIDTH;

  const maxDepth = (rooms: ReadonlyArray<RoomRequest>): number =>
    rooms.reduce((depth, room) => Math.max(depth, room.depth), 0);
  const northRooms = groups.flatMap((group) => (double ? group.north : group.rooms));
  const southRooms = double ? groups.flatMap((group) => group.south) : [];
  const northDepth = maxDepth(northRooms);
  const southDepth = maxDepth(southRooms);
  const backDepth = maxDepth(request.back);
  const frontDepth = maxDepth(request.front);

  const arcadeZ = northDepth;
  const southZ = arcadeZ + ARCADE_WIDTH;
  const backZ = southZ + southDepth;
  const galleryZ = backZ + backDepth;
  const frontZ = galleryZ + GALLERY_WIDTH;
  const depth = frontZ + frontDepth;

  const rooms: PlannedRoom[] = [];
  const wings: Wing[] = [];
  const codeScale = innerWidth / codeWidth;
  let x = 0;
  groups.forEach((group, index) => {
    const span = double
      ? Math.max(sumWidths(group.north), sumWidths(group.south))
      : sumWidths(group.rooms);
    const to = index === groups.length - 1 ? innerWidth : x + span * codeScale;
    rooms.push(
      ...layRow(double ? group.north : group.rooms, x, to, 0, arcadeZ, "north-code", "south"),
    );
    if (double && group.south.length > 0) {
      rooms.push(...layRow(group.south, x, to, southZ, backZ, "south-code", "north"));
    }
    wings.push({ project: group.project, minX: x, maxX: to });
    x = to;
  });
  rooms.push(...layRow(request.back, 0, innerWidth, backZ, galleryZ, "back", "south"));
  const front = layRow(request.front, 0, width, frontZ, depth, "front", "north");
  // The Lobby's door is the front door and its opening into the Gallery, not a room door.
  front[front.length - 1] = { ...front[front.length - 1]!, doorSide: null };
  rooms.push(...front);
  rooms.push(
    buildHall(HALL_IDS.arcade, "The Arcade", {
      minX: 0,
      minZ: arcadeZ,
      maxX: innerWidth,
      maxZ: southZ,
    }),
    buildHall(HALL_IDS.gallery, "The Gallery", {
      minX: 0,
      minZ: galleryZ,
      maxX: width,
      maxZ: frontZ,
    }),
    buildHall(HALL_IDS.eastHall, "The East Hall", {
      minX: innerWidth,
      minZ: 0,
      maxX: width,
      maxZ: galleryZ,
    }),
  );

  const lobby = front[front.length - 1]!;
  const frontDoor: Doorway = {
    at: (lobby.rect.minX + lobby.rect.maxX) / 2,
    width: FRONT_DOOR_WIDTH,
  };
  const walls = planWalls(rooms, request.connections, frontDoor, lobby.id);
  return { rooms, walls, wings, width, depth, frontDoor };
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
    const covering = (edges: typeof before) =>
      edges.find((edge) => edge.from <= middle && middle <= edge.to)?.room ?? null;
    const piece: WallPiece = { from, to, before: covering(before), after: covering(after) };
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

/** Returns the side of `room` that faces its neighbour across a wall piece. */
function sideOf(axis: "x" | "z", isBefore: boolean): Side {
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
  connections: PlanRequest["connections"],
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
        if (before !== null) addDoor(before, sideOf(axis, true));
        if (after !== null) addDoor(after, sideOf(axis, false));
        const lobbyAndHall =
          (before?.id === lobbyId && after?.kind === "hall") ||
          (after?.id === lobbyId && before?.kind === "hall");
        if (lobbyAndHall) {
          const opening = Math.min(LOBBY_OPENING, piece.to - piece.from - 1.2);
          doors.push({ at: (piece.from + piece.to) / 2, width: opening });
        }
        if (before?.id === lobbyId && after === null) doors.push(frontDoor);
        for (const connection of connections) {
          const ids = [before?.id, after?.id];
          if (!ids.includes(connection.between[0]) || !ids.includes(connection.between[1]))
            continue;
          doors.push({
            at: piece.from + (piece.to - piece.from) * connection.at,
            width: DOOR_WIDTH,
          });
        }
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
