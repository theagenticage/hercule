/**
 * The Bureau floor: the whole Office on one storey. Each project has a room
 * of its own, the floor inlaid in the project's tint and a plaque at the
 * door, and the threads with no project share one more. The fixed rooms of
 * the Office Map (the Triage Room, the Lounge, Your Office and the Lobby) sit
 * along the street south of the Gallery, the main corridor, and the front
 * door opens from the street into the Lobby on the south-east corner. Once
 * there are assistants, the Secretariat juts out south of Your Office, with a
 * lawn either side of it.
 *
 * The plan, the arithmetic of where each room goes, is `bureau-plan.ts`; what
 * stands in each room is `bureau-rooms.ts`; the runners' tags and the Lobby's
 * directory are `bureau-fleet.ts`. This file builds the shell (floors and
 * walls), runs the furnishing, and fills in the `BuiltOffice` contract.
 */
import { Box3, Group, Vector3, type Object3D } from "three";
import {
  CUTAWAY,
  WALL_HEIGHT,
  type BuildOffice,
  type CameraView,
  type Cutaway,
  type BuiltOffice,
  type RoomInfo,
  type Seat,
} from "../engine/contracts";
import type { Token } from "../engine/palette";
import {
  buildFloor,
  buildLamppost,
  buildLawn,
  buildPath,
  buildPlaque,
  buildWall,
  WALL_THICKNESS,
} from "../kit/architecture";
import { buildFloorLamp, buildPicnicTable, buildPlant, buildRug } from "../kit/props";
import { BUREAU_MAP } from "./office-map";
import { buildDeskTags, buildDirectory } from "./bureau-fleet";
import { HALL_IDS, planFloor, type FloorPlan, type PlannedWall, type Rect } from "./bureau-plan";
import { designRooms, measureFootprint, type Fitter, type Fittings } from "./bureau-rooms";

const HALF_WALL = WALL_THICKNESS / 2;
/** How far a lowered wall must drop before what hangs on it hides: by then the cap passes it. */
const HIDE_HUNG_AT = 0.25;
/** The camera's vertical field of view, and the widest share of the window the office may assume. */
const FIELD_OF_VIEW = 28;
const ASPECT = 1.3;
/** How much room a framed view leaves around its box, for the bars that float over the canvas. */
const FRAME_MARGIN = 1.12;
/** The pavement in front of the building, and the path across the lawn from the front door to it. */
const PAVEMENT_DEPTH = 2.4;
const FRONT_PATH_WIDTH = 1.4;
/** The most picnic tables on a lawn, and the length of lawn each one needs. */
const MAX_PICNIC_TABLES = 3;
const PICNIC_PITCH = 3.4;
/** A built wall, with the ornaments hung on it, which hide while it is lowered. */
interface BuiltWall {
  readonly planned: PlannedWall;
  readonly hung: Object3D[];
}

export const buildBureau: BuildOffice = ({ world, nav }) => {
  const root = new Group();
  root.name = "bureau";
  const directory = buildDirectory(world);
  const { request, designs } = designRooms(world, BUREAU_MAP, directory);
  const plan = planFloor(request);

  buildFloors(plan, root);
  const walls = buildWalls(plan, root);
  const solids: Rect[] = [];
  const fitter = createFitter(root, walls, solids);
  const fittings: Fittings = {
    homes: new Map<string, Seat>(),
    armchairs: new Map<string, Seat>(),
    lounge: [],
    queue: [],
    ownedDesks: [],
    yourDesk: null,
    tea: null,
    entrance: null,
    nowServing: null,
    clock: null,
  };
  for (const room of plan.rooms) designs.get(room.id)?.furnish(room, fitter, fittings);
  dressHalls(plan, walls, fitter);
  hangPlaques(plan, walls, fitter);
  buildStreet(plan, root);
  layLawns(plan, root, fitter);

  root.updateMatrixWorld(true);
  const tags = buildDeskTags(fittings.ownedDesks, world);
  root.add(tags.object);
  // The clock's hands turn, so they stay out of the still building: moved to the dial in world
  // space here, and added to the scene by the office beside the root.
  const clock = fittings.clock;
  clock?.hands.applyMatrix4(clock.object.matrixWorld);
  fittings.nowServing?.setNumber(
    world.colleagues.filter((colleague) => colleague.pose === "waiting").length,
  );

  // Walking: the whole storey, minus the lawns and the walls, plus their doorways, minus the
  // furniture.
  nav.addFloor(0, 0, 0, 0, plan.width, plan.depth);
  for (const lawn of plan.lawns) nav.block(0, lawn.minX, lawn.minZ, lawn.maxX, lawn.maxZ);
  for (const wall of plan.walls) {
    const rect = buildWallStretchRect(wall, wall.from - HALF_WALL, wall.to + HALF_WALL, HALF_WALL);
    nav.block(0, rect.minX, rect.minZ, rect.maxX, rect.maxZ);
  }
  for (const wall of plan.walls) {
    for (const door of wall.doors) {
      const rect = buildWallStretchRect(
        wall,
        door.at - door.width / 2,
        door.at + door.width / 2,
        0.3,
      );
      nav.open(0, rect.minX, rect.minZ, rect.maxX, rect.maxZ);
    }
  }
  for (const rect of solids) nav.block(0, rect.minX, rect.minZ, rect.maxX, rect.maxZ);
  const graph = nav.build();

  const entrance = fittings.entrance ?? {
    position: new Vector3(plan.frontDoor.at, 0, plan.frontDoor.line - 0.8),
    facing: Math.PI,
    floor: 0,
  };
  // The corridors are rooms to the plan, but nobody names a corridor, so they get no label.
  const rooms: RoomInfo[] = plan.rooms
    .filter((room) => room.kind !== "hall")
    .map((room) => {
      const bounds = new Box3(
        new Vector3(room.rect.minX, 0, room.rect.minZ),
        new Vector3(room.rect.maxX, WALL_HEIGHT, room.rect.maxZ),
      );
      return {
        id: room.id,
        label: room.label,
        kind: room.kind,
        floor: 0,
        bounds,
        view: frameView(bounds, 38, 52),
        tint: room.tint,
      };
    });
  const building = new Box3(
    new Vector3(0, 0, 0),
    new Vector3(plan.width, WALL_HEIGHT, plan.depth + PAVEMENT_DEPTH),
  );
  const bounds = new Box3(
    new Vector3(-1, -0.1, -1),
    new Vector3(plan.width + 1, WALL_HEIGHT + 0.1, plan.depth + PAVEMENT_DEPTH + 0.6),
  );
  const spots = {
    yourDesk: fittings.yourDesk ?? entrance,
    queue: fittings.queue,
    lounge: fittings.lounge,
    tea: fittings.tea,
  };
  const office: BuiltOffice = {
    root,
    rooms,
    homes: fittings.homes,
    armchairs: fittings.armchairs,
    spots,
    nav: graph,
    overview: frameView(building, 34, 54),
    bounds,
    setWaitingCount(count) {
      fittings.nowServing?.setNumber(count);
    },
    ...(clock === null ? {} : { clock: { hands: clock.hands, setTime: clock.setTime } }),
    dispose() {
      tags.dispose();
    },
  };
  return office;
};

/** Returns the rectangle a stretch of a wall covers, from `from` to `to` along it, `half` either side. */
function buildWallStretchRect(wall: PlannedWall, from: number, to: number, half: number): Rect {
  return wall.axis === "x"
    ? { minX: from, minZ: wall.line - half, maxX: to, maxZ: wall.line + half }
    : { minX: wall.line - half, minZ: from, maxX: wall.line + half, maxZ: to };
}

/** Lays a floor under every room and corridor, inlaid in its project's tint. */
function buildFloors(plan: FloorPlan, root: Group): void {
  for (const room of plan.rooms) {
    const width = room.rect.maxX - room.rect.minX;
    const depth = room.rect.maxZ - room.rect.minZ;
    const inlay: Token | undefined =
      room.tint !== null
        ? (`proj-${room.tint}` as const)
        : room.kind === "hall"
          ? "room-inlay-2"
          : undefined;
    const floor = buildFloor(width, depth, inlay === undefined ? {} : { inlay });
    floor.position.set(
      (room.rect.minX + room.rect.maxX) / 2,
      0,
      (room.rect.minZ + room.rect.maxZ) / 2,
    );
    root.add(floor);
  }
}

/**
 * Builds every wall of the plan. Walls along x run through the corners, so
 * they reach half a wall past their ends unless another wall on the same
 * line carries on; walls along z stop at the faces of the walls they meet.
 * Each wall's `Cutaway` is wrapped so whatever hangs on it hides while the
 * camera lowers it.
 */
function buildWalls(plan: FloorPlan, root: Group): BuiltWall[] {
  const continues = (wall: PlannedWall, at: number): boolean =>
    plan.walls.some(
      (other) =>
        other !== wall &&
        other.axis === wall.axis &&
        Math.abs(other.line - wall.line) < 1e-3 &&
        (Math.abs(other.from - at) < 1e-3 || Math.abs(other.to - at) < 1e-3),
    );
  return plan.walls.map((planned) => {
    const start =
      planned.axis === "x"
        ? planned.from - (continues(planned, planned.from) ? 0 : HALF_WALL)
        : planned.from + HALF_WALL;
    const end =
      planned.axis === "x"
        ? planned.to + (continues(planned, planned.to) ? 0 : HALF_WALL)
        : planned.to - HALF_WALL;
    const centre = (start + end) / 2;
    // The wall's local x runs along it; these turn a world position along the line into it.
    const rotation = { south: 0, north: Math.PI, east: Math.PI / 2, west: -Math.PI / 2 }[
      planned.outward
    ];
    const convertToLocal = (at: number): number =>
      planned.outward === "south" || planned.outward === "west" ? at - centre : centre - at;
    const object = buildWall(end - start, {
      // Walls along z stand a hair lower, so two caps never lie in the same plane at a corner.
      height: planned.axis === "x" ? WALL_HEIGHT : WALL_HEIGHT - 0.004,
      doors: planned.doors.map((door) => ({ at: convertToLocal(door.at), width: door.width })),
      windows: planned.windows,
      cutaway: { roomId: planned.ownerId, exterior: planned.exterior },
    });
    object.rotation.y = rotation;
    if (planned.axis === "x") object.position.set(centre, 0, planned.line);
    else object.position.set(planned.line, 0, centre);
    root.add(object);
    const built: BuiltWall = { planned, hung: [] };
    const cutaway = object.userData[CUTAWAY] as Cutaway | undefined;
    if (cutaway !== undefined) {
      const wrapped: Cutaway = {
        roomId: cutaway.roomId,
        exterior: cutaway.exterior,
        setCut(amount) {
          cutaway.setCut(amount);
          for (const hung of built.hung) hung.visible = amount < HIDE_HUNG_AT;
        },
      };
      object.userData[CUTAWAY] = wrapped;
    }
    return built;
  });
}

/** Returns the fitter the rooms furnish through: it places, hangs, and records what blocks walking. */
function createFitter(root: Group, walls: ReadonlyArray<BuiltWall>, solids: Rect[]): Fitter {
  const fitter: Fitter = {
    place(object, x, z, facing = 0, walkable = false) {
      const footprint = measureFootprint(object, facing);
      object.position.set(x - footprint.centreX, 0, z - footprint.centreZ);
      root.add(object);
      const rect = {
        minX: x - footprint.width / 2,
        minZ: z - footprint.depth / 2,
        maxX: x + footprint.width / 2,
        maxZ: z + footprint.depth / 2,
      };
      if (!walkable) solids.push(rect);
      return rect;
    },
    hang(object, x, y, z, facing) {
      let nearest: BuiltWall | null = null;
      let distance = 0.2;
      for (const wall of walls) {
        const { axis, line, from, to } = wall.planned;
        const along = axis === "x" ? x : z;
        const across = Math.abs((axis === "x" ? z : x) - line);
        if (along < from || along > to || across >= distance) continue;
        nearest = wall;
        distance = across;
      }
      if (nearest === null) {
        console.warn(
          `Could not hang an object at (${x.toFixed(2)}, ${z.toFixed(2)}): no wall runs within 0.2 m of that point, so the object is left out of the office. Hang it on a wall's line.`,
        );
        return;
      }
      const { axis, line } = nearest.planned;
      const out = HALF_WALL + 0.002;
      if (axis === "x") object.position.set(x, y, line + Math.cos(facing) * out);
      else object.position.set(line + Math.sin(facing) * out, y, z);
      object.rotation.y = facing;
      root.add(object);
      nearest.hung.push(object);
    },
    placeLamp(x, z) {
      fitter.place(buildFloorLamp().object, x, z);
    },
    readSpot(marker) {
      marker.updateWorldMatrix(true, false);
      const position = marker.getWorldPosition(new Vector3()).setY(0);
      const direction = marker.getWorldDirection(new Vector3());
      return { position, facing: Math.atan2(direction.x, direction.z), floor: 0 };
    },
  };
  return fitter;
}

/** Returns the doorways' centres along a wall line, in world metres. */
function findDoors(walls: ReadonlyArray<BuiltWall>, axis: "x" | "z", line: number): number[] {
  return walls
    .filter((wall) => wall.planned.axis === axis && Math.abs(wall.planned.line - line) < 1e-3)
    .flatMap((wall) => wall.planned.doors.map((door) => door.at));
}

/**
 * Dresses the corridors: a long runner down the Gallery, plants along its
 * north side between the doors, and a plant at each corridor's far end.
 */
function dressHalls(plan: FloorPlan, walls: ReadonlyArray<BuiltWall>, fitter: Fitter): void {
  const gallery = plan.rooms.find((room) => room.id === HALL_IDS.gallery)!.rect;
  const arcade = plan.rooms.find((room) => room.id === HALL_IDS.arcade)?.rect;
  const eastHall = plan.rooms.find((room) => room.id === HALL_IDS.eastHall)?.rect;
  const galleryZ = (gallery.minZ + gallery.maxZ) / 2;
  fitter.place(buildRug(plan.width - 3.2, 1.0), plan.width / 2 - 0.4, galleryZ, 0, true);
  const doors = findDoors(walls, "x", gallery.minZ);
  const spacing = 7;
  for (let x = spacing / 2; x < gallery.maxX - 3; x += spacing) {
    if (doors.some((door) => Math.abs(door - x) < 1.4)) continue;
    fitter.place(buildPlant("small"), x, gallery.minZ + HALF_WALL + 0.3);
  }
  fitter.place(buildPlant("tall"), gallery.minX + 0.45, gallery.maxZ - 0.5);
  if (arcade !== undefined)
    fitter.place(buildPlant("tall"), arcade.minX + 0.45, arcade.minZ + 0.45);
  if (eastHall !== undefined) {
    fitter.place(buildPlant("tall"), eastHall.maxX - 0.45, eastHall.minZ + 0.45);
    fitter.placeLamp(eastHall.minX + 0.4, eastHall.minZ + 0.45);
  }
}

/**
 * Hangs a plaque with the room's name beside every room's door, on the side
 * the door is entered from: the corridor, or Your Office for the annex.
 */
function hangPlaques(plan: FloorPlan, walls: ReadonlyArray<BuiltWall>, fitter: Fitter): void {
  const rooms = new Map(plan.rooms.map((room) => [room.id, room]));
  for (const { planned } of walls) {
    const owner = rooms.get(planned.ownerId);
    const other = planned.otherId === null ? undefined : rooms.get(planned.otherId);
    if (owner === undefined || other === undefined) continue;
    // The owner is north or west of the wall, so its door in this wall is on its south or east side.
    const ownerHasDoor = owner.doorSide === (planned.axis === "x" ? "south" : "east");
    const otherHasDoor = other.doorSide === (planned.axis === "x" ? "north" : "west");
    if (!ownerHasDoor && !otherHasDoor) continue;
    const room = ownerHasDoor ? owner : other;
    // The plaque faces into the room the door is entered from: +z or +x when that is the other side.
    const facing = (planned.axis === "x" ? 0 : Math.PI / 2) + (ownerHasDoor ? 0 : Math.PI);
    for (const door of planned.doors) {
      let along = door.at + door.width / 2 + 0.5;
      if (along > planned.to - 0.4) along = door.at - door.width / 2 - 0.5;
      const plaque = buildPlaque(room.label);
      if (planned.axis === "x") fitter.hang(plaque, along, 1.42, planned.line, facing);
      else fitter.hang(plaque, planned.line, 1.42, along, facing);
    }
  }
}

/**
 * Lays the pavement in one straight line along the street front, a path to
 * it from the front door when a lawn lies between them, and a street lamp
 * each side of the front door.
 */
function buildStreet(plan: FloorPlan, root: Group): void {
  const pavement = buildPath(PAVEMENT_DEPTH, plan.width + 2);
  pavement.rotation.y = Math.PI / 2;
  pavement.position.set(plan.width / 2, 0, plan.depth + PAVEMENT_DEPTH / 2 + HALF_WALL);
  root.add(pavement);
  const { frontDoor } = plan;
  const pathLength = plan.depth - frontDoor.line;
  if (pathLength > 0) {
    const path = buildPath(FRONT_PATH_WIDTH, pathLength);
    path.position.set(frontDoor.at, 0, (frontDoor.line + plan.depth) / 2 + HALF_WALL);
    root.add(path);
  }
  for (const side of [-1, 1]) {
    const lamppost = buildLamppost();
    lamppost.position.set(frontDoor.at + side * 1.7, 0, frontDoor.line + 0.55);
    root.add(lamppost);
  }
}

/**
 * Lays grass over each lawn, from the building's walls to the pavement and
 * out to the pavement's ends, and stands picnic tables in a row down the
 * middle of every lawn long enough for one, apart from the lawn the front
 * path crosses.
 */
function layLawns(plan: FloorPlan, root: Group, fitter: Fitter): void {
  for (const lawn of plan.lawns) {
    // A side on the building's outer edge runs on to the pavement's end; a side against the
    // annex stops at its wall.
    const minX = lawn.minX === 0 ? -1 : lawn.minX + HALF_WALL;
    const maxX = lawn.maxX === plan.width ? plan.width + 1 : lawn.maxX - HALF_WALL;
    const grass = buildLawn(maxX - minX, lawn.maxZ - lawn.minZ);
    grass.position.set((minX + maxX) / 2, 0, (lawn.minZ + lawn.maxZ) / 2 + HALF_WALL);
    root.add(grass);
    if (lawn.minX < plan.frontDoor.at && plan.frontDoor.at < lawn.maxX) continue;
    const count = Math.min(MAX_PICNIC_TABLES, Math.floor((lawn.maxX - lawn.minX) / PICNIC_PITCH));
    const z = (lawn.minZ + lawn.maxZ) / 2 + HALF_WALL;
    for (let index = 0; index < count; index++) {
      const x = (lawn.minX + lawn.maxX) / 2 + (index - (count - 1) / 2) * PICNIC_PITCH;
      fitter.place(buildPicnicTable(), x, z);
    }
  }
}

/**
 * Returns the view that frames a box from the given angles: the camera backs
 * off until every corner of the box is inside the field of view.
 */
function frameView(box: Box3, azimuth: number, elevation: number): CameraView {
  const target = box.getCenter(new Vector3()).setY(0.4);
  const az = (azimuth * Math.PI) / 180;
  const el = (elevation * Math.PI) / 180;
  const back = new Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
  const right = new Vector3(0, 1, 0).cross(back).normalize();
  const up = back.clone().cross(right).normalize();
  const tanY = Math.tan(((FIELD_OF_VIEW / 2) * Math.PI) / 180);
  const tanX = tanY * ASPECT;
  let distance = 0;
  const corner = new Vector3();
  for (let index = 0; index < 8; index++) {
    corner.set(
      index & 1 ? box.max.x : box.min.x,
      index & 2 ? Math.min(box.max.y, 1.2) : box.min.y,
      index & 4 ? box.max.z : box.min.z,
    );
    const offset = corner.sub(target);
    const toward = offset.dot(back);
    distance = Math.max(
      distance,
      toward + Math.abs(offset.dot(right)) / tanX,
      toward + Math.abs(offset.dot(up)) / tanY,
    );
  }
  return { target, distance: distance * FRAME_MARGIN, azimuth, elevation };
}
