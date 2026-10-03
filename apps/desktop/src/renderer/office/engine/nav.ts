/**
 * Walking through the office: a grid per storey, A* over it, and
 * string pulling, so a path is a few straight legs around the furniture.
 *
 * A layout declares each storey's floor, marks walls and furniture as solid,
 * and opens doors through the walls. `build()` then
 * turns that into one grid per storey whose free cells are the places where a
 * colleague's body centre may be: every cell knows how far it is from the
 * nearest solid cell, and only cells a body's half width away are free, so a
 * path that keeps to free cells never clips a wall or a desk.
 *
 * Paths start and end exactly at the spots asked for, even when a spot sits
 * inside an obstacle (a chair behind a desk): the walker steps from the spot
 * to the nearest free cell, walks, and steps onto the goal at the end.
 */
import { Box3, Vector3, type Object3D } from "three";
import type { NavBuilder, NavGraph, Spot, Waypoint } from "./contracts";

/** The side of one grid cell, in metres. */
const CELL_SIZE = 0.12;
/**
 * How far a body centre keeps from walls and furniture: a colleague's half
 * width, about 0.3 m for the widest body shape, so a body passing a door
 * jamb or a wall's corner never sinks into it.
 */
const BODY_CLEARANCE = 0.3;
/**
 * How far a path keeps from walls and furniture where there is room to: a
 * quarter metre more than a body needs, so colleagues walk down the middle
 * of a corridor or a door instead of brushing past its walls.
 */
const COMFORT_CLEARANCE = 0.55;
/**
 * How much more a step costs in the search at `BODY_CLEARANCE` than at
 * `COMFORT_CLEARANCE`, as a multiple of a step's length; between the two
 * the extra cost falls off linearly.
 */
const NEAR_WALL_COST = 2;
/**
 * How much closer to walls and furniture a straight leg may run than the
 * cells it replaces. Around a corner the search's cells follow a curve, and
 * a straight chord across that curve always runs a little closer; without
 * this slack the string keeps a corner every cell or two.
 */
const LEG_SLACK = 0.1;
/** How far from a spot the nearest free cell may be, in metres. */
const NEAREST_FREE_RADIUS = 1.6;
/** Free areas smaller than this many cells are pockets (between a desk and a wall), never a start. */
const POCKET_CELLS = 40;
/** How much the search's distance estimate is weighted, see `searchCells`. */
const HEURISTIC_WEIGHT = 1.5;
const SQRT2 = Math.SQRT2;
/** The clearance of a cell with no solid cell anywhere on its storey, in metres. */
const FAR_CLEARANCE = 1e6;

/** What the nav graph offers beyond the contract, for the sim. */
export interface OfficeNavGraph extends NavGraph {
  /** Returns true when a colleague can stand at the spot without touching a wall or furniture. */
  isWalkable(spot: Spot): boolean;
  /**
   * Keeps later paths out of a disc around a colleague standing still, such
   * as one waiting in the queue, so nobody walks through it. Paths fall back
   * to ignoring these discs when no way around exists. Returns the function
   * that frees the disc again.
   */
  occupy(floor: number, position: Vector3, radius: number): () => void;
}

/** Returns true when the graph is this module's, with the sim's extra probes. */
export function isOfficeNavGraph(nav: NavGraph): nav is OfficeNavGraph {
  return "isWalkable" in nav && "occupy" in nav;
}

interface Rect {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

/** One `block` or `open` call, replayed in call order at `build()`. */
interface Mark {
  readonly solid: boolean;
  readonly rect: Rect;
}

/** One storey's grid, as `build()` rasterizes it. */
interface Storey {
  readonly floor: number;
  readonly y: number;
  readonly originX: number;
  readonly originZ: number;
  readonly cols: number;
  readonly rows: number;
  /** 1 where a body centre may stand. */
  readonly free: Uint8Array;
  /** How far each cell's centre is from the nearest solid cell, in metres. */
  readonly clearance: Float32Array;
  /** The free area each free cell belongs to, or -1. */
  readonly component: Int32Array;
  readonly componentSize: ReadonlyArray<number>;
  /** How many standing colleagues' discs cover each cell. */
  readonly occupied: Uint8Array;
}

/** One end of a path: its exact point, and the free cell the walk starts or ends on. */
interface Portal {
  readonly storey: Storey;
  /** The exact point, with the storey's height. */
  readonly position: Vector3;
  /** The nearest free cell to the point. */
  readonly cell: number;
}

/** Whether a search keeps out of the discs `occupy` marks. */
type Avoidance = "avoid-occupied" | "ignore-occupied";

/**
 * A binary min-heap of cell indices keyed by cost, reused by every search.
 * Entries are never decreased in place: a cheaper route pushes the cell
 * again, and the search skips cells it has already closed.
 */
class CellHeap {
  private cells = new Int32Array(1024);
  private keys = new Float64Array(1024);
  size = 0;

  clear(): void {
    this.size = 0;
  }

  push(cell: number, key: number): void {
    if (this.size === this.cells.length) {
      const cells = new Int32Array(this.size * 2);
      cells.set(this.cells);
      this.cells = cells;
      const keys = new Float64Array(this.size * 2);
      keys.set(this.keys);
      this.keys = keys;
    }
    let index = this.size++;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.keys[parent]! <= key) break;
      this.cells[index] = this.cells[parent]!;
      this.keys[index] = this.keys[parent]!;
      index = parent;
    }
    this.cells[index] = cell;
    this.keys[index] = key;
  }

  /** Removes and returns the cell with the lowest key. Only call it while `size > 0`. */
  pop(): number {
    const top = this.cells[0]!;
    const lastCell = this.cells[--this.size]!;
    const lastKey = this.keys[this.size]!;
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      if (left >= this.size) break;
      const right = left + 1;
      const child = right < this.size && this.keys[right]! < this.keys[left]! ? right : left;
      if (this.keys[child]! >= lastKey) break;
      this.cells[index] = this.cells[child]!;
      this.keys[index] = this.keys[child]!;
      index = child;
    }
    this.cells[index] = lastCell;
    this.keys[index] = lastKey;
    return top;
  }
}

/** The arrays every search reuses, sized for the largest storey. */
interface SearchBuffers {
  readonly cost: Float64Array;
  readonly parent: Int32Array;
  /** The search that last reached a cell; a stamp from an older search means unvisited. */
  readonly seen: Uint32Array;
  /** The search that last closed a cell. */
  readonly closed: Uint32Array;
  readonly heap: CellHeap;
  search: number;
}

/**
 * Measures how far each cell's centre is from the nearest point of a solid
 * cell, in metres; a solid cell measures 0, and every cell measures
 * `FAR_CLEARANCE` when nothing is solid. Two sweeps over the grid, one forward and one back,
 * pass each cell's nearest solid cell on to its neighbours. That can miss the
 * true nearest cell by a little in rare shapes, never by more than a cell.
 */
function measureClearance(solid: Uint8Array, cols: number, rows: number): Float32Array {
  const count = cols * rows;
  const clearance = new Float32Array(count).fill(FAR_CLEARANCE);
  // The nearest solid cell found so far for each cell, by column and row.
  const nearestCol = new Int32Array(count).fill(-1);
  const nearestRow = new Int32Array(count);
  /** Takes the neighbour's nearest solid cell for `cell` when it is nearer. */
  const offerNeighbour = (cell: number, col: number, row: number, neighbour: number): void => {
    const siteCol = nearestCol[neighbour]!;
    if (siteCol === -1) return;
    const siteRow = nearestRow[neighbour]!;
    const gapX = Math.max(0, Math.abs(col - siteCol) - 0.5);
    const gapZ = Math.max(0, Math.abs(row - siteRow) - 0.5);
    const distance = Math.hypot(gapX, gapZ) * CELL_SIZE;
    if (distance >= clearance[cell]!) return;
    clearance[cell] = distance;
    nearestCol[cell] = siteCol;
    nearestRow[cell] = siteRow;
  };
  for (let cell = 0; cell < count; cell++) {
    if (solid[cell] === 0) continue;
    clearance[cell] = 0;
    nearestCol[cell] = cell % cols;
    nearestRow[cell] = (cell - (cell % cols)) / cols;
  }
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cell = row * cols + col;
      if (col > 0) offerNeighbour(cell, col, row, cell - 1);
      if (row === 0) continue;
      offerNeighbour(cell, col, row, cell - cols);
      if (col > 0) offerNeighbour(cell, col, row, cell - cols - 1);
      if (col < cols - 1) offerNeighbour(cell, col, row, cell - cols + 1);
    }
    for (let col = cols - 2; col >= 0; col--) {
      offerNeighbour(row * cols + col, col, row, row * cols + col + 1);
    }
  }
  for (let row = rows - 1; row >= 0; row--) {
    for (let col = cols - 1; col >= 0; col--) {
      const cell = row * cols + col;
      if (col < cols - 1) offerNeighbour(cell, col, row, cell + 1);
      if (row === rows - 1) continue;
      offerNeighbour(cell, col, row, cell + cols);
      if (col > 0) offerNeighbour(cell, col, row, cell + cols - 1);
      if (col < cols - 1) offerNeighbour(cell, col, row, cell + cols + 1);
    }
    for (let col = 1; col < cols; col++) {
      offerNeighbour(row * cols + col, col, row, row * cols + col - 1);
    }
  }
  return clearance;
}

/** Returns the rectangle a set of rectangles covers together. */
function computeBoundingRect(rects: ReadonlyArray<Rect>): Rect {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.minX);
    minZ = Math.min(minZ, rect.minZ);
    maxX = Math.max(maxX, rect.maxX);
    maxZ = Math.max(maxZ, rect.maxZ);
  }
  return { minX, minZ, maxX, maxZ };
}

/**
 * Rasterizes one storey: its floor rectangles, then every block and open in
 * call order, then measures every cell's clearance from the solid cells, then
 * labels the free areas. The grid has a border of one unwalkable cell, so a free
 * cell's eight neighbours are always inside it.
 */
function rasterizeStorey(
  floor: number,
  y: number,
  floors: ReadonlyArray<Rect>,
  marks: ReadonlyArray<Mark>,
): Storey {
  const extent = computeBoundingRect(floors);
  const originX = extent.minX - CELL_SIZE;
  const originZ = extent.minZ - CELL_SIZE;
  const cols = Math.ceil((extent.maxX - extent.minX) / CELL_SIZE) + 2;
  const rows = Math.ceil((extent.maxZ - extent.minZ) / CELL_SIZE) + 2;
  const count = cols * rows;
  const floorCells = new Uint8Array(count);
  const solid = new Uint8Array(count);

  // A floor covers the cells whose centres it covers, so floors that share an
  // edge meet without a gap or an overlap.
  for (const rect of floors) {
    const col0 = Math.max(1, Math.ceil((rect.minX - originX) / CELL_SIZE - 0.5));
    const col1 = Math.min(cols - 2, Math.floor((rect.maxX - originX) / CELL_SIZE - 0.5));
    const row0 = Math.max(1, Math.ceil((rect.minZ - originZ) / CELL_SIZE - 0.5));
    const row1 = Math.min(rows - 2, Math.floor((rect.maxZ - originZ) / CELL_SIZE - 0.5));
    for (let row = row0; row <= row1; row++)
      floorCells.fill(1, row * cols + col0, row * cols + col1 + 1);
  }
  // A block covers every cell it touches, so a wall thinner than a cell still
  // blocks. An open covers only the cells that lie wholly inside it, so a
  // door is never wider on the grid than it is in the room: a cell the door
  // jamb runs through stays solid.
  for (const { solid: isSolid, rect } of marks) {
    const firstCol = (rect.minX - originX) / CELL_SIZE;
    const lastCol = (rect.maxX - originX) / CELL_SIZE;
    const firstRow = (rect.minZ - originZ) / CELL_SIZE;
    const lastRow = (rect.maxZ - originZ) / CELL_SIZE;
    const col0 = Math.max(1, isSolid ? Math.floor(firstCol) : Math.ceil(firstCol - 1e-9));
    const col1 = Math.min(cols - 2, isSolid ? Math.floor(lastCol) : Math.floor(lastCol + 1e-9) - 1);
    const row0 = Math.max(1, isSolid ? Math.floor(firstRow) : Math.ceil(firstRow - 1e-9));
    const row1 = Math.min(rows - 2, isSolid ? Math.floor(lastRow) : Math.floor(lastRow + 1e-9) - 1);
    for (let row = row0; row <= row1; row++) {
      solid.fill(isSolid ? 1 : 0, row * cols + col0, row * cols + col1 + 1);
      if (!isSolid) floorCells.fill(1, row * cols + col0, row * cols + col1 + 1);
    }
  }

  // Only solid cells push a body away. The floor's own edge does not: an
  // entrance often sits right on it, and the layout walls the edge anyway.
  const clearance = measureClearance(solid, cols, rows);
  const free = new Uint8Array(count);
  for (let row = 1; row < rows - 1; row++) {
    for (let col = 1; col < cols - 1; col++) {
      const cell = row * cols + col;
      if (floorCells[cell] === 1 && clearance[cell]! >= BODY_CLEARANCE) free[cell] = 1;
    }
  }

  // Free areas, 4-connected: with no corner cutting, that is exactly what
  // the 8-connected search can reach.
  const component = new Int32Array(count).fill(-1);
  const componentSize: number[] = [];
  const queue = new Int32Array(count);
  for (let start = 0; start < count; start++) {
    if (free[start] === 0 || component[start] !== -1) continue;
    const label = componentSize.length;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    component[start] = label;
    while (head < tail) {
      const cell = queue[head++]!;
      for (let side = 0; side < 4; side++) {
        const next =
          side === 0 ? cell - 1 : side === 1 ? cell + 1 : side === 2 ? cell - cols : cell + cols;
        if (free[next] === 1 && component[next] === -1) {
          component[next] = label;
          queue[tail++] = next;
        }
      }
    }
    componentSize.push(tail);
  }

  return {
    floor,
    y,
    originX,
    originZ,
    cols,
    rows,
    free,
    clearance,
    component,
    componentSize,
    occupied: new Uint8Array(count),
  };
}

/** Returns the cell under a world point, clamped into the grid. */
function findCell(storey: Storey, x: number, z: number): number {
  const col = Math.min(storey.cols - 1, Math.max(0, Math.floor((x - storey.originX) / CELL_SIZE)));
  const row = Math.min(storey.rows - 1, Math.max(0, Math.floor((z - storey.originZ) / CELL_SIZE)));
  return row * storey.cols + col;
}

/** Returns a cell's centre, at the storey's height. */
function buildCellCentre(storey: Storey, cell: number): Vector3 {
  const col = cell % storey.cols;
  const row = (cell - col) / storey.cols;
  return new Vector3(
    storey.originX + (col + 0.5) * CELL_SIZE,
    storey.y,
    storey.originZ + (row + 0.5) * CELL_SIZE,
  );
}

/** Returns true when a body may pass through a cell in a search. */
function isPassable(storey: Storey, cell: number, avoidance: Avoidance): boolean {
  return (
    storey.free[cell] === 1 && (avoidance === "ignore-occupied" || storey.occupied[cell] === 0)
  );
}

/**
 * Returns a world point's clearance from the solid cells, in metres,
 * interpolated between the four nearest cell centres. Between two centres
 * that are clear, a point can still pass close to a wall's corner; this is
 * how a straight leg finds out.
 */
function sampleClearance(storey: Storey, x: number, z: number): number {
  const { cols, clearance } = storey;
  const u = (x - storey.originX) / CELL_SIZE - 0.5;
  const v = (z - storey.originZ) / CELL_SIZE - 0.5;
  const col = Math.max(0, Math.min(cols - 2, Math.floor(u)));
  const row = Math.max(0, Math.min(storey.rows - 2, Math.floor(v)));
  const fx = Math.max(0, Math.min(1, u - col));
  const fz = Math.max(0, Math.min(1, v - row));
  const cell = row * cols + col;
  const near = clearance[cell]! * (1 - fx) + clearance[cell + 1]! * fx;
  const far = clearance[cell + cols]! * (1 - fx) + clearance[cell + cols + 1]! * fx;
  return near * (1 - fz) + far * fz;
}

/**
 * Returns the free cell nearest to a world point that `accept` takes, within
 * `NEAREST_FREE_RADIUS`, or -1. Rings of cells are searched outward until no
 * closer cell can follow.
 */
function findNearestFreeCell(
  storey: Storey,
  x: number,
  z: number,
  accept: (cell: number) => boolean,
): number {
  const centre = findCell(storey, x, z);
  const col0 = centre % storey.cols;
  const row0 = (centre - col0) / storey.cols;
  const reach = Math.ceil(NEAREST_FREE_RADIUS / CELL_SIZE);
  let best = -1;
  let bestDistance = Infinity;
  for (let ring = 0; ring <= reach; ring++) {
    if ((ring - 1) * CELL_SIZE > bestDistance) break;
    for (let dz = -ring; dz <= ring; dz++) {
      const onEdge = Math.abs(dz) === ring;
      for (let dx = -ring; dx <= ring; dx += onEdge ? 1 : ring * 2) {
        const col = col0 + dx;
        const row = row0 + dz;
        if (col < 0 || row < 0 || col >= storey.cols || row >= storey.rows) continue;
        const cell = row * storey.cols + col;
        if (storey.free[cell] === 0 || !accept(cell)) continue;
        const distance = Math.hypot(
          storey.originX + (col + 0.5) * CELL_SIZE - x,
          storey.originZ + (row + 0.5) * CELL_SIZE - z,
        );
        if (distance < bestDistance) {
          bestDistance = distance;
          best = cell;
        }
        if (ring === 0) break;
      }
    }
  }
  return best;
}

/**
 * Returns true when a body can walk the straight line between two world
 * points: every cell the line touches is passable, and every point along it,
 * sampled each half cell, keeps `clearance` metres from walls and furniture
 * (at least `BODY_CLEARANCE`). Where the line passes exactly through a cell
 * corner it checks both cells beside it, so it never cuts a corner the
 * search would refuse to cut.
 */
function hasLineOfSight(
  storey: Storey,
  from: Vector3,
  to: Vector3,
  avoidance: Avoidance,
  clearance: number,
): boolean {
  const samples = Math.ceil(Math.hypot(to.x - from.x, to.z - from.z) / (CELL_SIZE / 2));
  for (let sample = 1; sample < samples; sample++) {
    const t = sample / samples;
    const x = from.x + (to.x - from.x) * t;
    const z = from.z + (to.z - from.z) * t;
    if (sampleClearance(storey, x, z) < clearance) return false;
  }
  const x0 = (from.x - storey.originX) / CELL_SIZE;
  const z0 = (from.z - storey.originZ) / CELL_SIZE;
  const x1 = (to.x - storey.originX) / CELL_SIZE;
  const z1 = (to.z - storey.originZ) / CELL_SIZE;
  let col = Math.floor(x0);
  let row = Math.floor(z0);
  const endCol = Math.floor(x1);
  const endRow = Math.floor(z1);
  const dx = x1 - x0;
  const dz = z1 - z0;
  const stepX = Math.sign(dx);
  const stepZ = Math.sign(dz);
  const deltaX = stepX === 0 ? Infinity : 1 / Math.abs(dx);
  const deltaZ = stepZ === 0 ? Infinity : 1 / Math.abs(dz);
  let nextX = stepX > 0 ? (col + 1 - x0) * deltaX : stepX < 0 ? (x0 - col) * deltaX : Infinity;
  let nextZ = stepZ > 0 ? (row + 1 - z0) * deltaZ : stepZ < 0 ? (z0 - row) * deltaZ : Infinity;
  const { cols } = storey;
  for (let steps = storey.cols + storey.rows; steps > 0; steps--) {
    if (!isPassable(storey, row * cols + col, avoidance)) return false;
    if (col === endCol && row === endRow) return true;
    if (Math.abs(nextX - nextZ) < 1e-9) {
      if (
        !isPassable(storey, row * cols + col + stepX, avoidance) ||
        !isPassable(storey, (row + stepZ) * cols + col, avoidance)
      ) {
        return false;
      }
      col += stepX;
      row += stepZ;
      nextX += deltaX;
      nextZ += deltaZ;
    } else if (nextX < nextZ) {
      col += stepX;
      nextX += deltaX;
    } else {
      row += stepZ;
      nextZ += deltaZ;
    }
  }
  return false;
}

/**
 * Searches a storey's grid with A* from one free cell to another: 8-connected,
 * diagonal steps only where both cells beside the step are passable, with the
 * octile distance as the estimate. A step into a cell closer to a wall or
 * furniture than `COMFORT_CLEARANCE` costs more, so the path keeps to the
 * middle of corridors and doors. Returns the cells from start to goal, or
 * null when the goal cannot be reached.
 */
function searchCells(
  storey: Storey,
  start: number,
  goal: number,
  avoidance: Avoidance,
  buffers: SearchBuffers,
): number[] | null {
  const { cols, clearance } = storey;
  const { cost, parent, seen, closed, heap } = buffers;
  const search = ++buffers.search;
  const goalCol = goal % cols;
  const goalRow = (goal - goalCol) / cols;
  const estimate = (cell: number): number => {
    const col = cell % cols;
    const dx = Math.abs(col - goalCol);
    const dz = Math.abs((cell - col) / cols - goalRow);
    // The octile distance, weighted: the search heads for the goal more
    // eagerly and expands about a tenth of the cells. A path may come out
    // longer than the shortest, but across an 80 by 60 metre floor of rooms
    // the string-pulled paths measured under 2% longer in total.
    return (Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz)) * HEURISTIC_WEIGHT;
  };
  const canEnter = (cell: number): boolean => cell === goal || isPassable(storey, cell, avoidance);
  /**
   * Reaches `next` from `cell` by a step `length` cells long, unless an
   * earlier route was as cheap.
   */
  const visit = (cell: number, next: number, length: number): void => {
    if (closed[next] === search) return;
    const tightness = Math.max(0, COMFORT_CLEARANCE - clearance[next]!);
    const reached =
      cost[cell]! +
      length * (1 + (NEAR_WALL_COST * tightness) / (COMFORT_CLEARANCE - BODY_CLEARANCE));
    if (seen[next] === search && cost[next]! <= reached) return;
    seen[next] = search;
    cost[next] = reached;
    parent[next] = cell;
    heap.push(next, reached + estimate(next));
  };
  heap.clear();
  cost[start] = 0;
  parent[start] = -1;
  seen[start] = search;
  heap.push(start, estimate(start));
  while (heap.size > 0) {
    const cell = heap.pop();
    if (closed[cell] === search) continue;
    closed[cell] = search;
    if (cell === goal) {
      const cells: number[] = [];
      for (let at = goal; at !== -1; at = parent[at]!) cells.push(at);
      return cells.reverse();
    }
    const straight = 1;
    const diagonal = SQRT2;
    const west = canEnter(cell - 1);
    const east = canEnter(cell + 1);
    const north = canEnter(cell - cols);
    const south = canEnter(cell + cols);
    if (west) visit(cell, cell - 1, straight);
    if (east) visit(cell, cell + 1, straight);
    if (north) visit(cell, cell - cols, straight);
    if (south) visit(cell, cell + cols, straight);
    if (north && west && canEnter(cell - cols - 1)) visit(cell, cell - cols - 1, diagonal);
    if (north && east && canEnter(cell - cols + 1)) visit(cell, cell - cols + 1, diagonal);
    if (south && west && canEnter(cell + cols - 1)) visit(cell, cell + cols - 1, diagonal);
    if (south && east && canEnter(cell + cols + 1)) visit(cell, cell + cols + 1, diagonal);
  }
  return null;
}

/**
 * Pulls a string through a path of cells, so the path becomes a few straight
 * legs. `first` and `last` stand in for the first and last cells' centres,
 * so the legs start and end at exact points. Returns the kept points, ends
 * included.
 *
 * A straight leg keeps as much clearance as the cells it replaces had, up to
 * `COMFORT_CLEARANCE`, so pulling the string does not drag the path back
 * against the walls the search kept it away from.
 *
 * A first pass keeps a corner wherever the straight line from the last kept
 * point to the next cell is blocked. That corner can land late, after the
 * obstacle it turns around, so a second pass moves each corner to the cell
 * between its two neighbours that makes the shortest detour both of them can
 * still see, and drops corners that are no longer needed.
 */
function pullString(
  storey: Storey,
  cells: ReadonlyArray<number>,
  first: Vector3,
  last: Vector3,
  avoidance: Avoidance,
): Vector3[] {
  const points = cells.map((cell, index) =>
    index === 0 ? first : index === cells.length - 1 ? last : buildCellCentre(storey, cell),
  );
  if (points.length < 3) return points.length === 2 && last.equals(first) ? [first] : points;
  /** Returns the clearance a straight leg from point `from` to point `to` must keep. */
  const requireClearance = (from: number, to: number): number => {
    let narrowest = COMFORT_CLEARANCE;
    for (let index = from; index <= to; index++) {
      narrowest = Math.min(narrowest, storey.clearance[cells[index]!]!);
    }
    return Math.max(BODY_CLEARANCE, narrowest - LEG_SLACK);
  };
  const canWalk = (from: number, to: number): boolean =>
    hasLineOfSight(storey, points[from]!, points[to]!, avoidance, requireClearance(from, to));
  const kept = [0];
  for (let index = 1; index < points.length - 1; index++) {
    if (!canWalk(kept[kept.length - 1]!, index + 1)) kept.push(index);
  }
  kept.push(points.length - 1);
  for (let corner = 1; corner < kept.length - 1; corner++) {
    const before = points[kept[corner - 1]!]!;
    const after = points[kept[corner + 1]!]!;
    if (canWalk(kept[corner - 1]!, kept[corner + 1]!)) {
      kept.splice(corner--, 1);
      continue;
    }
    const candidates: Array<{ readonly index: number; readonly length: number }> = [];
    for (let index = kept[corner - 1]! + 1; index < kept[corner + 1]!; index++) {
      const point = points[index]!;
      candidates.push({ index, length: before.distanceTo(point) + point.distanceTo(after) });
    }
    candidates.sort((a, b) => a.length - b.length);
    const best = candidates.find(
      ({ index }) => canWalk(kept[corner - 1]!, index) && canWalk(index, kept[corner + 1]!),
    );
    if (best !== undefined) kept[corner] = best.index;
  }
  return kept.map((index) => points[index]!);
}

/** Creates the builder a layout fills with floors, obstacles and doors. */
export function createNavBuilder(): NavBuilder {
  const floorRects = new Map<number, { y: number; rects: Rect[] }>();
  const marks = new Map<number, Mark[]>();

  const addMark = (floor: number, mark: Mark): void => {
    const list = marks.get(floor);
    if (list === undefined) marks.set(floor, [mark]);
    else list.push(mark);
  };

  return {
    addFloor(floor, y, minX, minZ, maxX, maxZ) {
      const entry = floorRects.get(floor);
      const rect = { minX, minZ, maxX, maxZ };
      if (entry === undefined) floorRects.set(floor, { y, rects: [rect] });
      else entry.rects.push(rect);
    },
    block(floor, minX, minZ, maxX, maxZ) {
      addMark(floor, { solid: true, rect: { minX, minZ, maxX, maxZ } });
    },
    blockObject(floor, object: Object3D, padding = 0) {
      // A layout often calls this before its root is in the scene, so the
      // world matrices are brought up to date here.
      object.updateWorldMatrix(true, true);
      const box = new Box3().setFromObject(object);
      if (box.isEmpty()) return;
      addMark(floor, {
        solid: true,
        rect: {
          minX: box.min.x - padding,
          minZ: box.min.z - padding,
          maxX: box.max.x + padding,
          maxZ: box.max.z + padding,
        },
      });
    },
    open(floor, minX, minZ, maxX, maxZ) {
      addMark(floor, { solid: false, rect: { minX, minZ, maxX, maxZ } });
    },
    build() {
      return buildGraph(floorRects, marks);
    },
  };
}

/** Rasterizes every storey and returns the finished graph. */
function buildGraph(
  floorRects: ReadonlyMap<number, { readonly y: number; readonly rects: ReadonlyArray<Rect> }>,
  marks: ReadonlyMap<number, ReadonlyArray<Mark>>,
): OfficeNavGraph {
  const storeys = new Map<number, Storey>();
  for (const [floor, { y, rects }] of floorRects) {
    storeys.set(floor, rasterizeStorey(floor, y, rects, marks.get(floor) ?? []));
  }
  let largest = 0;
  for (const storey of storeys.values()) largest = Math.max(largest, storey.cols * storey.rows);
  const buffers: SearchBuffers = {
    cost: new Float64Array(largest),
    parent: new Int32Array(largest),
    seen: new Uint32Array(largest),
    closed: new Uint32Array(largest),
    heap: new CellHeap(),
    search: 0,
  };

  const isOpenArea = (storey: Storey) => (cell: number) =>
    storey.componentSize[storey.component[cell]!]! >= POCKET_CELLS;

  /** Returns a portal at a spot: its exact point and its nearest free cell in an open area. */
  const buildPortal = (spot: Spot): Portal | null => {
    const storey = storeys.get(spot.floor);
    if (storey === undefined) return null;
    const { x, z } = spot.position;
    const cell = findNearestFreeCell(storey, x, z, isOpenArea(storey));
    if (cell === -1) return null;
    return { storey, position: new Vector3(x, storey.y, z), cell };
  };

  /** Returns the waypoints of one walk across a storey between two portals, or null. */
  const walkBetween = (from: Portal, to: Portal, avoidance: Avoidance): Waypoint[] | null => {
    const { storey } = from;
    const cells = searchCells(storey, from.cell, to.cell, avoidance, buffers);
    if (cells === null) return null;
    // An exact end inside an obstacle is joined to its free cell by a step of
    // its own, outside the string pulling, which would otherwise cut through.
    const startsFree = findCell(storey, from.position.x, from.position.z) === from.cell;
    const endsFree = findCell(storey, to.position.x, to.position.z) === to.cell;
    const first = startsFree ? from.position : buildCellCentre(storey, from.cell);
    const last = endsFree ? to.position : buildCellCentre(storey, to.cell);
    const points = pullString(storey, cells, first, last, avoidance);
    if (!startsFree) points.unshift(from.position);
    if (!endsFree) points.push(to.position);
    return points.map((position) => ({ position: position.clone(), floor: storey.floor }));
  };

  const findPathAvoiding = (from: Spot, to: Spot, avoidance: Avoidance): Waypoint[] | null => {
    const nearStart = buildPortal(from);
    if (nearStart === null) return null;
    let start: Portal = nearStart;
    const goalStorey = storeys.get(to.floor);
    if (goalStorey === undefined) return null;
    // The goal's free cell is the nearest one in the start's own area when
    // there is one, so a chair is reached from the room it stands in.
    const isInStartArea = (cell: number): boolean =>
      goalStorey === start.storey &&
      goalStorey.component[cell] === start.storey.component[start.cell];
    let goalCell = findNearestFreeCell(goalStorey, to.position.x, to.position.z, isInStartArea);
    if (goalCell === -1) {
      goalCell = findNearestFreeCell(
        goalStorey,
        to.position.x,
        to.position.z,
        isOpenArea(goalStorey),
      );
    }
    if (goalCell === -1) return null;
    // A start beside a closed-off area, such as the space between a desk and
    // a wall, can pick its free cell in there. When the goal's cell is in
    // another area, the start's free cell is picked again, in the goal's area.
    if (
      goalStorey === start.storey &&
      goalStorey.component[goalCell] !== start.storey.component[start.cell]
    ) {
      const goalArea = goalStorey.component[goalCell];
      const cell = findNearestFreeCell(
        goalStorey,
        from.position.x,
        from.position.z,
        (candidate) => goalStorey.component[candidate] === goalArea,
      );
      if (cell !== -1) start = { ...start, cell };
    }
    const goal: Portal = {
      storey: goalStorey,
      position: new Vector3(to.position.x, goalStorey.y, to.position.z),
      cell: goalCell,
    };
    // A path keeps to one free area of one storey: nothing joins storeys.
    if (
      goal.storey !== start.storey ||
      goal.storey.component[goal.cell] !== start.storey.component[start.cell]
    ) {
      return null;
    }
    return walkBetween(start, goal, avoidance);
  };

  return {
    findPath(from, to) {
      // A layout that declares no floors still gets straight paths, so its
      // colleagues move at all.
      if (storeys.size === 0) {
        return [
          { position: from.position.clone(), floor: from.floor },
          { position: to.position.clone(), floor: to.floor },
        ];
      }
      return (
        findPathAvoiding(from, to, "avoid-occupied") ??
        findPathAvoiding(from, to, "ignore-occupied")
      );
    },
    isWalkable(spot) {
      const storey = storeys.get(spot.floor);
      if (storey === undefined) return storeys.size === 0;
      return storey.free[findCell(storey, spot.position.x, spot.position.z)] === 1;
    },
    occupy(floor, position, radius) {
      const storey = storeys.get(floor);
      if (storey === undefined) return () => {};
      const cells: number[] = [];
      const reach = Math.ceil(radius / CELL_SIZE);
      const centre = findCell(storey, position.x, position.z);
      const col0 = centre % storey.cols;
      const row0 = (centre - col0) / storey.cols;
      for (
        let row = Math.max(0, row0 - reach);
        row <= Math.min(storey.rows - 1, row0 + reach);
        row++
      ) {
        for (
          let col = Math.max(0, col0 - reach);
          col <= Math.min(storey.cols - 1, col0 + reach);
          col++
        ) {
          const x = storey.originX + (col + 0.5) * CELL_SIZE - position.x;
          const z = storey.originZ + (row + 0.5) * CELL_SIZE - position.z;
          if (x * x + z * z <= radius * radius) cells.push(row * storey.cols + col);
        }
      }
      for (const cell of cells) storey.occupied[cell] = Math.min(255, storey.occupied[cell]! + 1);
      let freed = false;
      return () => {
        if (freed) return;
        freed = true;
        for (const cell of cells) storey.occupied[cell] = Math.max(0, storey.occupied[cell]! - 1);
      };
    },
  };
}
