/**
 * PROTOTYPE - variant A, the Bureau floor: the whole office on one storey,
 * organised by area of the code base. Each area has a room of its own,
 * grouped into wings by project, the floor inlaid in the project's colour and
 * a plaque at the door. The meta rooms (Your Office, the Case Room, the Post
 * Room, the Library...) sit along the Gallery, the main corridor, and the
 * front door opens from the street into the Lobby on the south-east corner.
 *
 * The plan, the arithmetic of where each room goes, is `bureau-plan.ts`; what
 * stands in each room is `bureau-rooms.ts`; the runners' tags and the Lobby's
 * directory are `bureau-fleet.ts`. This file builds the shell (floors and
 * walls), runs the furnishing, and fills in the layout contract.
 */
import { Box3, Group, Vector3, type Object3D } from "three";
import {
  CUTAWAY,
  LAMP,
  WALL_HEIGHT,
  type BuildOfficeLayout,
  type CameraView,
  type Cutaway,
  type NavGraph,
  type OfficeLayout,
  type RoomInfo,
  type Seat,
  type Spot,
  type Waypoint,
} from "../engine/contracts";
import { isOfficeNavGraph, type OfficeNavGraph } from "../engine/nav";
import type { Token } from "../engine/palette";
import {
  buildFloor,
  buildLamppost,
  buildPath,
  buildPlaque,
  buildTubes,
  buildWall,
  WALL_THICKNESS,
  type TubeHandle,
} from "../kit/architecture";
import { buildFloorLamp, buildPlant, buildRug } from "../kit/props";
import type { ProjectKey, World } from "../world/types";
import { buildDeskTags, buildDirectory } from "./bureau-fleet";
import { HALL_IDS, planFloor, type FloorPlan, type PlannedWall, type Rect } from "./bureau-plan";
import { designRooms, measureFootprint, type Fitter, type Fittings } from "./bureau-rooms";

/** The inlay each project's rooms are floored with. */
const PROJECT_INLAY: Readonly<Record<ProjectKey, Token>> = {
  webshop: "proj-webshop",
  "payments-api": "proj-payments",
  ops: "proj-ops",
};

const HALF_WALL = WALL_THICKNESS / 2;
/** How far a lowered wall must drop before what hangs on it hides: by then the cap passes it. */
const HIDE_HUNG_AT = 0.25;
/** The camera's vertical field of view, and the widest share of the window the office may assume. */
const FIELD_OF_VIEW = 28;
const ASPECT = 1.3;
/** How much room a framed view leaves around its box, for the bars that float over the canvas. */
const FRAME_MARGIN = 1.12;
/** The height the pneumatic tube runs at, over the doorways. */
const TUBE_RUN_HEIGHT = 2.08;
/** The pavement in front of the building. */
const PAVEMENT_DEPTH = 2.4;
/**
 * How far the sim slides a colleague onto a seat at the end of a walk, in
 * metres: `MAX_GLIDE` in `engine/sim.ts`. The walking check leaves this last
 * stretch out.
 */
const SEAT_SLIDE = 1.0;
/**
 * Where the sim stands a colleague beside a seat, as (sideways, forward)
 * metres in the seat's own frame, best tier first. This is a copy of
 * `BESIDE_SEAT` in `engine/sim.ts`, which keeps its table private; the walking
 * check reads it, so the two must change together.
 */
const BESIDE_SEAT: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [
    [0.85, 0.15],
    [-0.85, 0.15],
  ],
  [
    [1.0, -0.15],
    [-1.0, -0.15],
  ],
  [
    [0.75, -0.5],
    [-0.75, -0.5],
  ],
  [[0, -0.75]],
  [
    [1.25, 0],
    [-1.25, 0],
  ],
  [[0, -1.1]],
];

/** A built wall, with the ornaments hung on it, which hide while it is lowered. */
interface BuiltWall {
  readonly planned: PlannedWall;
  readonly hung: Object3D[];
}

export const buildBureau: BuildOfficeLayout = ({ world, nav }) => {
  const root = new Group();
  root.name = "bureau";
  const directory = buildDirectory(world);
  const { request, designs } = designRooms(world, directory);
  const plan = planFloor(request);

  buildFloors(plan, root);
  const walls = buildWalls(plan, root);
  const solids: Rect[] = [];
  const fitter = createFitter(root, walls, solids);
  const fittings: Fittings = {
    homes: new Map<string, Seat>(),
    lounge: [],
    queue: [],
    ownedDesks: [],
    yourDesk: null,
    caseBoard: null,
    records: null,
    tea: null,
    entrance: null,
    board: null,
    nowServing: null,
    tubeStart: null,
    tubeEnd: null,
  };
  for (const room of plan.rooms) designs.get(room.id)?.furnish(room, fitter, fittings);
  dressHalls(plan, walls, fitter);
  hangPlaques(plan, walls, fitter);
  buildStreet(plan, root);
  const tubes = buildTubeLine(fittings, root);

  root.updateMatrixWorld(true);
  const tags = buildDeskTags(fittings.ownedDesks, world);
  root.add(tags.object);
  fittings.nowServing?.setNumber(
    world.colleagues.filter((colleague) => colleague.pose === "waiting").length,
  );

  // Walking: the whole storey, minus the walls, plus their doorways, minus the furniture.
  nav.addFloor(0, 0, 0, 0, plan.width, plan.depth);
  for (const wall of plan.walls) {
    const rect = spanRect(wall, wall.from - HALF_WALL, wall.to + HALF_WALL, HALF_WALL);
    nav.block(0, rect.minX, rect.minZ, rect.maxX, rect.maxZ);
  }
  for (const wall of plan.walls) {
    for (const door of wall.doors) {
      const rect = spanRect(wall, door.at - door.width / 2, door.at + door.width / 2, 0.3);
      nav.open(0, rect.minX, rect.minZ, rect.maxX, rect.maxZ);
    }
  }
  for (const rect of solids) nav.block(0, rect.minX, rect.minZ, rect.maxX, rect.maxZ);
  const graph = nav.build();

  const entrance = fittings.entrance ?? {
    position: new Vector3(plan.frontDoor.at, 0, plan.depth - 0.8),
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
        project: room.project,
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
    caseBoard: fittings.caseBoard,
    records: fittings.records,
    entrance,
    tea: fittings.tea,
  };
  checkWalking(world, graph, fittings.homes, spots);

  let proposals = world.proposals.total;
  const layout: OfficeLayout = {
    root,
    rooms,
    homes: fittings.homes,
    spots,
    nav: graph,
    overview: frameView(building, 34, 54),
    bounds,
    update: (frame) => tubes?.update(frame) ?? false,
    sendCapsule() {
      if (tubes === null) return 0;
      tubes.send();
      return tubes.rideSeconds;
    },
    setFlow(on) {
      // Hiding the tube leaves its capsules riding, so a capsule sent while it
      // is hidden still arrives on time.
      if (tubes !== null) tubes.object.visible = on;
    },
    pinProposal() {
      proposals += 1;
      fittings.board?.setCards(proposals, world.proposals.burning);
    },
    dispose() {
      tags.dispose();
    },
  };
  return layout;
};

/** Returns the rectangle a stretch of a wall covers, from `from` to `to` along it, `half` either side. */
function spanRect(wall: PlannedWall, from: number, to: number, half: number): Rect {
  return wall.axis === "x"
    ? { minX: from, minZ: wall.line - half, maxX: to, maxZ: wall.line + half }
    : { minX: wall.line - half, minZ: from, maxX: wall.line + half, maxZ: to };
}

/** Lays a floor under every room and corridor, inlaid in its project's colour. */
function buildFloors(plan: FloorPlan, root: Group): void {
  for (const room of plan.rooms) {
    const width = room.rect.maxX - room.rect.minX;
    const depth = room.rect.maxZ - room.rect.minZ;
    const inlay: Token | undefined =
      room.project !== null
        ? PROJECT_INLAY[room.project]
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
    const toLocal = (at: number): number =>
      planned.outward === "south" || planned.outward === "west" ? at - centre : centre - at;
    const object = buildWall(end - start, {
      // Walls along z stand a hair lower, so two caps never lie in the same plane at a corner.
      height: planned.axis === "x" ? WALL_HEIGHT : WALL_HEIGHT - 0.004,
      doors: planned.doors.map((door) => ({ at: toLocal(door.at), width: door.width })),
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
        console.warn(`[bureau] nothing to hang on at (${x.toFixed(2)}, ${z.toFixed(2)})`);
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
      const lamp = buildFloorLamp();
      if (lamp.object.userData[LAMP] === undefined) {
        lamp.object.userData[LAMP] = { setOn: (on: boolean) => lamp.setOn(on) };
      }
      fitter.place(lamp.object, x, z);
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
  const arcade = plan.rooms.find((room) => room.id === HALL_IDS.arcade)!.rect;
  const eastHall = plan.rooms.find((room) => room.id === HALL_IDS.eastHall)!.rect;
  const galleryZ = (gallery.minZ + gallery.maxZ) / 2;
  fitter.place(buildRug(plan.width - 3.2, 1.0), plan.width / 2 - 0.4, galleryZ, 0, true);
  const doors = findDoors(walls, "x", gallery.minZ);
  const spacing = 7;
  for (let x = spacing / 2; x < gallery.maxX - 3; x += spacing) {
    if (doors.some((door) => Math.abs(door - x) < 1.4)) continue;
    fitter.place(buildPlant("small"), x, gallery.minZ + HALF_WALL + 0.3);
  }
  fitter.place(buildPlant("tall"), gallery.minX + 0.45, gallery.maxZ - 0.5);
  fitter.place(buildPlant("tall"), arcade.minX + 0.45, arcade.minZ + 0.45);
  fitter.place(buildPlant("tall"), eastHall.maxX - 0.45, eastHall.minZ + 0.45);
  fitter.placeLamp(eastHall.minX + 0.4, eastHall.minZ + 0.45);
}

/** Hangs a plaque with the room's name beside every door from a corridor into a room. */
function hangPlaques(plan: FloorPlan, walls: ReadonlyArray<BuiltWall>, fitter: Fitter): void {
  const rooms = new Map(plan.rooms.map((room) => [room.id, room]));
  for (const { planned } of walls) {
    const owner = rooms.get(planned.ownerId);
    const other = planned.otherId === null ? undefined : rooms.get(planned.otherId);
    if (owner === undefined || other === undefined) continue;
    const hallIsOther = other.kind === "hall" && owner.kind !== "hall";
    const hallIsOwner = owner.kind === "hall" && other.kind !== "hall";
    if (!hallIsOther && !hallIsOwner) continue;
    const room = hallIsOther ? owner : other;
    if (room.doorSide === null) continue;
    // The owner is north or west of the wall, so the corridor faces +z or +x when it is the other side.
    const facing =
      planned.axis === "x" ? (hallIsOther ? 0 : Math.PI) : hallIsOther ? Math.PI / 2 : -Math.PI / 2;
    for (const door of planned.doors) {
      let along = door.at + door.width / 2 + 0.5;
      if (along > planned.to - 0.4) along = door.at - door.width / 2 - 0.5;
      const plaque = buildPlaque(room.label);
      if (planned.axis === "x") fitter.hang(plaque, along, 1.42, planned.line, facing);
      else fitter.hang(plaque, planned.line, 1.42, along, facing);
    }
  }
}

/** Lays the pavement along the street front and a street lamp each side of the front door. */
function buildStreet(plan: FloorPlan, root: Group): void {
  const pavement = buildPath(PAVEMENT_DEPTH, plan.width + 2);
  pavement.rotation.y = Math.PI / 2;
  pavement.position.set(plan.width / 2, 0, plan.depth + PAVEMENT_DEPTH / 2 + HALF_WALL);
  root.add(pavement);
  for (const side of [-1, 1]) {
    const lamppost = buildLamppost();
    lamppost.position.set(plan.frontDoor.at + side * 1.7, 0, plan.depth + 0.55);
    root.add(lamppost);
  }
}

/**
 * Builds the pneumatic tube from its mouth in the Post Room to its end at
 * Triage's desk: up from the mouth, east along the north wall over the
 * doorways, through the wall between the two rooms, and down to the end. It
 * stands on slim posts, so it stays up when the walls are lowered.
 */
function buildTubeLine(fittings: Fittings, root: Group): TubeHandle | null {
  const { tubeStart, tubeEnd } = fittings;
  if (tubeStart === null || tubeEnd === null) return null;
  const tubes = buildTubes(
    [
      tubeStart,
      new Vector3(tubeStart.x, TUBE_RUN_HEIGHT, tubeStart.z),
      new Vector3(tubeEnd.x, TUBE_RUN_HEIGHT, tubeStart.z),
      tubeEnd,
    ],
    { posts: true },
  );
  root.add(tubes.object);
  return tubes;
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

/**
 * Returns the places where the sim stands a colleague beside a seat: the
 * walkable places of the first tier of `BESIDE_SEAT` that has any, which is
 * where the sim's `findBesideSeat` picks from. Returns an empty list when
 * furniture or walls crowd every place.
 */
function listBesideSeat(seat: Seat, graph: OfficeNavGraph): Vector3[] {
  const forwardX = Math.sin(seat.facing);
  const forwardZ = Math.cos(seat.facing);
  for (const tier of BESIDE_SEAT) {
    const places = tier
      .map(
        ([sideways, forward]) =>
          new Vector3(
            seat.position.x + forwardZ * sideways + forwardX * forward,
            seat.position.y,
            seat.position.z - forwardX * sideways + forwardZ * forward,
          ),
      )
      .filter((position) => graph.isWalkable({ position, facing: 0, floor: seat.floor }));
    if (places.length > 0) return places;
  }
  return [];
}

/**
 * Returns true when a path is walkable all along: every point on it, a few
 * centimetres apart, is free floor, except within `slack` metres of its end.
 * A path to a place that furniture or walls box in still ends there, through
 * them, so a path being found is not enough.
 */
function isPathWalkable(
  path: ReadonlyArray<Waypoint>,
  graph: OfficeNavGraph,
  slack: number,
): boolean {
  const step = 0.05;
  const end = path[path.length - 1]?.position;
  for (let index = 0; index + 1 < path.length; index++) {
    const from = path[index]!;
    const to = path[index + 1]!;
    if (from.kind === "lift") continue;
    const length = from.position.distanceTo(to.position);
    for (let travelled = 0; travelled <= length; travelled += step) {
      const position = from.position
        .clone()
        .lerp(to.position, length === 0 ? 0 : travelled / length);
      if (end !== undefined && position.distanceTo(end) < slack) continue;
      if (!graph.isWalkable({ position, facing: 0, floor: from.floor })) return false;
    }
  }
  return true;
}

/**
 * Checks that a colleague coming in at the front door can walk, without
 * crossing furniture or walls, to every home, every spot, and the places
 * beside every home where the sim stands a colleague who visits or gets up.
 * The last metre to a seat is left out, because the sim slides a colleague
 * onto a seat from that far. Logs each failure, and one line with the counts.
 */
function checkWalking(
  world: World,
  graph: NavGraph,
  homes: ReadonlyMap<string, Seat>,
  spots: OfficeLayout["spots"],
): void {
  const missing = world.colleagues.filter((colleague) => !homes.has(colleague.id));
  for (const colleague of missing) console.warn(`[bureau] no home for ${colleague.id}`);
  if (!isOfficeNavGraph(graph)) return;
  const canWalkTo = (spot: Spot, slack: number): boolean => {
    const path = graph.findPath(spots.entrance, spot);
    return path !== null && isPathWalkable(path, graph, slack);
  };
  const describe = (spot: Spot): string =>
    `(${spot.position.x.toFixed(2)}, ${spot.position.z.toFixed(2)})`;

  const seats: Array<readonly [string, Spot]> = [
    ...[...homes].map(([id, seat]) => [`the home of ${id} in ${seat.roomId}`, seat] as const),
    ["your desk", spots.yourDesk],
    ...spots.lounge.map((seat, index) => [`lounge seat ${String(index)}`, seat] as const),
  ];
  const standing: Array<readonly [string, Spot]> = [
    ["the front door", spots.entrance],
    ...spots.queue.map((spot, index) => [`queue place ${String(index)}`, spot] as const),
    ...(spots.caseBoard === null ? [] : [["the case board", spots.caseBoard] as const]),
    ...(spots.records === null ? [] : [["records", spots.records] as const]),
    ...(spots.tea === null ? [] : [["the tea trolley", spots.tea] as const]),
  ];
  let reached = 0;
  for (const [name, seat] of seats) {
    if (canWalkTo(seat, SEAT_SLIDE)) reached += 1;
    else console.warn(`[bureau] no clear walk to ${name} at ${describe(seat)}`);
  }
  for (const [name, spot] of standing) {
    if (graph.isWalkable(spot) && canWalkTo(spot, 0)) reached += 1;
    else console.warn(`[bureau] no clear walk to ${name} at ${describe(spot)}`);
  }
  let besideReached = 0;
  for (const [id, seat] of homes) {
    const places = listBesideSeat(seat, graph).map((position) => ({ ...seat, position }));
    if (places.length > 0 && places.every((place) => canWalkTo(place, 0))) besideReached += 1;
    else console.warn(`[bureau] no clear walk to beside the home of ${id} at ${describe(seat)}`);
  }
  const total = seats.length + standing.length;
  console.info(
    `[bureau] ${String(world.colleagues.length)} colleagues, ${String(homes.size)} homes; ` +
      `clear walks from the front door: ${String(reached)} of ${String(total)} seats and spots, ` +
      `${String(besideReached)} of ${String(homes.size)} places beside the homes`,
  );
}
