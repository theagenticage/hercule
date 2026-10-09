/**
 * Where the office keeps things: the filing cabinet and the bookcase.
 */
import type { Object3D } from "three";
import {
  PartList,
  buildBlock,
  buildPropGroup,
  buildSheet,
  memoize,
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
// The bookcase.

const BOOKCASE_SURFACES = {
  wood: { token: "room-wood", finish: "lacquer", shadow: true },
  // The back panel casts a shadow so it shares the wood's mesh, and so no light shows through the
  // shelves' openings in the bookcase's shadow.
  back: { token: "room-wood", finish: "lacquer", shift: { dl: -0.06 }, shadow: true },
  brass: { token: "brass", finish: "brass", shadow: false },
} as const satisfies Record<string, Surface>;

/** The bookcase's width and depth outside its sides, and the space between its sides. */
const BOOKCASE_WIDTH = 0.8;
const BOOKCASE_DEPTH = 0.32;
const BOOKCASE_INSIDE = 0.72;
/** The height of each opening between two shelves, and the thickness of a shelf. */
const SHELF_GAP = 0.3;
const SHELF = 0.025;
/** How many openings the bookcase has, top to bottom. */
const OPENINGS = 4;
/** The height of the plinth the lowest shelf stands on. */
const PLINTH = 0.08;

const readBookcaseGeometry = memoize(() => {
  const parts = new PartList(BOOKCASE_SURFACES);
  const carcass = PLINTH + OPENINGS * (SHELF_GAP + SHELF) + SHELF;
  const side = (BOOKCASE_WIDTH - BOOKCASE_INSIDE) / 2;
  // The plinth, set back a little, and the back panel.
  parts.add("wood", buildBlock(BOOKCASE_WIDTH - 0.02, PLINTH, BOOKCASE_DEPTH - 0.03, 0.01, 1), {
    z: -0.01,
  });
  parts.add("back", buildSheet(BOOKCASE_INSIDE, carcass - PLINTH, 0.015), {
    y: PLINTH,
    z: -BOOKCASE_DEPTH / 2 + 0.0075,
  });
  // The two sides, with a brass line down each front edge.
  for (const sign of [-1, 1]) {
    const x = sign * (BOOKCASE_INSIDE / 2 + side / 2);
    parts.add("wood", buildBlock(side, carcass, BOOKCASE_DEPTH, 0.008, 1), { x });
    parts.add("brass", buildSheet(0.006, carcass - PLINTH - 0.04, 0.004), {
      x,
      y: PLINTH + 0.02,
      z: BOOKCASE_DEPTH / 2 + 0.002,
    });
  }
  // The shelves: the lowest on the plinth, the top one under the cornice.
  for (let shelf = 0; shelf <= OPENINGS; shelf++) {
    parts.add("wood", buildBlock(BOOKCASE_INSIDE, SHELF, BOOKCASE_DEPTH - 0.02, 0.004, 1), {
      y: PLINTH + shelf * (SHELF_GAP + SHELF),
      z: 0.005,
    });
  }
  // A stepped cornice, higher in the middle, the Deco way.
  parts.add("wood", buildBlock(BOOKCASE_WIDTH + 0.04, 0.04, BOOKCASE_DEPTH + 0.03, 0.01, 1), {
    y: carcass,
    z: 0.005,
  });
  parts.add("wood", buildBlock(BOOKCASE_WIDTH - 0.06, 0.035, BOOKCASE_DEPTH - 0.02, 0.01, 1), {
    y: carcass + 0.04,
  });
  parts.add("wood", buildBlock(0.3, 0.035, BOOKCASE_DEPTH - 0.06, 0.01, 1), {
    y: carcass + 0.075,
    z: -0.01,
  });
  parts.add("brass", buildBlock(0.22, 0.012, 0.006, 0.003, 1), {
    y: carcass + 0.0865,
    z: BOOKCASE_DEPTH / 2 - 0.037,
  });
  return parts.merge();
});

/**
 * Builds an empty bookcase: four open shelves on a plinth, under a stepped
 * cornice. It is 0.84 wide at its cornice (0.8 at its sides), 0.35 deep and
 * 1.52 tall. Each opening is 0.72 wide, 0.3 tall and 0.3 deep: the top three
 * hold eight topic books each, standing, and the lowest holds the ledger
 * lying flat. No books are drawn.
 */
export function buildBookcase(): Object3D {
  return buildPropGroup("bookcase", readBookcaseGeometry());
}
