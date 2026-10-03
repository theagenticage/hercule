/**
 * PROTOTYPE - one pavilion of the campus: the building a runner's sessions
 * work in. A pavilion is sized by the runner's slots, and its floor is laid
 * out by code area: each area's desks stand as an island on a rug in its
 * project's low-chroma tint, with a brass plaque on the floor in front. The
 * slots the runner has free are a block of small outlines inlaid in the
 * floor, smaller than a desk, so a big idle runner reads as roomy rather
 * than as an empty hall.
 *
 * Every sitter faces +z, south, toward the camera. An aisle runs along the
 * inside of the door wall, which faces the plaza.
 */
import { Box3, BufferGeometry, Group, Mesh, Object3D, Vector3 } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { BoxGeometry } from "three";
import type { RoomInfo, RoomKind, Seat } from "../engine/contracts";
import { paint } from "../engine/palette";
import { buildFloor } from "../kit/architecture";
import { buildCoatStand, buildDesk, buildPlant } from "../kit/props";
import type { Area, Colleague, RunnerInfo } from "../world/types";
import { AREA_PROJECT } from "../world/types";
import {
  buildFloorPlaque,
  buildPortal,
  buildRoomInfo,
  buildTintedRug,
  placeCornerColumns,
  placeWall,
  readProjectToken,
  readSeat,
  type NavPlan,
  type Rect,
} from "./campus-kit";

/** The width of the aisle inside the door wall. */
const AISLE = 1.7;
/** How far the islands keep from the three other walls. */
const MARGIN = 0.75;
/** The gaps between two islands side by side, and between two shelves of islands. */
const ISLAND_GAP = 0.75;
const SHELF_GAP = 0.6;
/** How far a rug reaches past its desks. */
const RUG_MARGIN = 0.32;
/** The gap between two desks of a row. */
const DESK_GAP = 0.38;
/** The lane between a desk's front and the chair behind it in the next row. */
const ROW_LANE = 0.85;
/** The strip at the front of an island where its plaque lies. */
const PLAQUE_STRIP = 0.55;
/** A free slot's inlaid outline, and the pitch the outlines are laid at. */
const SLOT_WIDTH = 0.62;
const SLOT_DEPTH = 0.44;
const SLOT_PITCH_X = 0.8;
const SLOT_PITCH_Z = 0.62;
/** How much bigger than the kit's plaque an island's floor plaque is, so it reads from a room's view. */
const PLAQUE_SCALE = 1.3;
/** The width of a pavilion's door. */
export const PAVILION_DOOR = 1.4;
/** The smallest pavilion, so even a one-slot runner has a room you can walk into. */
const MIN_WIDTH = 6.5;
const MIN_DEPTH = 5.5;

/** The order the areas are laid out in: projects first, then the meta areas. */
const AREA_ORDER: ReadonlyArray<Area> = [
  "checkout",
  "cart",
  "webhooks",
  "payouts",
  "infra",
  "dashboards",
  "secrets",
  "research",
  "review",
  "release",
  "correspondence",
  "triage",
  "assistants",
];

/** The room kind an area's island counts as: code for a project's area, a meta room's kind otherwise. */
const AREA_KIND: Readonly<Record<Area, RoomKind>> = {
  checkout: "code",
  cart: "code",
  webhooks: "code",
  payouts: "code",
  infra: "code",
  dashboards: "code",
  secrets: "code",
  research: "reading-room",
  review: "library",
  release: "dispatch",
  correspondence: "post-room",
  triage: "case-room",
  assistants: "lounge",
};

/** The size of a desk with its chair, turned to face south, measured once from the kit. */
interface DeskSize {
  readonly width: number;
  /** From the back of the chair to the front of the desk. */
  readonly depth: number;
  /** How far the chair's back reaches north of the desk's origin. */
  readonly back: number;
}

/** Measures a clerk's desk with its chair, as it stands turned to face south. */
export function measureDesk(): DeskSize {
  const probe = buildDesk().object;
  probe.rotation.y = Math.PI;
  probe.updateMatrixWorld(true);
  const box = new Box3().setFromObject(probe);
  return { width: box.max.x - box.min.x, depth: box.max.z - box.min.z, back: -box.min.z };
}

/** One island: an area's sessions at their desks, or the runner's free slots as outlines. */
interface IslandPlan {
  readonly area: Area | null;
  readonly sessions: ReadonlyArray<Colleague>;
  /** One per session, or one per free slot. */
  readonly count: number;
  readonly columns: number;
  readonly rows: number;
  readonly width: number;
  readonly depth: number;
  /** Where the island sits: u from the door wall inward, v from the north wall. */
  readonly u: number;
  readonly v: number;
}

/** A pavilion's plan: its size and where each island goes, before it is placed. */
export interface PavilionPlan {
  readonly runner: RunnerInfo;
  readonly id: string;
  readonly sessions: ReadonlyArray<Colleague>;
  /** The extent away from the door wall. */
  readonly width: number;
  /** The extent along the door wall. */
  readonly depth: number;
  readonly islands: ReadonlyArray<IslandPlan>;
  readonly desk: DeskSize;
}

/** Returns the rows and columns of an island of `count` desks: at most three abreast. */
function decideGrid(count: number): { readonly columns: number; readonly rows: number } {
  const rows = Math.ceil(count / 3);
  return { columns: Math.ceil(count / rows), rows };
}

/** Returns the rows and columns of a block of `count` free slots: about twice as wide as deep. */
function decideSlotGrid(count: number): { readonly columns: number; readonly rows: number } {
  const columns = Math.min(count, Math.max(3, Math.ceil(Math.sqrt(count * 2))));
  return { columns, rows: Math.ceil(count / columns) };
}

/**
 * Plans a runner's pavilion: one island per area its sessions work in, in
 * project order, then one of outlines for its free slots, packed in shelves
 * so the floor is about a third wider than deep.
 */
export function planPavilion(
  runner: RunnerInfo,
  sessions: ReadonlyArray<Colleague>,
  desk: DeskSize,
): PavilionPlan {
  const byArea = new Map<Area, Colleague[]>();
  for (const session of sessions) {
    const list = byArea.get(session.area);
    if (list === undefined) byArea.set(session.area, [session]);
    else list.push(session);
  }
  const groups: Array<{ area: Area | null; sessions: Colleague[]; count: number }> =
    AREA_ORDER.filter((area) => byArea.has(area)).map((area) => {
      const list = byArea.get(area) ?? [];
      return { area, sessions: list, count: list.length };
    });
  const free = runner.slots - sessions.length;
  if (free > 0) groups.push({ area: null, sessions: [], count: free });

  const sized = groups.map((group) => {
    if (group.area === null) {
      const { columns, rows } = decideSlotGrid(group.count);
      return {
        ...group,
        columns,
        rows,
        width: columns * SLOT_PITCH_X - (SLOT_PITCH_X - SLOT_WIDTH) + 2 * RUG_MARGIN,
        depth: rows * SLOT_PITCH_Z - (SLOT_PITCH_Z - SLOT_DEPTH) + PLAQUE_STRIP + 2 * RUG_MARGIN,
      };
    }
    const { columns, rows } = decideGrid(group.count);
    return {
      ...group,
      columns,
      rows,
      width: columns * desk.width + (columns - 1) * DESK_GAP + 2 * RUG_MARGIN,
      depth: rows * desk.depth + (rows - 1) * ROW_LANE + PLAQUE_STRIP + 2 * RUG_MARGIN,
    };
  });
  const area = sized.reduce(
    (sum, island) => sum + (island.width + ISLAND_GAP) * (island.depth + SHELF_GAP),
    0,
  );
  const widest = sized.reduce((most, island) => Math.max(most, island.width), 0);
  const shelfWidth = Math.max(widest, Math.sqrt(area * 1.45));

  // Shelf packing: islands go side by side until the shelf is full, then a new shelf starts below.
  const islands: IslandPlan[] = [];
  let u = 0;
  let v = 0;
  let shelfDepth = 0;
  let usedWidth = 0;
  for (const island of sized) {
    if (u > 0 && u + island.width > shelfWidth + 0.01) {
      v += shelfDepth + SHELF_GAP;
      u = 0;
      shelfDepth = 0;
    }
    islands.push({ ...island, u, v });
    u += island.width + ISLAND_GAP;
    usedWidth = Math.max(usedWidth, u - ISLAND_GAP);
    shelfDepth = Math.max(shelfDepth, island.depth);
  }
  const usedDepth = v + shelfDepth;
  const width = Math.max(MIN_WIDTH, AISLE + usedWidth + MARGIN);
  const depth = Math.max(MIN_DEPTH, usedDepth + 2 * MARGIN);
  // Centre the islands in whatever room the minimum size left over.
  const spareU = width - AISLE - MARGIN - usedWidth;
  const spareV = depth - 2 * MARGIN - usedDepth;
  return {
    runner,
    id: `pavilion-${runner.id}`,
    sessions,
    width,
    depth,
    desk,
    islands: islands.map((island) => ({
      ...island,
      u: island.u + AISLE + spareU / 2,
      v: island.v + MARGIN + spareV / 2,
    })),
  };
}

/** Where a pavilion stands: its door wall's line in x, which side the door is on, and its north edge. */
export interface PavilionPlacement {
  /** The side of the pavilion the door is in, toward the plaza. */
  readonly doorSide: "east" | "west";
  readonly doorX: number;
  readonly minZ: number;
}

/** A pavilion built and placed. */
export interface Pavilion {
  readonly object: Object3D;
  readonly rect: Rect;
  readonly rooms: ReadonlyArray<RoomInfo>;
  /** Each session's desk seat, by colleague id. */
  readonly homes: ReadonlyMap<string, Seat>;
  /** The middle of the doorway, on the wall's line. */
  readonly door: Vector3;
}

/** Returns an area's name as its plaque shows it. */
function readAreaLabel(area: Area): string {
  return area.charAt(0).toUpperCase() + area.slice(1);
}

/**
 * Builds the inlaid outlines of free slots as one mesh: a thin line round a
 * small rectangle centred on each of `centres`.
 */
function buildFreeOutlines(centres: ReadonlyArray<Vector3>): Mesh | null {
  if (centres.length === 0) return null;
  const line = 0.03;
  const parts: BufferGeometry[] = [];
  for (const { x, z } of centres) {
    const halfWidth = SLOT_WIDTH / 2;
    const halfDepth = SLOT_DEPTH / 2;
    const strips: Array<readonly [number, number, number, number]> = [
      [x, z - halfDepth + line / 2, SLOT_WIDTH, line],
      [x, z + halfDepth - line / 2, SLOT_WIDTH, line],
      [x - halfWidth + line / 2, z, line, SLOT_DEPTH - 2 * line],
      [x + halfWidth - line / 2, z, line, SLOT_DEPTH - 2 * line],
    ];
    for (const [x, z, width, depth] of strips) {
      parts.push(new BoxGeometry(width, 0.004, depth).translate(x, 0.004, z));
    }
  }
  const geometry = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  const mesh = new Mesh(geometry, paint("room-inlay", "matte", { dl: -0.12, dc: 0.01 }));
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Builds a planned pavilion at its placement: floor, windowed walls the
 * camera can lower, Deco corner piers, the portal with the runner's name at
 * the door, and the islands with their desks. Blocks every wall and desk in
 * the nav plan and opens the door.
 */
export function buildPavilion(
  plan: PavilionPlan,
  placement: PavilionPlacement,
  nav: NavPlan,
): Pavilion {
  const object = new Group();
  object.name = plan.id;
  const east = placement.doorSide === "east";
  // u runs from the door wall into the pavilion, so it runs west for a door on the east side.
  const toX = (u: number) => (east ? placement.doorX - u : placement.doorX + u);
  const rect: Rect = {
    minX: east ? placement.doorX - plan.width : placement.doorX,
    maxX: east ? placement.doorX : placement.doorX + plan.width,
    minZ: placement.minZ,
    maxZ: placement.minZ + plan.depth,
  };
  const centreX = (rect.minX + rect.maxX) / 2;
  const doorZ = rect.minZ + plan.depth / 2;

  const floor = buildFloor(plan.width, plan.depth, { inlay: "room-inlay" });
  floor.position.set(centreX, 0, doorZ);
  object.add(floor);

  const cutaway = { roomId: plan.id, exterior: true };
  for (const side of ["north", "south", "east", "west"] as const) {
    const doors = side === placement.doorSide ? [{ at: doorZ, width: PAVILION_DOOR }] : [];
    placeWall(object, rect, { side, doors, windows: true, cutaway }, nav);
  }
  placeCornerColumns(object, rect, nav, 2.85);

  const subtitle = `${plan.sessions.length} of ${plan.runner.slots}${plan.runner.local ? " · this Mac" : ""}`;
  const portal = buildPortal(plan.runner.name, PAVILION_DOOR, { subtitle });
  portal.object.position.set(placement.doorX, 0, doorZ);
  portal.object.rotation.y = east ? Math.PI / 2 : -Math.PI / 2;
  object.add(portal.object);
  for (const pylon of portal.pylons) nav.blockObject(pylon, 0.02);

  if (plan.runner.local) {
    // The machine the user sits at is marked as home, quietly: a doormat and two bay trees.
    const outward = east ? 1 : -1;
    const mat = buildTintedRug(0.9, 1.5, "room-inlay-2");
    mat.position.set(placement.doorX + outward * 0.75, 0.01, doorZ);
    object.add(mat);
    for (const side of [-1, 1]) {
      const plant = buildPlant("small");
      plant.position.set(placement.doorX + outward * 0.62, 0, doorZ + side * 1.35);
      object.add(plant);
      nav.blockObject(plant, 0.02);
    }
  }

  // The aisle's furniture: a coat stand by the door, a tall plant at each end.
  const coatStand = buildCoatStand();
  coatStand.position.set(toX(0.42), 0, doorZ - PAVILION_DOOR / 2 - 0.55);
  object.add(coatStand);
  nav.blockObject(coatStand, 0.02);
  for (const z of [rect.minZ + 0.5, rect.maxZ - 0.5]) {
    const plant = buildPlant("tall");
    plant.position.set(toX(0.5), 0, z);
    object.add(plant);
    nav.blockObject(plant, 0.02);
  }

  const rooms: RoomInfo[] = [buildRoomInfo(plan.id, plan.runner.name, "floor", rect, null)];
  const homes = new Map<string, Seat>();
  const freeCentres: Vector3[] = [];
  const seatMarkers: Array<{
    colleague: Colleague;
    marker: Object3D;
    roomId: string;
    desk: ReturnType<typeof buildDesk>;
  }> = [];
  const { desk } = plan;
  for (const island of plan.islands) {
    const x0 = Math.min(toX(island.u), toX(island.u + island.width));
    const islandRect: Rect = {
      minX: x0,
      maxX: x0 + island.width,
      minZ: rect.minZ + island.v,
      maxZ: rect.minZ + island.v + island.depth,
    };
    const project = island.area === null ? null : AREA_PROJECT[island.area];
    const roomId = island.area === null ? `${plan.id}:free` : `${plan.id}:${island.area}`;
    const plaqueZ = islandRect.maxZ - RUG_MARGIN - PLAQUE_STRIP / 2;
    if (island.area === null) {
      for (let index = 0; index < island.count; index++) {
        const row = Math.floor(index / island.columns);
        const inRow = Math.min(island.columns, island.count - row * island.columns);
        const offset = ((island.columns - inRow) * SLOT_PITCH_X) / 2;
        freeCentres.push(
          new Vector3(
            islandRect.minX +
              RUG_MARGIN +
              offset +
              (index % island.columns) * SLOT_PITCH_X +
              SLOT_WIDTH / 2,
            0,
            islandRect.minZ + RUG_MARGIN + row * SLOT_PITCH_Z + SLOT_DEPTH / 2,
          ),
        );
      }
      const plaque = buildFloorPlaque(`${island.count} free`);
      plaque.position.set((islandRect.minX + islandRect.maxX) / 2, plaque.position.y, plaqueZ);
      plaque.scale.setScalar(PLAQUE_SCALE);
      object.add(plaque);
      continue;
    }
    const origins: Vector3[] = [];
    for (let index = 0; index < island.count; index++) {
      const row = Math.floor(index / island.columns);
      const inRow = Math.min(island.columns, island.count - row * island.columns);
      const column = index % island.columns;
      // A short last row is centred under the full rows.
      const offset = ((island.columns - inRow) * (desk.width + DESK_GAP)) / 2;
      origins.push(
        new Vector3(
          islandRect.minX + RUG_MARGIN + offset + column * (desk.width + DESK_GAP) + desk.width / 2,
          0,
          islandRect.minZ + RUG_MARGIN + row * (desk.depth + ROW_LANE) + desk.back,
        ),
      );
    }
    const rug = buildTintedRug(island.width, island.depth, readProjectToken(project));
    rug.position.set(
      (islandRect.minX + islandRect.maxX) / 2,
      0,
      (islandRect.minZ + islandRect.maxZ) / 2,
    );
    object.add(rug);
    const plaque = buildFloorPlaque(readAreaLabel(island.area));
    plaque.position.set((islandRect.minX + islandRect.maxX) / 2, plaque.position.y, plaqueZ);
    plaque.scale.setScalar(PLAQUE_SCALE);
    object.add(plaque);
    island.sessions.forEach((colleague, index) => {
      const handle = buildDesk();
      handle.object.rotation.y = Math.PI;
      handle.object.position.copy(origins[index]!);
      object.add(handle.object);
      nav.blockObject(handle.object, 0);
      seatMarkers.push({ colleague, marker: handle.seatMarker, roomId, desk: handle });
    });
    // The pavilion's own room carries the runner's name, so an area's room is named by its area alone.
    rooms.push(
      buildRoomInfo(
        roomId,
        readAreaLabel(island.area),
        AREA_KIND[island.area],
        islandRect,
        project,
      ),
    );
  }
  const outlines = buildFreeOutlines(freeCentres);
  if (outlines !== null) object.add(outlines);

  object.updateMatrixWorld(true);
  for (const { colleague, marker, roomId, desk: handle } of seatMarkers) {
    homes.set(colleague.id, readSeat(marker, "desk", roomId, handle));
  }
  return { object, rect, rooms, homes, door: new Vector3(placement.doorX, 0, doorZ) };
}
