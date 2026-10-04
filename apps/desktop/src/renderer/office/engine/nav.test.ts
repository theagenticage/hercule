/**
 * Tests the paths colleagues walk in the Office, on the Bureau, the map the
 * Office ships with. The tests walk between every two spots that stand in
 * different rooms: the desks, the queue at the user's desk, the user's desk,
 * the Lounge's seats and the tea trolley. They check that:
 *
 * - no path comes closer than `BODY_CLEARANCE` to a wall or a piece of
 *   furniture anywhere along its legs, so nobody walks through either;
 * - in the Gallery, the corridor the rooms open onto, a straight leg keeps
 *   nearly the clearance of the cells the search walked, and no path runs
 *   more than a metre of the Gallery close to a wall, except where it turns
 *   into a door;
 * - a path crosses a door that is too narrow to keep `COMFORT_CLEARANCE` from
 *   both jambs in the middle third of the door's width;
 * - a path starts and ends exactly at the spots asked for, even at a desk
 *   chair, which stands inside its desk's footprint.
 *
 * Distances are measured to the walls and furniture as the map declares them
 * to the nav builder. The walking grid's own cells are private to the nav
 * module, so every point along a path is also checked with `isWalkable`,
 * which asks the grid whether a body may stand there.
 *
 * Building the Bureau draws signs and textures on 2D canvases and loads the
 * signs' fonts, and jsdom has neither. A canvas that draws nothing and fonts
 * that are always loaded stand in for them. The walking grid reads nothing
 * that is drawn.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Vector3 } from "three";
import {
  MOSS,
  OPS_PROJECT,
  PRIMARY,
  THREAD_3F1,
  WEBSHOP_PROJECT,
  buildSession,
} from "@hercule/client-core/threads/testing";
import { buildBureau } from "../maps/bureau";
import { buildDirectory } from "../maps/bureau-fleet";
import { HALL_IDS, planFloor, type Rect } from "../maps/bureau-plan";
import { designRooms } from "../maps/bureau-rooms";
import { BUREAU_MAP } from "../maps/office-map";
import { buildWorld } from "../world/build-world";
import type { BuiltOffice, NavBuilder, Spot, Waypoint } from "./contracts";
import {
  BODY_CLEARANCE,
  COMFORT_CLEARANCE,
  LEG_SLACK,
  createNavBuilder,
  isOfficeNavGraph,
} from "./nav";

/** How far apart the points checked along a leg are, in metres: far finer than the grid. */
const SAMPLE_STEP = 0.01;
/**
 * The least distance a leg in the Gallery keeps from its walls: the search
 * walks the Gallery on cells whose grid clearance is at least 0.54 m, and a
 * straight leg may come `LEG_SLACK` closer than its cells.
 */
const GALLERY_LEG_CLEARANCE = 0.54 - LEG_SLACK;

/** A spot a colleague walks to, with a name for failure messages and the room it stands in. */
interface Place {
  readonly name: string;
  readonly spot: Spot;
  readonly roomId: string;
}

/** The path from one place to another, or null when none was found. */
interface Walk {
  readonly from: Place;
  readonly to: Place;
  readonly path: ReadonlyArray<Waypoint> | null;
}

/** A nav builder that also keeps what the map declares solid, to measure paths against. */
interface RecordingNavBuilder extends NavBuilder {
  /** Returns the distance from the point (x, z) to the nearest wall or piece of furniture. */
  readonly measureClearance: (x: number, z: number) => number;
}

/** Returns the parts of `rect` that `hole` does not cover: up to four rectangles. */
function subtractRect(rect: Rect, hole: Rect): Rect[] {
  const overlaps =
    hole.minX < rect.maxX &&
    hole.maxX > rect.minX &&
    hole.minZ < rect.maxZ &&
    hole.maxZ > rect.minZ;
  if (!overlaps) return [rect];
  const parts: Rect[] = [];
  if (hole.minZ > rect.minZ) parts.push({ ...rect, maxZ: hole.minZ });
  if (hole.maxZ < rect.maxZ) parts.push({ ...rect, minZ: hole.maxZ });
  const minZ = Math.max(rect.minZ, hole.minZ);
  const maxZ = Math.min(rect.maxZ, hole.maxZ);
  if (hole.minX > rect.minX) parts.push({ minX: rect.minX, minZ, maxX: hole.minX, maxZ });
  if (hole.maxX < rect.maxX) parts.push({ minX: hole.maxX, minZ, maxX: rect.maxX, maxZ });
  return parts;
}

/** Returns the distance from the point (x, z) to the nearest point of `rect`, 0 inside it. */
function measureDistanceToRect(rect: Rect, x: number, z: number): number {
  const dx = Math.max(rect.minX - x, 0, x - rect.maxX);
  const dz = Math.max(rect.minZ - z, 0, z - rect.maxZ);
  return Math.hypot(dx, dz);
}

/**
 * Creates a nav builder that builds the real graph and also keeps every
 * solid rectangle the map declares. An opening cuts through what was blocked
 * before it and nothing blocked after it, as in the walking grid, which
 * applies blocks and openings in the order they were declared. The Bureau
 * has one storey, so the storey of each call is not kept.
 */
function createRecordingNavBuilder(): RecordingNavBuilder {
  const builder = createNavBuilder();
  let solids: Rect[] = [];
  return {
    addFloor: (floor, y, minX, minZ, maxX, maxZ) =>
      builder.addFloor(floor, y, minX, minZ, maxX, maxZ),
    block(floor, minX, minZ, maxX, maxZ) {
      solids.push({ minX, minZ, maxX, maxZ });
      builder.block(floor, minX, minZ, maxX, maxZ);
    },
    blockObject() {
      throw new Error("The Bureau declares its furniture as rectangles; record blockObject too.");
    },
    open(floor, minX, minZ, maxX, maxZ) {
      const opening = { minX, minZ, maxX, maxZ };
      solids = solids.flatMap((solid) => subtractRect(solid, opening));
      builder.open(floor, minX, minZ, maxX, maxZ);
    },
    build: () => builder.build(),
    measureClearance: (x, z) => {
      let nearest = Infinity;
      for (const solid of solids) nearest = Math.min(nearest, measureDistanceToRect(solid, x, z));
      return nearest;
    },
  };
}

/**
 * Replaces the 2D canvas and the font loading, which jsdom lacks, with stubs.
 * The canvas accepts every drawing call and draws nothing; a colour read back
 * from it is black. Every font counts as loaded.
 */
function stubCanvasAndFonts(): void {
  const blankContext = new Proxy(
    {},
    {
      get: (_context, key) => {
        if (key === "getImageData") return () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) });
        if (key === "createLinearGradient" || key === "createRadialGradient") {
          return () => ({ addColorStop: () => {} });
        }
        if (key === "measureText") return () => ({ width: 0 });
        return () => {};
      },
      set: () => true,
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(blankContext as never);
  vi.spyOn(document, "fonts", "get").mockReturnValue({
    ready: Promise.resolve(),
    check: () => true,
    load: () => Promise.resolve([]),
  } as never);
}

/** Returns the id of the room whose box holds the spot, or the halls' id when no room does. */
function findRoomId(office: BuiltOffice, spot: Spot): string {
  const room = office.rooms.find((candidate) => candidate.bounds.containsPoint(spot.position));
  return room?.id ?? "hall";
}

/**
 * Builds the Bureau for a world with two project rooms, a desk outside any
 * project and an idle colleague, and finds the path between every two spots
 * that stand in different rooms. Returns the walks, the office's graph, the
 * floor plan the Bureau was built from, and the measure of distance to its
 * walls and furniture.
 */
function buildBureauWalks() {
  const world = buildWorld({
    sessions: [
      buildSession({
        id: "s-web-1",
        status: "busy",
        runnerId: MOSS.id,
        projectId: WEBSHOP_PROJECT.id,
      }),
      buildSession({
        id: "s-web-2",
        status: "busy",
        runnerId: MOSS.id,
        projectId: WEBSHOP_PROJECT.id,
      }),
      buildSession({ id: "s-ops-1", status: "busy", runnerId: MOSS.id, projectId: OPS_PROJECT.id }),
      buildSession({ id: "s-loose", status: "busy", runnerId: MOSS.id }),
      buildSession({ id: "s-idle", status: "idle", runnerId: MOSS.id, projectId: OPS_PROJECT.id }),
    ],
    projects: [WEBSHOP_PROJECT, OPS_PROJECT],
    workspaces: [PRIMARY, THREAD_3F1],
    runners: [MOSS],
    localRunnerId: MOSS.id,
  });
  const builder = createRecordingNavBuilder();
  const office = buildBureau({ world, nav: builder });
  const { nav } = office;
  if (!isOfficeNavGraph(nav)) throw new Error("The Bureau's graph is not the nav module's.");
  // The Bureau plans its floor from the world the same way.
  const plan = planFloor(designRooms(world, BUREAU_MAP, buildDirectory(world)).request);

  const namedSpots: Array<{ readonly name: string; readonly spot: Spot }> = [
    ...[...office.homes].map(([colleagueId, seat]) => ({
      name: `desk ${colleagueId}`,
      spot: seat,
    })),
    ...office.spots.queue.map((spot, index) => ({ name: `queue ${index}`, spot })),
    { name: "your desk", spot: office.spots.yourDesk },
    ...office.spots.lounge.map((seat, index) => ({ name: `lounge seat ${index}`, spot: seat })),
    ...(office.spots.tea === null ? [] : [{ name: "tea", spot: office.spots.tea }]),
  ];
  const places: Place[] = namedSpots.map((named) => ({
    ...named,
    roomId: findRoomId(office, named.spot),
  }));
  const walks: Walk[] = places.flatMap((from) =>
    places
      .filter((to) => to.roomId !== from.roomId)
      .map((to) => ({ from, to, path: nav.findPath(from.spot, to.spot) })),
  );
  return { office, nav, plan, walks, measureClearance: builder.measureClearance };
}

/** Returns a walk's name for a failure message. */
function nameWalk(walk: Walk): string {
  return `${walk.from.name} -> ${walk.to.name}`;
}

/**
 * Returns points `SAMPLE_STEP` apart along each leg of a walk's path, both
 * ends of every leg included. When `isOnGrid` is false for one of the walk's
 * spots, the leg that joins that spot to the rest of the path is left out:
 * the spot stands inside an obstacle, such as a chair inside its desk's
 * footprint, so that short step has to cross the obstacle's edge.
 */
function* sampleLegs(
  walk: Walk,
  isOnGrid: (spot: Spot) => boolean,
): Generator<{ readonly x: number; readonly z: number }> {
  const path = walk.path ?? [];
  const firstLeg = isOnGrid(walk.from.spot) ? 0 : 1;
  const lastLeg = isOnGrid(walk.to.spot) ? path.length - 2 : path.length - 3;
  for (let leg = firstLeg; leg <= lastLeg; leg++) {
    const start = path[leg]!.position;
    const end = path[leg + 1]!.position;
    const steps = Math.max(1, Math.ceil(start.distanceTo(end) / SAMPLE_STEP));
    for (let step = 0; step <= steps; step++) {
      yield {
        x: start.x + ((end.x - start.x) * step) / steps,
        z: start.z + ((end.z - start.z) * step) / steps,
      };
    }
  }
}

describe("the Office's walking paths on the Bureau", () => {
  let bureau: ReturnType<typeof buildBureauWalks>;

  beforeAll(() => {
    stubCanvasAndFonts();
    bureau = buildBureauWalks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  /** Returns true when the walking grid lets a body stand at the spot. */
  const isOnGrid = (spot: Spot): boolean => bureau.nav.isWalkable(spot);

  it("starts and ends every path exactly at its two spots, even at a desk chair inside its desk", () => {
    // The chair stands inside the desk's footprint, so the grid has no room for a body there.
    expect(isOnGrid(bureau.office.homes.get("s-web-1")!)).toBe(false);
    const wrong: string[] = [];
    for (const walk of bureau.walks) {
      const first = walk.path?.[0]?.position;
      const last = walk.path?.at(-1)?.position;
      if (first === undefined || last === undefined) wrong.push(`${nameWalk(walk)}: no path`);
      else if (!first.equals(walk.from.spot.position) || !last.equals(walk.to.spot.position)) {
        wrong.push(`${nameWalk(walk)}: from (${first.x}, ${first.z}) to (${last.x}, ${last.z})`);
      }
    }
    expect(bureau.walks.length).toBeGreaterThan(300);
    expect(wrong).toEqual([]);
  });

  it("keeps every leg at least BODY_CLEARANCE from the walls and the furniture", () => {
    const tooClose: string[] = [];
    for (const walk of bureau.walks) {
      for (const { x, z } of sampleLegs(walk, isOnGrid)) {
        const clearance = bureau.measureClearance(x, z);
        const onGrid = isOnGrid({ position: new Vector3(x, 0, z), facing: 0, floor: 0 });
        if (clearance < BODY_CLEARANCE || !onGrid) {
          tooClose.push(
            `${nameWalk(walk)}: ${clearance.toFixed(3)} m at (${x.toFixed(2)}, ${z.toFixed(2)})`,
          );
          break;
        }
      }
    }
    expect(tooClose).toEqual([]);
  });

  /**
   * Returns the points along a walk's legs that lie in the Gallery but not in
   * front of one of its doors, along the door's wall. In front of a door a
   * path turns in or out, so it comes close to the walls there by design.
   */
  function* sampleGalleryLegs(walk: Walk): Generator<{ readonly x: number; readonly z: number }> {
    const gallery = bureau.plan.rooms.find((room) => room.id === HALL_IDS.gallery)!.rect;
    const doors = bureau.plan.walls
      .filter((wall) => wall.ownerId === HALL_IDS.gallery || wall.otherId === HALL_IDS.gallery)
      .flatMap((wall) => wall.doors.map((door) => ({ axis: wall.axis, ...door })));
    for (const point of sampleLegs(walk, isOnGrid)) {
      const { x, z } = point;
      const inGallery =
        x > gallery.minX && x < gallery.maxX && z > gallery.minZ && z < gallery.maxZ;
      const inFrontOfDoor = doors.some(
        (door) => Math.abs((door.axis === "x" ? x : z) - door.at) < door.width / 2,
      );
      if (inGallery && !inFrontOfDoor) yield point;
    }
  }

  it("keeps every leg in the Gallery at most LEG_SLACK closer to its walls than the search's cells, away from its doors", () => {
    const tooClose: string[] = [];
    let checked = 0;
    for (const walk of bureau.walks) {
      let nearest = { clearance: Infinity, x: 0, z: 0 };
      for (const { x, z } of sampleGalleryLegs(walk)) {
        checked++;
        const clearance = bureau.measureClearance(x, z);
        if (clearance < nearest.clearance) nearest = { clearance, x, z };
      }
      if (nearest.clearance < GALLERY_LEG_CLEARANCE) {
        tooClose.push(
          `${nameWalk(walk)}: ${nearest.clearance.toFixed(3)} m at (${nearest.x.toFixed(2)}, ${nearest.z.toFixed(2)})`,
        );
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(tooClose).toEqual([]);
  });

  it("walks at most 1 m of the Gallery closer than 0.5 m to a wall, away from its doors", () => {
    // A leg out of a door that kept the door's narrow clearance all the way
    // down the Gallery would run metres of it this close to a wall.
    const closeDistance = 0.5;
    const longestCloseStretch = 1;
    const tooLong: string[] = [];
    for (const walk of bureau.walks) {
      let closeLength = 0;
      for (const { x, z } of sampleGalleryLegs(walk)) {
        if (bureau.measureClearance(x, z) < closeDistance) closeLength += SAMPLE_STEP;
      }
      if (closeLength > longestCloseStretch) {
        tooLong.push(`${nameWalk(walk)}: ${closeLength.toFixed(2)} m`);
      }
    }
    expect(tooLong).toEqual([]);
  });

  it("crosses a door too narrow for COMFORT_CLEARANCE in the middle third of its width", () => {
    // Such a door cannot leave COMFORT_CLEARANCE on both sides of a path, so
    // the best a path can do is to keep to its middle. The middle third is a
    // judgment. It leaves room for the grid, whose cells need not line up
    // with the door, and for the slack a straight leg is allowed. It still
    // fails a path that keeps only BODY_CLEARANCE, which may cross a 1 m door
    // anywhere in its middle 0.4 m.
    const offCentre: string[] = [];
    let crossings = 0;
    for (const walk of bureau.walks) {
      const path = walk.path ?? [];
      for (let leg = 0; leg < path.length - 1; leg++) {
        const start = path[leg]!.position;
        const end = path[leg + 1]!.position;
        for (const wall of bureau.plan.walls) {
          const [startAlong, startAcross] =
            wall.axis === "x" ? [start.x, start.z] : [start.z, start.x];
          const [endAlong, endAcross] = wall.axis === "x" ? [end.x, end.z] : [end.z, end.x];
          if (startAcross < wall.line === endAcross < wall.line) continue;
          const along =
            startAlong +
            ((endAlong - startAlong) * (wall.line - startAcross)) / (endAcross - startAcross);
          for (const door of wall.doors) {
            if (door.width >= 2 * COMFORT_CLEARANCE) continue;
            const offset = along - door.at;
            if (Math.abs(offset) > door.width / 2) continue;
            crossings++;
            const fromNearerJamb = door.width / 2 - Math.abs(offset);
            if (fromNearerJamb < door.width / 3) {
              offCentre.push(
                `${nameWalk(walk)}: ${fromNearerJamb.toFixed(3)} m from a jamb of the door at ${door.at.toFixed(2)}`,
              );
            }
          }
        }
      }
    }
    expect(crossings).toBeGreaterThan(0);
    expect(offCentre).toEqual([]);
  });
});
