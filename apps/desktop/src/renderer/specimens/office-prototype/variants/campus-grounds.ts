/**
 * PROTOTYPE - the campus grounds: a pale lawn on a stepped plinth, the paved
 * plaza with four low planted beds round a fountain, benches along the
 * avenue, the paths to every door, lampposts, trees, and the pneumatic tubes
 * that run from the pavilions behind each row to the Case Room.
 *
 * The site is a diorama: the lawn stops at a paved terrace, and the terrace
 * stands on a base, so the overview shows a clean edge round the campus.
 * Outdoors the tubes lie on a low stone kerb, so they read as one quiet line
 * rather than a fence of posts; they climb the headquarters' wall to enter.
 *
 * The trees are merged into one mesh per material once they are placed,
 * because a park of separate trees would cost three draw calls each.
 */
import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Group,
  LatheGeometry,
  Mesh,
  Object3D,
  PlaneGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
  type Material,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { WALL_HEIGHT } from "../engine/contracts";
import { paint } from "../engine/palette";
import {
  buildLamppost,
  buildPath,
  buildTree,
  buildTubes,
  type TubeHandle,
} from "../kit/architecture";
import { paintMix } from "../kit/architecture-shared";
import { buildBench } from "../kit/props";
import { centreRect, type NavPlan, type Rect } from "./campus-kit";

/** The height the tubes cross into the headquarters at: just over the wall tops, so they never pass through a wall. */
const TUBE_HEIGHT = WALL_HEIGHT + 0.2;
/** The height the tubes run at outdoors, resting on their kerb. */
const TUBE_LOW = 0.2;
/** The kerb under the outdoor tubes: its top meets the underside of the tube, whose radius is 0.042. */
const KERB_HEIGHT = TUBE_LOW - 0.04;
const KERB_WIDTH = 0.18;
/** How far a row's trunk runs behind the back wall of the row's widest pavilion. */
export const TRUNK_OFFSET = 0.8;
/** How far a tube that climbs a wall stands off the wall's centre line. */
const WALL_STANDOFF = 0.2;
/** The perimeter walk round the plaza, between its edge and the beds. */
const PLAZA_WALK = 2.0;
/** The width of the avenue down the middle and of the cross walk at the fountain. */
const AVENUE = 4.4;
/** How far the planted beds stand above the paving. */
const BED_HEIGHT = 0.15;
/** The width of a door's path. */
const DOOR_PATH = 1.8;
/** The width of one mown stripe on the lawn. */
const STRIPE = 1.4;
/** The width of the paved terrace round the lawn: the plinth's upper step. */
const TERRACE = 0.7;
/** How far the plinth's lower step reaches past the terrace. */
const LOWER_STEP = 0.3;
/** How far the plinth reaches past the lawn on every side. */
export const PLINTH_REACH = TERRACE + LOWER_STEP;

/** One pavilion as the grounds see it: its footprint and its door on the plaza. */
export interface GroundsPavilion {
  readonly rect: Rect;
  readonly door: Vector3;
}

/** What the grounds are laid out round. */
export interface GroundsPlan {
  /** The paved plaza, from the headquarters' facade south. */
  readonly plaza: Rect;
  /** Where the parterres begin, south of the forecourt in front of the headquarters. */
  readonly gardenNorth: number;
  /** The lawn the whole campus stands on. */
  readonly site: Rect;
  readonly west: ReadonlyArray<GroundsPavilion>;
  readonly east: ReadonlyArray<GroundsPavilion>;
  readonly headquarters: Rect;
  readonly conservatory: Rect;
  readonly conservatoryDoor: Vector3;
  /** Where the tubes end, just above the receiving cabinet. */
  readonly receiver: Vector3;
}

/** The grounds, built. */
export interface Grounds {
  readonly object: Object3D;
  /** The tubes a capsule can be sent through, one per row of pavilions. */
  readonly trunks: ReadonlyArray<TubeHandle>;
  /** Every trunk, branch and the kerb under them, which the Event flow switch shows or hides. */
  readonly tubes: ReadonlyArray<Object3D>;
}

/** Returns a number in [0, 1) that depends only on two integers, for repeatable scatter. */
function hashCell(a: number, b: number): number {
  let value = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b ^ 0xc2b2ae35, 0x27d4eb2f);
  value = Math.imul(value ^ (value >>> 15), 0x2c1b3c6d);
  value ^= value >>> 12;
  return (value >>> 0) / 4294967296;
}

/** Returns whether a point lies inside a rectangle grown by `margin`. */
function isInside(rect: Rect, x: number, z: number, margin: number): boolean {
  return (
    x > rect.minX - margin &&
    x < rect.maxX + margin &&
    z > rect.minZ - margin &&
    z < rect.maxZ + margin
  );
}

/** Returns the distance on the ground from a point to the segment from `a` to `b`. */
function measureSegmentDistance(x: number, z: number, a: Vector3, b: Vector3): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = dx * dx + dz * dz;
  const share =
    length === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / length));
  return Math.hypot(x - (a.x + share * dx), z - (a.z + share * dz));
}

/**
 * Merges every mesh under `objects` into one mesh per material, in world
 * space, and returns them in a group. The source geometries are disposed;
 * the materials are the palette's, shared, and are kept.
 */
function mergeByMaterial(objects: ReadonlyArray<Object3D>): Object3D {
  const byMaterial = new Map<Material, { parts: BufferGeometry[]; cast: boolean }>();
  for (const object of objects) {
    object.updateMatrixWorld(true);
    object.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh || Array.isArray(mesh.material)) return;
      const material = mesh.material;
      const entry = byMaterial.get(material) ?? { parts: [], cast: false };
      const geometry =
        mesh.geometry.index === null ? mesh.geometry.clone() : mesh.geometry.toNonIndexed();
      geometry.applyMatrix4(mesh.matrixWorld);
      for (const name of Object.keys(geometry.attributes)) {
        if (name !== "position" && name !== "normal") geometry.deleteAttribute(name);
      }
      entry.parts.push(geometry);
      entry.cast ||= mesh.castShadow;
      byMaterial.set(material, entry);
      mesh.geometry.dispose();
    });
  }
  const group = new Group();
  for (const [material, { parts, cast }] of byMaterial) {
    const merged = mergeGeometries(parts);
    for (const part of parts) part.dispose();
    if (merged === null) continue;
    const mesh = new Mesh(merged, material);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

/**
 * Builds the Deco fountain: an octagonal stone basin of still water with a
 * brass lip, and a stepped column carrying a shallow bowl and a brass finial.
 * Its origin is on the ground at its centre; it is 3 across.
 */
function buildFountain(): Object3D {
  const object = new Group();
  const stone = paint("room-panel", "satin");
  const stoneDark = paint("room-panel", "satin", { dl: -0.06 });
  const basinProfile = [
    [0, 0],
    [1.5, 0],
    [1.5, 0.36],
    [1.56, 0.4],
    [1.56, 0.46],
    [1.36, 0.46],
    [1.36, 0.12],
    [0, 0.12],
  ].map(([x, y]) => new Vector2(x, y));
  const basin = new Mesh(new LatheGeometry(basinProfile, 8), stone);
  const water = new Mesh(
    new CylinderGeometry(1.37, 1.37, 0.02, 8),
    paint("room-screen", "gloss", { dl: 0.16, dc: 0.02 }),
  );
  water.position.y = 0.34;
  const lip = new Mesh(new TorusGeometry(1.46, 0.02, 6, 8), paint("brass", "brass"));
  lip.rotation.x = -Math.PI / 2;
  lip.position.y = 0.465;
  const columnProfile = [
    [0, 0.1],
    [0.5, 0.1],
    [0.5, 0.42],
    [0.36, 0.42],
    [0.36, 0.62],
    [0.24, 0.62],
    [0.2, 1.08],
    [0.62, 1.16],
    [0.66, 1.24],
    [0.56, 1.26],
    [0.12, 1.2],
    [0.1, 1.36],
    [0, 1.36],
  ].map(([x, y]) => new Vector2(x, y));
  const column = new Mesh(new LatheGeometry(columnProfile, 8), stoneDark);
  const bowlWater = new Mesh(
    new CylinderGeometry(0.55, 0.55, 0.02, 8),
    paint("room-screen", "gloss", { dl: 0.16, dc: 0.02 }),
  );
  bowlWater.position.y = 1.235;
  const finial = new Mesh(new SphereGeometry(0.075, 16, 10), paint("brass", "brass"));
  finial.position.y = 1.43;
  const band = new Mesh(new TorusGeometry(0.36, 0.018, 6, 8), paint("brass", "brass"));
  band.rotation.x = -Math.PI / 2;
  band.position.y = 0.62;
  for (const mesh of [basin, column, finial]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  }
  water.receiveShadow = true;
  bowlWater.receiveShadow = true;
  object.add(basin, water, lip, column, bowlWater, finial, band);
  return object;
}

/**
 * Merges `parts` into one mesh of `material` and disposes the parts. Returns
 * null when there are no parts. Every part must have the same attributes and
 * all or none of them an index.
 */
function mergeParts(
  parts: ReadonlyArray<BufferGeometry>,
  material: Material,
  castShadow: boolean,
): Mesh | null {
  if (parts.length === 0) return null;
  const merged = mergeGeometries([...parts]);
  for (const part of parts) part.dispose();
  if (merged === null) return null;
  const mesh = new Mesh(merged, material);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Builds the site's lawn, `width` by `depth` and centred on the origin, its
 * top at y = 0: mown stripes in two pale greens on a turf slab 0.12 deep.
 * The kit's lawn is greener, and over a whole site that much green reads as
 * a game board, so the campus leans its greens further toward the floor's
 * colour.
 */
function buildSiteLawn(width: number, depth: number): Object3D {
  const object = new Group();
  const count = Math.max(1, Math.round(width / STRIPE));
  const stripe = width / count;
  const stripes: [BufferGeometry[], BufferGeometry[]] = [[], []];
  for (let index = 0; index < count; index++) {
    const x = -width / 2 + (index + 0.5) * stripe;
    stripes[index % 2]!.push(
      new PlaneGeometry(stripe, depth).rotateX(-Math.PI / 2).translate(x, 0, 0),
    );
  }
  const tones = [
    paintMix("room-plant", "room-floor", 0.5, "matte"),
    paintMix("room-plant", "room-floor", 0.56, "matte"),
  ];
  stripes.forEach((parts, tone) => {
    const mesh = mergeParts(parts, tones[tone]!, false);
    if (mesh !== null) object.add(mesh);
  });
  const turf = new Mesh(
    new BoxGeometry(width, 0.12, depth),
    paintMix("room-plant", "room-floor", 0.42, "matte"),
  );
  // The turf's top sits a hair under the stripes, so the two never fight over a pixel.
  turf.position.y = -0.064;
  turf.receiveShadow = true;
  object.add(turf);
  return object;
}

/**
 * Builds the plinth the lawn of `site` stands on, in two steps: a paved
 * terrace `TERRACE` wide round the lawn, its top 0.12 under the lawn's, and
 * under it a base that reaches `LOWER_STEP` further.
 */
function buildPlinth(site: Rect): Object3D {
  const object = new Group();
  const width = site.maxX - site.minX;
  const depth = site.maxZ - site.minZ;
  const x = (site.minX + site.maxX) / 2;
  const z = (site.minZ + site.maxZ) / 2;
  const terrace = new Mesh(
    new RoundedBoxGeometry(width + 2 * TERRACE, 0.24, depth + 2 * TERRACE, 2, 0.05),
    paint("room-floor", "satin"),
  );
  terrace.position.set(x, -0.14 - 0.12, z);
  const base = new Mesh(
    new RoundedBoxGeometry(width + 2 * PLINTH_REACH, 0.5, depth + 2 * PLINTH_REACH, 2, 0.06),
    paint("room-wall", "satin", { dl: -0.08 }),
  );
  base.position.set(x, -0.38 - 0.25, z);
  for (const step of [terrace, base]) {
    step.receiveShadow = true;
    object.add(step);
  }
  return object;
}

/** The radius of a clipped ball of box on a bed. */
const TOPIARY_RADIUS = 0.42;
/** The spacing of the grid the shrubs on a bed are scattered from. */
const SHRUB_SPACING = 0.8;
/** The share of a bed's grid cells that hold a shrub. */
const SHRUB_FILL = 0.78;
/** How far in from its edge a bed is planted; a wide bed keeps a plain panel of turf in its middle. */
const SHRUB_BORDER = 1.4;

/**
 * Builds the garden's planted beds as one group of four meshes:
 *
 * - each rectangle in `rects` as a low turf bed `BED_HEIGHT` high, with a
 *   soft rounded edge;
 * - its planting, low mounded shrubs in three greens scattered in a band
 *   `SHRUB_BORDER` wide round its edge, which keep clear of the edge itself
 *   and of the points in `clear`, where trees and balls stand;
 * - a clipped ball of box at each point of `topiaries`.
 */
function buildBeds(
  rects: ReadonlyArray<Rect>,
  topiaries: ReadonlyArray<readonly [number, number]>,
  clear: ReadonlyArray<readonly [number, number]>,
): Object3D {
  const object = new Group();
  const beds: BufferGeometry[] = [];
  const shrubs: [BufferGeometry[], BufferGeometry[], BufferGeometry[]] = [[], [], []];
  for (const rect of rects) {
    const width = rect.maxX - rect.minX;
    const depth = rect.maxZ - rect.minZ;
    // The bed reaches a little under the paving, so its rounded foot never shows a gap.
    beds.push(
      new RoundedBoxGeometry(width, BED_HEIGHT + 0.05, depth, 3, 0.08).translate(
        (rect.minX + rect.maxX) / 2,
        (BED_HEIGHT - 0.05) / 2,
        (rect.minZ + rect.maxZ) / 2,
      ),
    );
    const fromX = Math.floor(rect.minX / SHRUB_SPACING);
    const fromZ = Math.floor(rect.minZ / SHRUB_SPACING);
    for (let gx = fromX; gx * SHRUB_SPACING < rect.maxX; gx++) {
      for (let gz = fromZ; gz * SHRUB_SPACING < rect.maxZ; gz++) {
        if (hashCell(gx + 17, gz - 5) > SHRUB_FILL) continue;
        const radius = 0.16 + hashCell(gz + 3, gx + 11) * 0.2;
        const x = (gx + 0.5) * SHRUB_SPACING + (hashCell(gx, gz + 7) - 0.5) * 0.4;
        const z = (gz + 0.5) * SHRUB_SPACING + (hashCell(gz - 9, gx) - 0.5) * 0.4;
        if (!isInside(rect, x, z, -(radius + 0.1))) continue;
        if (isInside(rect, x, z, -SHRUB_BORDER)) continue;
        if (clear.some(([cx, cz]) => Math.hypot(cx - x, cz - z) < 0.5 + radius)) continue;
        // A mound: a sphere pressed flat and sunk half its radius into the bed.
        shrubs[Math.floor(hashCell(gx - 23, gz + 29) * 3) % 3]!.push(
          new SphereGeometry(radius, 10, 7)
            .scale(1, 0.75, 1)
            .translate(x, BED_HEIGHT + radius * 0.25, z),
        );
      }
    }
  }
  for (const [x, z] of topiaries) {
    shrubs[0].push(
      new SphereGeometry(TOPIARY_RADIUS, 18, 12).translate(
        x,
        BED_HEIGHT + TOPIARY_RADIUS * 0.92,
        z,
      ),
    );
  }
  const meshes = [
    mergeParts(beds, paintMix("room-plant", "room-floor", 0.36, "matte"), false),
    mergeParts(shrubs[0], paintMix("room-plant", "room-floor", 0.14, "satin"), true),
    mergeParts(shrubs[1], paintMix("room-plant", "room-floor", 0.24, "satin"), true),
    mergeParts(shrubs[2], paintMix("room-plant", "room-floor", 0.06, "satin"), true),
  ];
  for (const mesh of meshes) if (mesh !== null) object.add(mesh);
  return object;
}

/**
 * Builds the low stone kerb the outdoor tubes rest on, as one mesh: one
 * straight length under each run in `runs`, a little longer than the run so
 * the lengths meet square at the corners. Returns null when there are no runs.
 */
function buildTubeKerb(runs: ReadonlyArray<readonly [Vector3, Vector3]>): Mesh | null {
  const parts: BufferGeometry[] = [];
  for (const [from, to] of runs) {
    const width = Math.abs(to.x - from.x) + KERB_WIDTH;
    const depth = Math.abs(to.z - from.z) + KERB_WIDTH;
    parts.push(
      new BoxGeometry(width, KERB_HEIGHT, depth).translate(
        (from.x + to.x) / 2,
        KERB_HEIGHT / 2,
        (from.z + to.z) / 2,
      ),
    );
  }
  return mergeParts(parts, paint("room-floor", "satin", { dl: -0.06 }), true);
}

/**
 * Builds a row's tubes: a trunk from the farthest pavilion's back wall
 * along the back of the row to the headquarters, up its outside wall, in
 * over the wall and down to the receiver; and a branch from every other
 * pavilion's back wall to the trunk. Returns the trunk, which carries the
 * capsules, the branches, which only show the row is connected, and every
 * stretch the tubes run low over the ground, which needs a kerb and blocks
 * the way.
 */
function buildRowTubes(
  row: ReadonlyArray<GroundsPavilion>,
  side: "west" | "east",
  plan: GroundsPlan,
): {
  readonly trunk: TubeHandle;
  readonly branches: ReadonlyArray<TubeHandle>;
  readonly lowRuns: ReadonlyArray<readonly [Vector3, Vector3]>;
} | null {
  if (row.length === 0) return null;
  const west = side === "west";
  const backX = (rect: Rect) => (west ? rect.minX - 0.07 : rect.maxX + 0.07);
  const trunkX = west
    ? Math.min(...row.map((pavilion) => pavilion.rect.minX)) - TRUNK_OFFSET
    : Math.max(...row.map((pavilion) => pavilion.rect.maxX)) + TRUNK_OFFSET;
  const farthest = row.reduce((most, pavilion) =>
    pavilion.rect.maxZ > most.rect.maxZ ? pavilion : most,
  );
  const startZ = (farthest.rect.minZ + farthest.rect.maxZ) / 2;
  const { receiver, headquarters } = plan;
  const dropX = receiver.x + (west ? -0.11 : 0.11);
  const low = [
    new Vector3(backX(farthest.rect), TUBE_LOW, startZ),
    new Vector3(trunkX, TUBE_LOW, startZ),
  ];
  // The west trunk climbs the headquarters' west wall; the east trunk runs round to its north wall.
  const foot = west
    ? new Vector3(headquarters.minX - WALL_STANDOFF, TUBE_LOW, receiver.z)
    : new Vector3(dropX, TUBE_LOW, headquarters.minZ - WALL_STANDOFF);
  low.push(new Vector3(trunkX, TUBE_LOW, foot.z), foot);
  const trunk = buildTubes([
    ...low,
    new Vector3(foot.x, TUBE_HEIGHT, foot.z),
    new Vector3(dropX, TUBE_HEIGHT, receiver.z),
    new Vector3(dropX, receiver.y, receiver.z),
  ]);
  const lowRuns: Array<readonly [Vector3, Vector3]> = [];
  for (let index = 0; index < low.length - 1; index++) lowRuns.push([low[index]!, low[index + 1]!]);
  const branches = row
    .filter((pavilion) => pavilion !== farthest)
    .map((pavilion) => {
      const z = (pavilion.rect.minZ + pavilion.rect.maxZ) / 2;
      const run = [
        new Vector3(backX(pavilion.rect), TUBE_LOW, z),
        new Vector3(trunkX, TUBE_LOW, z),
      ] as const;
      lowRuns.push(run);
      return buildTubes(run);
    });
  return { trunk, branches, lowRuns };
}

/**
 * Builds the grounds round the buildings and blocks their solid parts in the
 * nav plan: the beds, the fountain, the benches, the lampposts, the low
 * tubes and the trees' trunks.
 */
export function buildGrounds(plan: GroundsPlan, nav: NavPlan): Grounds {
  const object = new Group();
  object.name = "grounds";
  const { plaza, site } = plan;

  // The diorama's plinth, and the lawn on it a little below the buildings' floors.
  object.add(buildPlinth(site));
  const lawn = buildSiteLawn(site.maxX - site.minX, site.maxZ - site.minZ);
  lawn.position.set((site.minX + site.maxX) / 2, -0.02, (site.minZ + site.maxZ) / 2);
  object.add(lawn);

  // The plaza's paving, and the paths to the doors.
  const plazaWidth = plaza.maxX - plaza.minX;
  const plazaDepth = plaza.maxZ - plaza.minZ;
  const paving = buildPath(plazaWidth, plazaDepth);
  paving.position.set((plaza.minX + plaza.maxX) / 2, 0, (plaza.minZ + plaza.maxZ) / 2);
  object.add(paving);
  const pathRects: Rect[] = [];
  for (const pavilion of [...plan.west, ...plan.east]) {
    const fromX = pavilion.door.x;
    const toX = pavilion.door.x < 0 ? plaza.minX : plaza.maxX;
    const length = Math.abs(toX - fromX);
    if (length < 0.05) continue;
    const path = buildPath(DOOR_PATH, length + 0.1);
    path.rotation.y = Math.PI / 2;
    path.position.set((fromX + toX) / 2, 0, pavilion.door.z);
    object.add(path);
    pathRects.push(centreRect((fromX + toX) / 2, pavilion.door.z, length, DOOR_PATH));
  }
  const conservatoryPathLength = plan.conservatoryDoor.z - plaza.maxZ;
  if (conservatoryPathLength > 0.05) {
    const path = buildPath(2.4, conservatoryPathLength + 0.1);
    path.position.set(0, 0, (plaza.maxZ + plan.conservatoryDoor.z) / 2);
    object.add(path);
    pathRects.push(
      centreRect(0, (plaza.maxZ + plan.conservatoryDoor.z) / 2, 2.4, conservatoryPathLength),
    );
  }

  // The garden: four planted beds round the fountain, split by the avenue and the cross walk.
  const gardenSouth = plaza.maxZ - PLAZA_WALK;
  const crossZ = (plan.gardenNorth + gardenSouth) / 2;
  const innerX = AVENUE / 2;
  const outerX = plazaWidth / 2 - PLAZA_WALK;
  const parterres: Rect[] = [];
  if (outerX - innerX > 1.2) {
    for (const [minX, maxX] of [
      [-outerX, -innerX],
      [innerX, outerX],
    ] as const) {
      for (const [minZ, maxZ] of [
        [plan.gardenNorth, crossZ - AVENUE / 2],
        [crossZ + AVENUE / 2, gardenSouth],
      ] as const) {
        if (maxZ - minZ > 1.2) parterres.push({ minX, maxX, minZ, maxZ });
      }
    }
  }
  for (const rect of parterres) nav.block(rect);
  const fountain = buildFountain();
  fountain.position.set(0, 0, crossZ);
  object.add(fountain);
  nav.blockObject(fountain, 0.05);

  // Benches along the avenue, their backs to the beds, about one every nine metres.
  for (const rect of parterres) {
    const west = rect.maxX <= 0;
    const length = rect.maxZ - rect.minZ;
    const count = Math.max(1, Math.round(length / 9));
    for (let index = 0; index < count; index++) {
      const bench = buildBench(3).object;
      bench.position.set(
        west ? rect.maxX + 0.36 : rect.minX - 0.36,
        0,
        rect.minZ + ((index + 0.5) / count) * length,
      );
      bench.rotation.y = west ? Math.PI / 2 : -Math.PI / 2;
      object.add(bench);
      nav.blockObject(bench, 0.02);
    }
  }

  // Six lampposts, each a point light at dusk, so only a few: round the fountain and by the front door.
  const lampSpots: Array<readonly [number, number]> = [
    [-innerX - 0.35, crossZ - AVENUE / 2 - 0.35],
    [innerX + 0.35, crossZ - AVENUE / 2 - 0.35],
    [-innerX - 0.35, crossZ + AVENUE / 2 + 0.35],
    [innerX + 0.35, crossZ + AVENUE / 2 + 0.35],
    [-2.6, plaza.minZ + 1.0],
    [2.6, plaza.minZ + 1.0],
  ];
  for (const [x, z] of lampSpots) {
    const lamppost = buildLamppost();
    lamppost.position.set(x, 0, z);
    object.add(lamppost);
    nav.block(centreRect(x, z, 0.3, 0.3));
  }

  // The tubes, behind each row, low on their kerb; nobody steps over them.
  const tubes = [
    buildRowTubes(plan.west, "west", plan),
    buildRowTubes(plan.east, "east", plan),
  ].filter((row) => row !== null);
  const tubeLines = tubes.flatMap((row) => row.lowRuns);
  const tubeObjects = tubes.flatMap((row) => [
    row.trunk.object,
    ...row.branches.map((branch) => branch.object),
  ]);
  const kerb = buildTubeKerb(tubeLines);
  if (kerb !== null) tubeObjects.push(kerb);
  for (const tube of tubeObjects) object.add(tube);
  for (const [from, to] of tubeLines) {
    nav.block({
      minX: Math.min(from.x, to.x) - 0.12,
      maxX: Math.max(from.x, to.x) + 0.12,
      minZ: Math.min(from.z, to.z) - 0.12,
      maxZ: Math.max(from.z, to.z) + 0.12,
    });
  }

  // Trees: avenues along the parterres, and a park scattered over the rest of the lawn.
  const trees: Object3D[] = [];
  const alleeTrees: Array<readonly [number, number]> = [];
  const plantTree = (x: number, z: number, block: boolean) => {
    const tree = buildTree();
    tree.position.set(x, 0, z);
    trees.push(tree);
    if (block) nav.block(centreRect(x, z, 0.35, 0.35));
  };
  for (const rect of parterres) {
    const nearAvenue = rect.minX > 0 ? rect.minX + 0.9 : rect.maxX - 0.9;
    const nearCross = rect.minZ > crossZ ? rect.minZ : rect.maxZ;
    const farCross = rect.minZ > crossZ ? rect.maxZ : rect.minZ;
    const length = Math.abs(farCross - nearCross) - 1.8;
    const count = Math.max(1, Math.floor(length / 4.2) + 1);
    for (let index = 0; index < count; index++) {
      const share = count === 1 ? 1 : index / (count - 1);
      const z = farCross + Math.sign(nearCross - farCross) * (0.9 + share * length);
      // The tree nearest the fountain gives way to its lamppost.
      if (Math.abs(z - nearCross) < 1.6) continue;
      plantTree(nearAvenue, z, false);
      alleeTrees.push([nearAvenue, z]);
    }
  }
  // Topiary balls down the middle of each bed, about one every seven metres, clear of its trees.
  const topiaries: Array<readonly [number, number]> = [];
  for (const rect of parterres) {
    const x = (rect.minX + rect.maxX) / 2;
    const length = rect.maxZ - rect.minZ;
    const count = Math.max(1, Math.round(length / 7));
    for (let index = 0; index < count; index++) {
      const z = rect.minZ + ((index + 0.5) / count) * length;
      if (alleeTrees.some(([tx, tz]) => Math.hypot(tx - x, tz - z) < 1.4)) continue;
      topiaries.push([x, z]);
    }
  }
  object.add(buildBeds(parterres, topiaries, [...alleeTrees, ...topiaries]));
  const buildings = [
    plan.headquarters,
    plan.conservatory,
    ...[...plan.west, ...plan.east].map((p) => p.rect),
  ];
  const spacing = 4;
  for (let gx = Math.floor(site.minX / spacing); gx * spacing < site.maxX; gx++) {
    for (let gz = Math.floor(site.minZ / spacing); gz * spacing < site.maxZ; gz++) {
      if (hashCell(gx, gz) > 0.62) continue;
      const x = (gx + 0.5) * spacing + (hashCell(gz, gx) - 0.5) * 2.2;
      const z = (gz + 0.5) * spacing + (hashCell(gx + 101, gz - 37) - 0.5) * 2.2;
      if (!isInside(site, x, z, -1.3)) continue;
      if (buildings.some((rect) => isInside(rect, x, z, 1.7))) continue;
      if (isInside(plaza, x, z, 1.3)) continue;
      if (pathRects.some((rect) => isInside(rect, x, z, 1.1))) continue;
      if (tubeLines.some(([a, b]) => measureSegmentDistance(x, z, a, b) < 1.5)) continue;
      plantTree(x, z, true);
    }
  }
  object.add(mergeByMaterial(trees));

  return { object, trunks: tubes.map((row) => row.trunk), tubes: tubeObjects };
}
