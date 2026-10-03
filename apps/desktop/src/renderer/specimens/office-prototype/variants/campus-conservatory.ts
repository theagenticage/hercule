/**
 * PROTOTYPE - the conservatory at the south end of the plaza, where the
 * assistants live: a glass house among the plants, its door on the plaza.
 * An assistant that runs a session works at a desk; one that holds none
 * (Juno, asleep) has an armchair by a standard lamp.
 */
import { Group, Object3D, Vector3 } from "three";
import type { RoomInfo, Seat } from "../engine/contracts";
import { LAMP, type Lamp } from "../engine/contracts";
import { buildFloor } from "../kit/architecture";
import { buildArmchair, buildDesk, buildFloorLamp, buildPlant } from "../kit/props";
import type { Colleague } from "../world/types";
import {
  buildPortal,
  buildRoomInfo,
  buildTintedRug,
  placeCornerColumns,
  placeWall,
  readSeat,
  type NavPlan,
  type Rect,
} from "./campus-kit";

/** The conservatory's room id. */
export const CONSERVATORY_ID = "conservatory";
/** The conservatory's size: along x, and along z. */
export const CONSERVATORY_WIDTH = 7.4;
export const CONSERVATORY_DEPTH = 5.6;
const DOOR = 1.4;

/** The conservatory, built and placed. */
export interface Conservatory {
  readonly object: Object3D;
  readonly rect: Rect;
  readonly room: RoomInfo;
  /** Each assistant's seat, by colleague id. */
  readonly homes: ReadonlyMap<string, Seat>;
  /** The middle of the doorway, on the north wall's line. */
  readonly door: Vector3;
}

/**
 * Builds the conservatory centred on x = 0 with its north wall at z =
 * `north`, and seats the assistants in it. Blocks its walls and furniture in
 * the nav plan and opens the door.
 */
export function buildConservatory(
  north: number,
  assistants: ReadonlyArray<Colleague>,
  nav: NavPlan,
): Conservatory {
  const object = new Group();
  object.name = CONSERVATORY_ID;
  const half = CONSERVATORY_WIDTH / 2;
  const rect: Rect = { minX: -half, maxX: half, minZ: north, maxZ: north + CONSERVATORY_DEPTH };
  const floor = buildFloor(CONSERVATORY_WIDTH, CONSERVATORY_DEPTH, { inlay: "room-inlay-2" });
  floor.position.set(0, 0, north + CONSERVATORY_DEPTH / 2);
  object.add(floor);
  const cutaway = { roomId: CONSERVATORY_ID, exterior: true };
  for (const side of ["north", "south", "east", "west"] as const) {
    const doors = side === "north" ? [{ at: 0, width: DOOR }] : [];
    placeWall(object, rect, { side, doors, windows: true, cutaway }, nav);
  }
  placeCornerColumns(object, rect, nav, 2.85);
  const portal = buildPortal("Conservatory", DOOR);
  portal.object.position.set(0, 0, north);
  portal.object.rotation.y = Math.PI;
  object.add(portal.object);
  for (const pylon of portal.pylons) nav.blockObject(pylon, 0.02);

  const place = (item: Object3D, x: number, z: number, turn = 0): Object3D => {
    item.position.set(x, 0, z);
    item.rotation.y = turn;
    object.add(item);
    nav.blockObject(item, 0.02);
    return item;
  };

  const rug = buildTintedRug(4.6, 3.0, "room-inlay");
  rug.position.set(0, 0, north + 3.05);
  object.add(rug);

  // Plants line the glass: tall ones in the corners, small ones between.
  for (const x of [-half + 0.5, half - 0.5]) {
    for (const z of [north + 0.5, rect.maxZ - 0.5]) place(buildPlant("tall"), x, z);
  }
  for (const x of [-1.6, 0, 1.6]) place(buildPlant("small"), x, rect.maxZ - 0.42);
  for (const z of [north + 2.2, north + 3.6]) {
    place(buildPlant("small"), -half + 0.42, z);
  }

  const working = assistants.filter((assistant) => assistant.runnerId !== null);
  const resting = assistants.filter((assistant) => assistant.runnerId === null);
  const seats: Array<{
    colleague: Colleague;
    marker: Object3D;
    kind: Seat["kind"];
    desk: ReturnType<typeof buildDesk> | null;
  }> = [];
  const pitch = 1.75;
  working.forEach((colleague, index) => {
    const desk = buildDesk();
    const x = -0.9 + (index - (working.length - 1) / 2) * pitch;
    place(desk.object, x, north + 2.6, Math.PI);
    seats.push({ colleague, marker: desk.seatMarker, kind: "desk", desk });
  });
  resting.forEach((colleague, index) => {
    const chair = buildArmchair();
    place(chair.object, 2.15, north + 2.2 + index * 1.2, -Math.PI / 2);
    seats.push({ colleague, marker: chair.seatMarker, kind: "armchair", desk: null });
  });
  const lamp = buildFloorLamp();
  place(lamp.object, half - 0.5, north + 1.45);
  const lampData = lamp.object.userData as Record<string, unknown>;
  lampData[LAMP] ??= { setOn: (on: boolean) => lamp.setOn(on) } satisfies Lamp;

  object.updateMatrixWorld(true);
  const homes = new Map<string, Seat>();
  for (const { colleague, marker, kind, desk } of seats) {
    homes.set(colleague.id, readSeat(marker, kind, CONSERVATORY_ID, desk));
  }
  return {
    object,
    rect,
    room: buildRoomInfo(CONSERVATORY_ID, "Conservatory", "lounge", rect, null),
    homes,
    door: new Vector3(0, 0, north),
  };
}
