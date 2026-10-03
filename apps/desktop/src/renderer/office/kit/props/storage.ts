/**
 * PROTOTYPE - where the office keeps things: the filing cabinet, the
 * bookshelf, the Post Room's pigeonholes and Dispatch's parcels.
 */
import type { Object3D } from "three";
import {
  PartList,
  buildBlock,
  buildPropGroup,
  buildSheet,
  buildSphere,
  createRandom,
  memoize,
  memoizeByKey,
  type PartSink,
  type Surface,
} from "./shared";

// ---------------------------------------------------------------------------
// The filing cabinet.

const CABINET_SURFACES = {
  wood: { token: "room-wood", finish: "lacquer", shadow: true },
  drawer: { token: "room-wood", finish: "lacquer", shift: { dl: 0.05, dc: -0.01 }, shadow: true },
  brass: { token: "brass", finish: "brass", shadow: false },
  paper: { token: "room-paper", finish: "paper", shadow: false },
} as const satisfies Record<string, Surface>;

/** Adds a brass card holder with its paper card, and a brass pull under it, centred at the origin. */
function addDrawerFittings(parts: PartSink<"brass" | "paper">, width: number): void {
  parts.add("brass", buildBlock(width, width * 0.5, 0.008, 0.003, 1), { y: 0.02 });
  parts.add("paper", buildSheet(width * 0.82, width * 0.36, 0.004), { y: 0.027, z: 0.005 });
  parts.add("brass", buildBlock(width * 1.05, 0.022, 0.024, 0.01, 1), { y: -0.03, z: 0.006 });
}

const readCabinetGeometry = memoize(() => {
  const parts = new PartList(CABINET_SURFACES);
  parts.add("wood", buildBlock(0.46, 0.06, 0.54, 0.012, 1), { z: -0.01 });
  parts.add("wood", buildBlock(0.5, 1.18, 0.58, 0.025, 2), { y: 0.06, z: -0.01 });
  // A stepped cornice.
  parts.add("wood", buildBlock(0.52, 0.03, 0.6, 0.012, 1), { y: 1.24 });
  parts.add("wood", buildBlock(0.47, 0.03, 0.55, 0.012, 1), { y: 1.27, z: -0.01 });
  // Four drawers, each with a card holder and a pull.
  for (let drawer = 0; drawer < 4; drawer++) {
    const y = 0.1 + drawer * 0.285;
    parts.add("drawer", buildBlock(0.43, 0.255, 0.026, 0.012, 2), { y, z: 0.29 });
    parts.nest({ y: y + 0.17, z: 0.305 }, () => addDrawerFittings(parts, 0.1));
  }
  return parts.merge();
});

/**
 * Builds a filing cabinet of four drawers, each with a brass card holder
 * and pull: 0.52 wide, 1.3 tall and 0.62 deep (z from -0.31 to 0.31).
 */
export function buildCabinet(): Object3D {
  return buildPropGroup("cabinet", readCabinetGeometry());
}

// ---------------------------------------------------------------------------
// The bookshelf.

const BOOKSHELF_SURFACES = {
  wood: { token: "room-wood", finish: "lacquer", shadow: true },
  back: { token: "room-wood", finish: "satin", shift: { dl: -0.12, dc: -0.01 }, shadow: false },
  green: { token: "room-fabric", finish: "matte", shadow: false },
  dark: { token: "room-inlay-2", finish: "matte", shadow: false },
  tan: { token: "room-panel", finish: "matte", shadow: false },
  brown: { token: "room-wood", finish: "matte", shift: { dl: -0.1, dh: -18 }, shadow: false },
  ochre: {
    token: "room-sun",
    finish: "matte",
    shift: { dl: -0.22, dc: 0.03, dh: -8 },
    shadow: false,
  },
  cream: { token: "room-paper", finish: "matte", shift: { dl: -0.06, dc: 0.02 }, shadow: false },
  gilt: { token: "brass", finish: "brass", shadow: false },
} as const satisfies Record<string, Surface>;

type BookSurface = "green" | "dark" | "tan" | "brown" | "ochre" | "cream";
const BOOK_SURFACES: readonly BookSurface[] = ["green", "dark", "tan", "brown", "ochre", "cream"];

/** The heights of the bookshelf's shelves: the bottom of each compartment, and its top. */
const SHELF_SPANS: ReadonlyArray<readonly [number, number]> = [
  [0.08, 0.45],
  [0.475, 0.82],
  [0.845, 1.19],
  [1.215, 1.56],
  [1.585, 1.93],
];

/**
 * Adds one shelf's books between `left` and `right`, standing on `floor`:
 * runs of upright books, now and then one leaning on its neighbour, a short
 * stack lying flat, or a gap.
 */
function addShelfOfBooks(
  parts: PartSink<keyof typeof BOOKSHELF_SURFACES>,
  random: () => number,
  left: number,
  right: number,
  floor: number,
  room: number,
): void {
  const pick = () => BOOK_SURFACES[Math.floor(random() * BOOK_SURFACES.length)] ?? "green";
  let x = left;
  while (x < right - 0.03) {
    const roll = random();
    if (roll < 0.06) {
      // A gap, where a book is out on someone's desk.
      x += 0.05 + random() * 0.1;
      continue;
    }
    if (roll < 0.11 && right - x > 0.24) {
      // A short stack of books lying flat.
      let y = floor;
      const count = 2 + Math.floor(random() * 2);
      for (let book = 0; book < count; book++) {
        const thickness = 0.025 + random() * 0.02;
        const width = 0.2 - book * 0.02 - random() * 0.03;
        parts.add(pick(), buildSheet(width, thickness, 0.18 + random() * 0.04), {
          x: x + 0.11,
          y,
          z: 0.03,
          ry: (random() - 0.5) * 0.15,
        });
        y += thickness;
      }
      x += 0.24;
      continue;
    }
    const thickness = 0.022 + random() * 0.026;
    const height = Math.min(room - 0.04, 0.19 + random() * 0.11);
    const depth = 0.19 + random() * 0.06;
    const surface = pick();
    if (roll < 0.17 && x > left + 0.05) {
      // A book leaning on the one before it, which leaves a gap at its foot.
      const lean = 0.22 + random() * 0.18;
      const reach = height * Math.sin(lean);
      parts.add(surface, buildSheet(thickness, height, depth), {
        x: x + reach + thickness / 2,
        y: floor,
        z: 0.15 - depth / 2,
        rz: lean,
      });
      x += reach + thickness + 0.02;
      continue;
    }
    parts.add(surface, buildSheet(thickness, height, depth), {
      x: x + thickness / 2,
      y: floor,
      z: 0.15 - depth / 2,
    });
    // Gilt bands near the top of some spines.
    if (random() < 0.3) {
      parts.add("gilt", buildSheet(thickness + 0.002, 0.008, 0.004), {
        x: x + thickness / 2,
        y: floor + height - 0.035,
        z: 0.151,
      });
    }
    x += thickness + 0.002;
  }
}

const readBookshelfGeometry = memoizeByKey((width: number) => {
  const parts = new PartList(BOOKSHELF_SURFACES);
  const random = createRandom(Math.round(width * 1000) + 7);
  const inner = width / 2 - 0.04;
  for (const side of [-1, 1]) {
    parts.add("wood", buildBlock(0.04, 1.92, 0.35, 0.012, 1), {
      x: side * (width / 2 - 0.02),
      y: 0.02,
    });
  }
  parts.add("wood", buildBlock(width - 0.04, 0.08, 0.33, 0.01, 1), { z: -0.005 });
  parts.add("wood", buildBlock(width + 0.04, 0.04, 0.37, 0.015, 1), { y: 1.96 });
  parts.add("wood", buildBlock(width, 0.03, 0.35, 0.01, 1), { y: 1.93 });
  parts.add("back", buildSheet(width - 0.06, 1.86, 0.015), { y: 0.07, z: -0.165 });
  for (const [floor, roof] of SHELF_SPANS) {
    if (floor > 0.1)
      parts.add("wood", buildBlock(width - 0.07, 0.025, 0.33, 0.006, 1), { y: floor - 0.025 });
    addShelfOfBooks(parts, random, -inner + 0.01, inner - 0.01, floor, roof - floor);
  }
  return parts.merge();
});

/**
 * Builds a bookshelf `width` wide, 2 tall and 0.37 deep (z from -0.185 to
 * 0.185), five shelves of books in muted cloth bindings. The books stand the
 * same way every time for the same width.
 */
export function buildBookshelf(width: number): Object3D {
  return buildPropGroup("bookshelf", readBookshelfGeometry(width));
}

// ---------------------------------------------------------------------------
// The Post Room's pigeonholes.

const PIGEONHOLE_SURFACES = {
  wood: { token: "room-wood", finish: "lacquer", shadow: true },
  inner: { token: "room-wood", finish: "satin", shift: { dl: -0.12, dc: -0.01 }, shadow: false },
  brass: { token: "brass", finish: "brass", shadow: false },
  paper: { token: "room-paper", finish: "paper", shadow: false },
  kraft: { token: "room-cork", finish: "paper", shift: { dl: -0.04, dc: 0.015 }, shadow: false },
} as const satisfies Record<string, Surface>;

const HOLE_COLUMNS = 6;
const HOLE_ROWS = 3;

const readPigeonholeGeometry = memoize(() => {
  const parts = new PartList(PIGEONHOLE_SURFACES);
  const random = createRandom(31);
  const width = 1.6;
  // The counter: a plinth, a base of drawers, and a top that overhangs it.
  parts.add("wood", buildBlock(width - 0.04, 0.05, 0.36, 0.01, 1), { z: -0.015 });
  parts.add("wood", buildBlock(width, 0.78, 0.38, 0.02, 2), { y: 0.05, z: -0.01 });
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 2; row++) {
      const x = -0.6 + column * 0.4;
      const y = 0.09 + row * 0.37;
      parts.add("wood", buildBlock(0.37, 0.34, 0.022, 0.01, 1), { x, y, z: 0.19 });
      parts.add("brass", buildBlock(0.09, 0.02, 0.022, 0.009, 1), { x, y: y + 0.24, z: 0.205 });
    }
  }
  parts.add("wood", buildBlock(width + 0.04, 0.04, 0.42, 0.015, 1), { y: 0.83, z: 0.01 });
  // The cubbies above, open at the front.
  const bottom = 0.87;
  const holeWidth = (width - 0.06) / HOLE_COLUMNS;
  const holeHeight = 0.25;
  const top = bottom + HOLE_ROWS * holeHeight + 0.03;
  parts.add("inner", buildSheet(width - 0.04, top - bottom, 0.015), { y: bottom, z: -0.19 });
  for (const side of [-1, 1]) {
    parts.add("wood", buildBlock(0.03, top - bottom, 0.3, 0.01, 1), {
      x: side * (width / 2 - 0.015),
      y: bottom,
      z: -0.05,
    });
  }
  for (let column = 1; column < HOLE_COLUMNS; column++) {
    parts.add("inner", buildSheet(0.012, top - bottom, 0.28), {
      x: -width / 2 + 0.03 + column * holeWidth,
      y: bottom,
      z: -0.055,
    });
  }
  for (let row = 1; row < HOLE_ROWS; row++) {
    parts.add("wood", buildSheet(width - 0.06, 0.012, 0.29), {
      y: bottom + row * holeHeight,
      z: -0.05,
    });
  }
  parts.add("wood", buildBlock(width + 0.04, 0.035, 0.34, 0.012, 1), { y: top, z: -0.04 });
  parts.add("wood", buildBlock(width - 0.04, 0.03, 0.3, 0.01, 1), { y: top + 0.035, z: -0.05 });
  // A brass label under each hole, and letters in some of them.
  for (let row = 0; row < HOLE_ROWS; row++) {
    for (let column = 0; column < HOLE_COLUMNS; column++) {
      const x = -width / 2 + 0.03 + (column + 0.5) * holeWidth;
      const floor = bottom + row * holeHeight + 0.012;
      parts.add("brass", buildSheet(0.06, 0.016, 0.004), { x, y: floor - 0.011, z: 0.095 });
      const fill = random();
      if (fill < 0.35) continue;
      const count = 1 + Math.floor(random() * 4);
      for (let letter = 0; letter < count; letter++) {
        parts.add(random() < 0.2 ? "kraft" : "paper", buildSheet(0.17, 0.004, 0.12), {
          x: x + (random() - 0.5) * 0.03,
          y: floor + letter * 0.0045,
          z: -0.02 + (random() - 0.5) * 0.04,
          ry: (random() - 0.5) * 0.25,
        });
      }
      if (fill > 0.85) {
        // A letter standing up against the side of the hole.
        parts.add("paper", buildSheet(0.004, 0.15, 0.11), {
          x: x + holeWidth / 2 - 0.03,
          y: floor,
          z: -0.04,
          rz: 0.18,
        });
      }
    }
  }
  return parts.merge();
});

/**
 * Builds the Post Room's pigeonholes: a counter of drawers with eighteen
 * cubbies above it, letters in some. Against a wall: its back is at
 * z = -0.2. It is 1.64 wide, 0.42 deep (z from -0.2 to 0.22) and 1.71 tall.
 */
export function buildPigeonholes(): Object3D {
  return buildPropGroup("pigeonholes", readPigeonholeGeometry());
}

// ---------------------------------------------------------------------------
// Dispatch's parcels.

const PARCEL_SURFACES = {
  kraft: { token: "room-cork", finish: "paper", shift: { dl: -0.04, dc: 0.015 }, shadow: true },
  string: { token: "room-paper", finish: "paper", shift: { dl: -0.12, dc: 0.02 }, shadow: true },
  label: { token: "room-paper", finish: "paper", shadow: true },
} as const satisfies Record<string, Surface>;

/** Adds a parcel `width` x `height` x `depth`, tied with string both ways, standing at the origin. */
function addParcel(
  parts: PartSink<keyof typeof PARCEL_SURFACES>,
  width: number,
  height: number,
  depth: number,
): void {
  parts.add("kraft", buildBlock(width, height, depth, 0.012, 1));
  parts.add("string", buildSheet(width + 0.006, height + 0.006, 0.008), { y: -0.003 });
  parts.add("string", buildSheet(0.008, height + 0.006, depth + 0.006), { y: -0.003 });
  parts.add("string", buildSphere(0.012, 8, 6), { y: height + 0.004 });
  parts.add("label", buildSheet(width * 0.32, 0.002, depth * 0.24), {
    x: width * 0.24,
    y: height,
    z: depth * 0.24,
    ry: 0.06,
  });
}

const readParcelsGeometry = memoize(() => {
  const parts = new PartList(PARCEL_SURFACES);
  parts.nest({ x: -0.08, ry: 0.05 }, () => addParcel(parts, 0.5, 0.26, 0.4));
  parts.nest({ x: -0.1, y: 0.26, z: 0.02, ry: -0.22 }, () => addParcel(parts, 0.34, 0.17, 0.28));
  parts.nest({ x: 0.27, z: 0.08, ry: 0.4 }, () => addParcel(parts, 0.18, 0.15, 0.2));
  return parts.merge();
});

/**
 * Builds a stack of string-tied parcels, for Dispatch: about 0.72 wide,
 * 0.5 deep and 0.43 tall.
 */
export function buildParcels(): Object3D {
  return buildPropGroup("parcels", readParcelsGeometry());
}
