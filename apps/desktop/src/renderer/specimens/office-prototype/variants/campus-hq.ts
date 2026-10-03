/**
 * PROTOTYPE - the campus's headquarters, at the north end of the plaza. Four
 * rooms side by side behind one long facade:
 *
 * - the Case Room in the west, where Triage sits by the case board and the
 *   pneumatic tubes from every pavilion end;
 * - the user's office in the middle, behind the front door: the partner desk
 *   in the middle of the room, the user's chair toward the door, and the
 *   queue running north from the desk toward the "Now serving" sign, so the
 *   waiting colleagues face the user and the camera;
 * - the lounge in the north-east, with armchairs and the tea trolley;
 * - the records in the south-east, a row of filing cabinets.
 *
 * Things hung on a wall hang only on a north or west wall, which the camera
 * never lowers, so nothing is left floating when it lowers the others.
 */
import {
  Box3,
  BufferGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  Object3D,
  SphereGeometry,
  Vector3,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { RoomInfo, Seat, Spot } from "../engine/contracts";
import { LAMP, type Lamp } from "../engine/contracts";
import { paint } from "../engine/palette";
import { buildColumn, buildFloor } from "../kit/architecture";
import {
  buildArmchair,
  buildBench,
  buildBookshelf,
  buildCabinet,
  buildCaseBoard,
  buildDesk,
  buildFloorLamp,
  buildNowServing,
  buildPlant,
  buildRug,
  buildTeaTrolley,
  buildWallClock,
  buildYourDesk,
  type CaseBoardHandle,
  type NowServingHandle,
} from "../kit/props";
import type { Colleague } from "../world/types";
import {
  buildPortal,
  buildRoomInfo,
  buildTintedRug,
  placeMarker,
  placeWall,
  readSeat,
  readSpot,
  WALL_THICKNESS,
  type NavPlan,
  type Rect,
} from "./campus-kit";

/** The headquarters' size: its facade along x and its depth along z. */
export const HQ_WIDTH = 16;
export const HQ_DEPTH = 9;
/** The width of the front door. */
const FRONT_DOOR = 1.6;
/** How many colleagues the queue has room for. */
const QUEUE_LENGTH = 7;
/** The distance between two colleagues in the queue. */
const QUEUE_STEP = 0.66;

/** The room ids of the headquarters. */
export const HQ_ROOMS = {
  caseRoom: "hq-case-room",
  office: "hq-office",
  lounge: "hq-lounge",
  records: "hq-records",
} as const;

/** The headquarters, built and placed. */
export interface Headquarters {
  readonly object: Object3D;
  readonly rect: Rect;
  readonly rooms: ReadonlyArray<RoomInfo>;
  readonly yourDesk: Spot;
  readonly queue: ReadonlyArray<Spot>;
  readonly lounge: ReadonlyArray<Seat>;
  readonly caseBoardSpot: Spot;
  readonly records: Spot;
  readonly entrance: Spot;
  readonly tea: Spot;
  /** Triage's desk seats, by colleague id. */
  readonly homes: ReadonlyMap<string, Seat>;
  /** The middle of the front doorway, on the facade's line. */
  readonly door: Vector3;
  /** Where the pneumatic tubes end: just above the receiving cabinet in the Case Room. */
  readonly receiver: Vector3;
  readonly caseBoard: CaseBoardHandle;
  readonly nowServing: NowServingHandle;
}

/** Returns an object's footprint size, measured from its world box. */
function measureFootprint(object: Object3D): Vector3 {
  object.updateMatrixWorld(true);
  return new Box3().setFromObject(object).getSize(new Vector3());
}

/**
 * Builds the brass stanchions on both sides of the queue: posts joined by a
 * rope, merged into one mesh per material. Returns the object, its origin on
 * the ground between the two lines, which run along z for `length`.
 */
function buildStanchions(length: number, spread: number): Object3D {
  const object = new Group();
  const posts: BufferGeometry[] = [];
  const ropes: BufferGeometry[] = [];
  const count = Math.max(2, Math.round(length / 1.1) + 1);
  for (const x of [-spread / 2, spread / 2]) {
    for (let index = 0; index < count; index++) {
      const z = -length / 2 + (index * length) / (count - 1);
      posts.push(new CylinderGeometry(0.09, 0.11, 0.03, 16).translate(x, 0.015, z));
      posts.push(new CylinderGeometry(0.022, 0.022, 0.84, 10).translate(x, 0.45, z));
      posts.push(new SphereGeometry(0.04, 12, 8).translate(x, 0.9, z));
      if (index > 0) {
        const previous = -length / 2 + ((index - 1) * length) / (count - 1);
        const span = z - previous;
        // A rope sags a little between its posts, drawn as two straight halves.
        for (const half of [0, 1]) {
          const from = previous + (half * span) / 2;
          const rope = new CylinderGeometry(0.016, 0.016, span / 2 + 0.01, 8);
          rope.rotateX(Math.PI / 2 + (half === 0 ? 0.12 : -0.12));
          rope.translate(x, 0.8, from + span / 4);
          ropes.push(rope);
        }
      }
    }
  }
  const brass = new Mesh(mergeGeometries(posts), paint("brass", "brass"));
  const rope = new Mesh(
    mergeGeometries(ropes),
    paint("room-fabric", "fabric", { dl: -0.12, dc: 0.02 }),
  );
  for (const part of [...posts, ...ropes]) part.dispose();
  brass.castShadow = true;
  rope.castShadow = true;
  object.add(brass, rope);
  return object;
}

/**
 * Builds the headquarters with its facade at z = `south`, centred on x = 0.
 * Triage's colleagues get desks in the Case Room. Blocks every wall and piece
 * of furniture in the nav plan and opens the doors.
 */
export function buildHeadquarters(
  south: number,
  triage: ReadonlyArray<Colleague>,
  nav: NavPlan,
): Headquarters {
  const object = new Group();
  object.name = "headquarters";
  const north = south - HQ_DEPTH;
  const half = HQ_WIDTH / 2;
  const rect: Rect = { minX: -half, maxX: half, minZ: north, maxZ: south };
  const caseRoom: Rect = { minX: -half, maxX: -3, minZ: north, maxZ: south };
  const office: Rect = { minX: -3, maxX: 3, minZ: north, maxZ: south };
  const loungeRect: Rect = { minX: 3, maxX: half, minZ: north, maxZ: north + 4.8 };
  const recordsRect: Rect = { minX: 3, maxX: half, minZ: north + 4.8, maxZ: south };
  const inner = WALL_THICKNESS / 2;

  // Floors, one per room, each with its own Deco border.
  for (const room of [caseRoom, office, loungeRect, recordsRect]) {
    const floor = buildFloor(room.maxX - room.minX, room.maxZ - room.minZ);
    floor.position.set((room.minX + room.maxX) / 2, 0, (room.minZ + room.maxZ) / 2);
    object.add(floor);
  }

  // The walls. The north and west walls stay up and carry what hangs; the
  // others are lowered by the camera for the room they hide.
  const cut = (roomId: string, exterior: boolean) => ({ roomId, exterior });
  placeWall(object, caseRoom, { side: "north", windows: true }, nav);
  placeWall(object, caseRoom, { side: "west" }, nav);
  placeWall(
    object,
    caseRoom,
    { side: "south", windows: true, cutaway: cut(HQ_ROOMS.caseRoom, true) },
    nav,
  );
  placeWall(
    object,
    caseRoom,
    {
      side: "east",
      doors: [{ at: south - 2.1, width: 1.1 }],
      cutaway: cut(HQ_ROOMS.caseRoom, false),
    },
    nav,
  );
  placeWall(object, office, { side: "north" }, nav);
  placeWall(
    object,
    office,
    {
      side: "south",
      doors: [{ at: 0, width: FRONT_DOOR }],
      windows: true,
      cutaway: cut(HQ_ROOMS.office, true),
    },
    nav,
  );
  placeWall(
    object,
    office,
    {
      side: "east",
      doors: [
        { at: north + 3.2, width: 1.1 },
        { at: south - 2.1, width: 1.1 },
      ],
      cutaway: cut(HQ_ROOMS.office, false),
    },
    nav,
  );
  placeWall(object, loungeRect, { side: "north" }, nav);
  placeWall(
    object,
    loungeRect,
    { side: "east", windows: true, cutaway: cut(HQ_ROOMS.lounge, true) },
    nav,
  );
  placeWall(object, loungeRect, { side: "south", cutaway: cut(HQ_ROOMS.lounge, false) }, nav);
  placeWall(
    object,
    recordsRect,
    { side: "east", windows: true, cutaway: cut(HQ_ROOMS.records, true) },
    nav,
  );
  placeWall(
    object,
    recordsRect,
    { side: "south", windows: true, cutaway: cut(HQ_ROOMS.records, true) },
    nav,
  );

  // Piers at the corners and where the partitions meet the facade and the back wall.
  for (const x of [-half, -3, 3, half]) {
    for (const z of [north, south]) {
      const column = buildColumn(2.95);
      column.position.set(x, 0, z);
      object.add(column);
      nav.blockObject(column, 0.02);
    }
  }

  const portal = buildPortal("Headquarters", FRONT_DOOR, { height: 3.35 });
  portal.object.position.set(0, 0, south);
  object.add(portal.object);
  for (const pylon of portal.pylons) nav.blockObject(pylon, 0.02);

  const place = (item: Object3D, x: number, z: number, turn = 0, block = true): Object3D => {
    item.position.set(x, 0, z);
    item.rotation.y = turn;
    object.add(item);
    if (block) nav.blockObject(item, 0.02);
    return item;
  };

  // The user's office: the partner desk turned so the user faces north, the
  // queue straight north of it, toward the sign. The desk stands far enough
  // south for the queue's tail to keep clear of the north wall.
  const yourDesk = buildYourDesk();
  const deskZ = south - 3.3;
  place(yourDesk.object, 0, deskZ, Math.PI);
  const rug = buildTintedRug(3.6, 2.9, "room-inlay");
  rug.position.set(0, 0, deskZ + 0.15);
  object.add(rug);
  const nowServing = buildNowServing();
  nowServing.object.position.set(0, 1.72, north + inner);
  object.add(nowServing.object);
  for (const x of [-2.45, 2.45]) place(buildPlant("tall"), x, north + 0.55);
  // The head stands where the desk's visitor stands, 0.95 north of its middle.
  const queueHead = deskZ - 0.95;
  const queueMarkers = Array.from({ length: QUEUE_LENGTH }, (_, index) =>
    placeMarker(object, 0, queueHead - index * QUEUE_STEP, 0),
  );
  // The stanchions run from a step behind the head to just short of the
  // tail, so both ends of the line stay open to walk in and out of.
  const stanchionNorth = queueHead - (QUEUE_LENGTH - 1) * QUEUE_STEP + 0.3;
  const stanchionSouth = queueHead - 0.5;
  const stanchions = buildStanchions(stanchionSouth - stanchionNorth, 1.25);
  place(stanchions, 0, (stanchionNorth + stanchionSouth) / 2, 0, false);
  for (const x of [-0.625, 0.625]) {
    nav.block({
      minX: x - 0.05,
      maxX: x + 0.05,
      minZ: stanchionNorth - 0.05,
      maxZ: stanchionSouth + 0.05,
    });
  }
  const entrance = placeMarker(object, 0, south - 0.55, Math.PI);

  // The Case Room: the board on the west wall, Triage at a desk, the tube receiver in the corner.
  const caseBoard = buildCaseBoard(3.2);
  caseBoard.object.position.set(caseRoom.minX + inner, 0, north + 4.3);
  caseBoard.object.rotation.y = Math.PI / 2;
  object.add(caseBoard.object);
  caseBoard.setCards(0, 0);
  const receiverCabinet = place(buildCabinet(), caseRoom.minX + 0.75, north + 0.45);
  const receiverHeight = measureFootprint(receiverCabinet).y;
  const homes = new Map<string, Seat>();
  const triageDesks = triage.map((colleague, index) => {
    const desk = buildDesk();
    place(desk.object, -4.6 - index * 1.6, north + 2.35, Math.PI);
    return { colleague, desk };
  });
  place(buildPlant("tall"), caseRoom.maxX - 0.5, north + 0.5);
  place(buildPlant("small"), caseRoom.minX + 0.45, south - 0.45);
  // A rug before the board and a bench facing it, where a case is studied.
  const boardRug = buildTintedRug(2.2, 3.6, "room-inlay");
  boardRug.position.set(caseRoom.minX + inner + 1.35, 0, north + 4.3);
  object.add(boardRug);
  place(buildBench(3).object, caseRoom.minX + 2.95, north + 4.3, -Math.PI / 2);

  // The lounge: two pairs of armchairs facing over a rug, tea against the north wall.
  const loungeSeats = [
    { x: 4.05, z: north + 2.35, turn: Math.PI / 2 },
    { x: 4.05, z: north + 3.55, turn: Math.PI / 2 },
    { x: 6.95, z: north + 2.35, turn: -Math.PI / 2 },
    { x: 6.95, z: north + 3.55, turn: -Math.PI / 2 },
  ].map(({ x, z, turn }) => {
    const chair = buildArmchair();
    place(chair.object, x, z, turn);
    return chair.seatMarker;
  });
  const loungeRug = buildRug(2.2, 2.5);
  loungeRug.position.set(5.5, 0, north + 2.95);
  object.add(loungeRug);
  const shelf = buildBookshelf(1.4);
  place(shelf, 4.0, north + inner + measureFootprint(shelf).z / 2);
  const trolley = buildTeaTrolley();
  place(trolley, 7.1, north + inner + 0.05 + measureFootprint(trolley).z / 2);
  const teaMarker = placeMarker(object, 7.1, north + 1.1, Math.PI);
  const clock = buildWallClock();
  clock.position.set(5.65, 1.95, north + inner);
  object.add(clock);
  const lamp = buildFloorLamp();
  place(lamp.object, half - 0.45, loungeRect.maxZ - 0.45);
  const lampData = lamp.object.userData as Record<string, unknown>;
  lampData[LAMP] ??= { setOn: (on: boolean) => lamp.setOn(on) } satisfies Lamp;

  // The records: a row of cabinets against the lounge's wall, a spot in front to file at.
  const cabinetCount = 7;
  for (let index = 0; index < cabinetCount; index++) {
    place(buildCabinet(), 3.85 + index * 0.55, recordsRect.minZ + inner + 0.32);
  }
  const recordsMarker = placeMarker(object, 5.5, recordsRect.minZ + 1.45, Math.PI);
  place(buildPlant("small"), half - 0.45, south - 0.45);

  object.updateMatrixWorld(true);
  for (const { colleague, desk } of triageDesks) {
    homes.set(colleague.id, readSeat(desk.seatMarker, "desk", HQ_ROOMS.caseRoom, desk));
  }
  const receiverBox = new Box3().setFromObject(receiverCabinet);
  const receiver = new Vector3(
    (receiverBox.min.x + receiverBox.max.x) / 2,
    receiverHeight + 0.05,
    (receiverBox.min.z + receiverBox.max.z) / 2,
  );
  return {
    object,
    rect,
    rooms: [
      buildRoomInfo(HQ_ROOMS.office, "Your office", "your-office", office, null),
      buildRoomInfo(HQ_ROOMS.caseRoom, "Case room", "case-room", caseRoom, null),
      buildRoomInfo(HQ_ROOMS.lounge, "Lounge", "lounge", loungeRect, null),
      buildRoomInfo(HQ_ROOMS.records, "Records", "records", recordsRect, null),
    ],
    yourDesk: readSpot(yourDesk.seatMarker),
    queue: queueMarkers.map(readSpot),
    lounge: loungeSeats.map((marker) => readSeat(marker, "armchair", HQ_ROOMS.lounge, null)),
    caseBoardSpot: readSpot(caseBoard.pinMarker),
    records: readSpot(recordsMarker),
    entrance: readSpot(entrance),
    tea: readSpot(teaMarker),
    homes,
    door: new Vector3(0, 0, south),
    receiver,
    caseBoard,
    nowServing,
  };
}
