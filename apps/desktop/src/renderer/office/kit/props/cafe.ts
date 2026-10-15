/**
 * The café's furniture, in the style of a 1930s Paris café: bentwood chairs
 * at marble-topped tables, a zinc counter with a brass coffee machine, a
 * striped awning over the street, a blade sign with the café's name, and a
 * chalkboard on the pavement.
 *
 * A seat follows the rule every seat follows: its centre stands directly
 * above its marker, and its top is at `SEAT_HEIGHT`.
 */
import { Group, Shape, Vector3, type Object3D } from "three";

import { SEAT_HEIGHT, type SeatsProp } from "../../engine/contracts";
import { buildPlaque } from "../architecture-signs";

import {
  PartList,
  addMeshes,
  buildBlock,
  buildCylinder,
  buildExtrusion,
  buildLathe,
  buildMarker,
  buildPropGroup,
  buildRing,
  buildRod,
  buildSheet,
  memoize,
  memoizeByKey,
  type PartSink,
  type Surface,
} from "./shared";

const CAFE_SURFACES = {
  marble: { token: "room-desk", finish: "gloss", shadow: true },
  iron: { token: "room-inlay-2", finish: "satin", shift: { dl: -0.08 }, shadow: true },
  bentwood: { token: "room-wood", finish: "lacquer", shift: { dl: -0.1 }, shadow: true },
  cane: { token: "room-cork", finish: "matte", shadow: true },
  zinc: { token: "room-metal", finish: "metal", shadow: true },
  wood: { token: "room-wood", finish: "lacquer", shadow: true },
  brass: { token: "brass", finish: "brass", shadow: true },
  china: { token: "room-paper", finish: "gloss", shadow: false },
} as const satisfies Record<string, Surface>;

type CafeSurface = keyof typeof CAFE_SURFACES;

/** The height of a café table's marble top. */
const TABLE_HEIGHT = 0.72;
/** The width a seat takes along a long table. */
const TABLE_PITCH = 0.62;
/** How far a chair's seat stands from a table's edge. */
const CHAIR_FROM_TABLE = 0.3;
/** The depth of a long table's top. */
const LONG_TABLE_DEPTH = 0.6;
/** The radius of a round table's top. */
const ROUND_TABLE_RADIUS = 0.3;

// ---------------------------------------------------------------------------
// The bentwood chair.

/**
 * Adds a bentwood chair: a round cane seat on four splayed legs, a ring
 * between the legs, and a back of steamed wood in one loop. Its seat's
 * centre is at the origin, its top at `SEAT_HEIGHT`, and its sitter faces +z.
 */
function addBentwoodChairParts(parts: PartSink<CafeSurface>): void {
  const seatTop = SEAT_HEIGHT;
  parts.add("cane", buildCylinder(0.2, 0.2, 0.025, 20), { y: seatTop - 0.025 });
  parts.add("bentwood", buildRing(0.2, 0.014, Math.PI * 2, 6, 24), {
    y: seatTop - 0.03,
    rx: Math.PI / 2,
  });
  for (const [x, z] of [
    [-0.13, -0.13],
    [0.13, -0.13],
    [-0.13, 0.13],
    [0.13, 0.13],
  ] as const) {
    parts.add(
      "bentwood",
      buildRod(
        new Vector3(x * 0.9, seatTop - 0.04, z * 0.9),
        new Vector3(x * 1.25, 0, z * 1.25),
        0.014,
      ),
    );
  }
  parts.add("bentwood", buildRing(0.16, 0.009, Math.PI * 2, 5, 24), {
    y: seatTop * 0.45,
    rx: Math.PI / 2,
  });
  // The back: one loop of wood rising from the seat's rear, open at the bottom.
  const loop = new Shape();
  loop.absarc(0, 0, 0.19, 0, Math.PI, false);
  loop.absarc(0, 0, 0.165, Math.PI, 0, true);
  parts.add("bentwood", buildExtrusion(loop, 0.025, 0.006, 10), {
    y: seatTop + 0.17,
    z: -0.2,
    rx: -0.12,
  });
  for (const x of [-0.177, 0.177]) {
    parts.add("bentwood", buildCylinder(0.012, 0.012, 0.17, 8), { x, y: seatTop, z: -0.2 });
  }
}

/** Adds a bentwood chair turned upside down, its seat resting on a table top at `top`. */
function addChairUpsideDown(parts: PartSink<CafeSurface>, top: number): void {
  parts.nest({ y: top + SEAT_HEIGHT, rz: Math.PI }, () => addBentwoodChairParts(parts));
}

/** Adds a coffee cup on its saucer, standing at the origin. */
function addCoffeeCupParts(parts: PartSink<CafeSurface>): void {
  parts.add("china", buildCylinder(0.06, 0.055, 0.008, 16));
  parts.add(
    "china",
    buildLathe(
      [
        [0, 0.008],
        [0.025, 0.008],
        [0.035, 0.03],
        [0.037, 0.055],
        [0, 0.055],
      ],
      16,
    ),
  );
}

// ---------------------------------------------------------------------------
// The tables.

/** Adds a cast-iron pedestal foot with a column up to the top at `TABLE_HEIGHT`. */
function addPedestalParts(parts: PartSink<CafeSurface>, x: number): void {
  parts.add(
    "iron",
    buildLathe(
      [
        [0, 0],
        [0.2, 0],
        [0.18, 0.03],
        [0.05, 0.08],
        [0, 0.08],
      ],
      20,
    ),
    { x },
  );
  parts.add("iron", buildCylinder(0.03, 0.035, TABLE_HEIGHT - 0.1, 12), { x, y: 0.06 });
}

/**
 * Returns the geometry of a long marble table for `seats` sitters in a row
 * along x, on its north side, facing south. With `chairsUp`, the chairs rest
 * upside down on the top, as in a café that has closed for the night.
 */
const readLongTableGeometry = memoizeByKey((key: string) => {
  const [seatsText, chairsUp] = key.split("|");
  const seats = Number(seatsText);
  const parts = new PartList(CAFE_SURFACES);
  const length = seats * TABLE_PITCH + 0.2;
  parts.add("marble", buildBlock(length, 0.035, LONG_TABLE_DEPTH, 0.012, 1), {
    y: TABLE_HEIGHT - 0.035,
  });
  parts.add("brass", buildBlock(length + 0.01, 0.012, LONG_TABLE_DEPTH + 0.01, 0.004, 1), {
    y: TABLE_HEIGHT - 0.045,
  });
  const feet = Math.max(2, Math.ceil(length / 1.4));
  for (let foot = 0; foot < feet; foot++) {
    addPedestalParts(parts, -length / 2 + 0.35 + (foot * (length - 0.7)) / Math.max(1, feet - 1));
  }
  for (let seat = 0; seat < seats; seat++) {
    const x = -length / 2 + 0.1 + TABLE_PITCH / 2 + seat * TABLE_PITCH;
    if (chairsUp === "up") {
      parts.nest({ x, z: -0.08 }, () => addChairUpsideDown(parts, TABLE_HEIGHT));
    } else {
      parts.nest({ x, z: -LONG_TABLE_DEPTH / 2 - CHAIR_FROM_TABLE + 0.08 }, () =>
        addBentwoodChairParts(parts),
      );
      parts.nest({ x: x + 0.08, y: TABLE_HEIGHT, z: -0.1 }, () => addCoffeeCupParts(parts));
    }
  }
  return parts.merge();
});

/**
 * Builds a long marble-topped table on cast-iron feet with `seats`
 * bentwood chairs along its north side, their sitters facing south over the
 * table, toward the camera. The top is `seats` x 0.62 + 0.2 long (x) and
 * 0.6 deep; the chairs reach 0.55 behind it. The seat markers are 0.62
 * apart. With `chairsUp`, the chairs rest upside down on the top, and the
 * table offers no seat.
 */
export function buildLongTable(seats: number, chairsUp: boolean): SeatsProp {
  const object = new Group();
  object.name = "long-table";
  addMeshes(object, readLongTableGeometry(`${String(seats)}|${chairsUp ? "up" : "down"}`));
  const length = seats * TABLE_PITCH + 0.2;
  const seatMarkers = chairsUp
    ? []
    : Array.from({ length: seats }, (_, seat) =>
        buildMarker(
          -length / 2 + 0.1 + TABLE_PITCH / 2 + seat * TABLE_PITCH,
          -LONG_TABLE_DEPTH / 2 - CHAIR_FROM_TABLE + 0.08,
          0,
        ),
      );
  object.add(...seatMarkers);
  return { object, seatMarkers };
}

const readRoundTableGeometry = memoizeByKey((chairsUp: boolean) => {
  const parts = new PartList(CAFE_SURFACES);
  parts.add("marble", buildCylinder(ROUND_TABLE_RADIUS, ROUND_TABLE_RADIUS, 0.03, 28), {
    y: TABLE_HEIGHT - 0.03,
  });
  parts.add(
    "brass",
    buildCylinder(ROUND_TABLE_RADIUS + 0.008, ROUND_TABLE_RADIUS + 0.008, 0.012, 28),
    {
      y: TABLE_HEIGHT - 0.04,
    },
  );
  addPedestalParts(parts, 0);
  if (chairsUp) {
    parts.nest({ z: -0.02 }, () => addChairUpsideDown(parts, TABLE_HEIGHT));
  } else {
    parts.nest({ z: -ROUND_TABLE_RADIUS - CHAIR_FROM_TABLE + 0.05 }, () =>
      addBentwoodChairParts(parts),
    );
    parts.nest({ x: 0.07, y: TABLE_HEIGHT, z: -0.06 }, () => addCoffeeCupParts(parts));
  }
  return parts.merge();
});

/**
 * Builds a round marble-topped table for one, 0.6 across, on a cast-iron
 * foot, with a bentwood chair on its north side facing south. With
 * `chairsUp`, the chair rests upside down on the top, and the table offers
 * no seat.
 */
export function buildRoundTable(chairsUp: boolean): SeatsProp {
  const object = new Group();
  object.name = "round-table";
  addMeshes(object, readRoundTableGeometry(chairsUp));
  const seatMarkers = chairsUp
    ? []
    : [buildMarker(0, -ROUND_TABLE_RADIUS - CHAIR_FROM_TABLE + 0.05, 0)];
  object.add(...seatMarkers);
  return { object, seatMarkers };
}

// ---------------------------------------------------------------------------
// The counter.

/** The height of the counter's zinc top. */
const COUNTER_HEIGHT = 1.0;
/** The depth of the counter. */
const COUNTER_DEPTH = 0.55;

const readCounterGeometry = memoizeByKey((length: number) => {
  const parts = new PartList(CAFE_SURFACES);
  // A panelled wooden front under a zinc top with a rolled edge, and a brass foot rail.
  parts.add("wood", buildBlock(length, COUNTER_HEIGHT - 0.04, COUNTER_DEPTH - 0.05, 0.02, 1), {
    z: -0.025,
  });
  for (let panel = 0; panel < Math.floor(length / 0.7); panel++) {
    const x = -length / 2 + 0.35 + panel * 0.7 + (length - Math.floor(length / 0.7) * 0.7) / 2;
    parts.add("bentwood", buildBlock(0.5, 0.6, 0.02, 0.008, 1), {
      x,
      y: 0.18,
      z: COUNTER_DEPTH / 2 - 0.045,
    });
  }
  parts.add("zinc", buildBlock(length + 0.08, 0.04, COUNTER_DEPTH + 0.06, 0.018, 2), {
    y: COUNTER_HEIGHT - 0.04,
  });
  parts.add("brass", buildCylinder(0.016, 0.016, length - 0.1, 10), {
    x: length / 2 - 0.05,
    y: 0.14,
    z: COUNTER_DEPTH / 2 + 0.08,
    rz: Math.PI / 2,
  });
  // The coffee machine at the east end: a brass column under an eagle-less dome, with two spouts.
  const machineX = length / 2 - 0.35;
  parts.add(
    "brass",
    buildLathe(
      [
        [0, 0],
        [0.15, 0],
        [0.15, 0.04],
        [0.12, 0.06],
        [0.12, 0.42],
        [0.14, 0.46],
        [0.1, 0.54],
        [0.03, 0.6],
        [0.03, 0.66],
        [0, 0.66],
      ],
      24,
    ),
    { x: machineX, y: COUNTER_HEIGHT },
  );
  for (const side of [-1, 1]) {
    parts.add("iron", buildCylinder(0.02, 0.02, 0.08, 8), {
      x: machineX + side * 0.07,
      y: COUNTER_HEIGHT + 0.14,
      z: 0.13,
      rx: Math.PI / 2,
    });
  }
  // A row of cups along the top, west of the machine.
  for (let cup = 0; cup < 3; cup++) {
    parts.nest({ x: machineX - 0.35 - cup * 0.16, y: COUNTER_HEIGHT, z: 0.05 }, () =>
      addCoffeeCupParts(parts),
    );
  }
  return parts.merge();
});

/**
 * Builds the café's zinc counter, `length` long (x), 0.61 deep and 1.06
 * tall with the coffee machine on it: a panelled wooden front facing +z,
 * a zinc top, a brass foot rail, a brass coffee machine near its east end
 * and a row of cups.
 */
export function buildCounter(length: number): Object3D {
  return buildPropGroup("counter", readCounterGeometry(Math.round(length * 100) / 100));
}

// ---------------------------------------------------------------------------
// Outside: the awning, the blade sign and the chalkboard.

/** The awning's stripe width, stretched a little so whole stripes fill it. */
const AWNING_STRIPE = 0.32;

const AWNING_SURFACES = {
  stripe: { token: "room-fabric", finish: "fabric", shadow: true },
  ground: { token: "room-paper", finish: "fabric", shadow: true },
  iron: { token: "room-inlay-2", finish: "satin", shift: { dl: -0.08 }, shadow: true },
} as const satisfies Record<string, Surface>;

const readAwningGeometry = memoizeByKey((width: number) => {
  const parts = new PartList(AWNING_SURFACES);
  const reach = 1.1;
  const drop = 0.38;
  const slope = Math.atan2(drop, reach);
  const run = Math.hypot(reach, drop);
  const count = Math.max(2, Math.round(width / AWNING_STRIPE));
  const stripe = width / count;
  for (let index = 0; index < count; index++) {
    const surface = index % 2 === 0 ? "stripe" : "ground";
    const x = -width / 2 + (index + 0.5) * stripe;
    // The sloping canvas, from the wall out over the pavement.
    parts.add(surface, buildSheet(stripe, 0.012, run), {
      x,
      y: -drop / 2,
      z: reach / 2,
      rx: slope,
    });
    // The valance hanging at the front edge, scalloped by a round tab per stripe.
    parts.add(surface, buildSheet(stripe, 0.16, 0.01), { x, y: -drop - 0.16, z: reach });
    parts.add(surface, buildCylinder(stripe / 2, stripe / 2, 0.01, 12), {
      x,
      y: -drop - 0.16,
      z: reach,
      rx: Math.PI / 2,
    });
  }
  // Two iron arms from the wall to the front edge.
  for (const side of [-1, 1]) {
    parts.add(
      "iron",
      buildRod(
        new Vector3(side * (width / 2 - 0.05), -0.75, 0.02),
        new Vector3(side * (width / 2 - 0.05), -drop, reach),
        0.012,
      ),
    );
  }
  return parts.merge();
});

/**
 * Builds a striped canvas awning `width` wide (x): it leaves the wall at
 * its origin, the top of the canvas, and slopes 1.1 out (+z) and 0.38 down,
 * ending in a scalloped valance. Two iron arms hold it up from the wall. Its
 * back is at z = 0, so it hangs on a wall like a plaque.
 */
export function buildAwning(width: number): Object3D {
  return buildPropGroup("awning", readAwningGeometry(Math.round(width * 100) / 100));
}

const BRACKET_SURFACES = {
  iron: { token: "room-inlay-2", finish: "satin", shift: { dl: -0.08 }, shadow: true },
} as const satisfies Record<string, Surface>;

/** How far the blade sign stands out from the wall. */
const BLADE_REACH = 0.95;

const readBracketGeometry = memoize(() => {
  const parts = new PartList(BRACKET_SURFACES);
  parts.add("iron", buildRod(new Vector3(0, 0.1, 0), new Vector3(0, 0.1, BLADE_REACH), 0.012));
  parts.add(
    "iron",
    buildRod(new Vector3(0, -0.25, 0), new Vector3(0, 0.1, BLADE_REACH * 0.6), 0.01),
  );
  parts.add("iron", buildRing(0.06, 0.006, Math.PI * 2, 4, 16), { y: 0.1, z: BLADE_REACH + 0.06 });
  return parts.merge();
});

/**
 * Builds a blade sign with `name` on both faces: two plaques back to back,
 * three times a room plaque's size, hanging from an iron bracket that
 * stands out from the wall along +z. Its origin is where the bracket meets
 * the wall, so it hangs on a wall like a plaque; the faces look along ±x.
 */
export function buildBladeSign(name: string): Object3D {
  const object = buildPropGroup("blade-sign", readBracketGeometry());
  for (const side of [-1, 1]) {
    const face = buildPlaque(name);
    face.scale.setScalar(3);
    face.rotation.y = (side * Math.PI) / 2;
    face.position.set(side * 0.005, -0.15, BLADE_REACH / 2 + 0.08);
    object.add(face);
  }
  return object;
}

const CHALKBOARD_SURFACES = {
  wood: { token: "room-wood", finish: "lacquer", shadow: true },
  slate: { token: "room-screen", finish: "matte", shadow: true },
  chalk: { token: "room-paper", finish: "matte", shadow: false },
} as const satisfies Record<string, Surface>;

const readChalkboardGeometry = memoize(() => {
  const parts = new PartList(CHALKBOARD_SURFACES);
  const height = 0.85;
  const lean = 0.2;
  for (const side of [-1, 1]) {
    parts.nest({ z: side * 0.09, rx: -side * lean }, () => {
      parts.add("wood", buildBlock(0.5, height, 0.03, 0.01, 1));
      parts.add("slate", buildSheet(0.42, height - 0.1, 0.008), { y: 0.05, z: side * 0.016 });
      // A few lines of chalk: the day's menu, too small to read.
      for (let line = 0; line < 4; line++) {
        parts.add("chalk", buildSheet(0.3 - line * 0.04, 0.012, 0.004), {
          y: height - 0.2 - line * 0.12,
          z: side * 0.022,
        });
      }
    });
  }
  return parts.merge();
});

/** Builds an A-frame chalkboard for the pavement, 0.5 wide and 0.85 tall, readable from ±z. */
export function buildChalkboard(): Object3D {
  return buildPropGroup("chalkboard", readChalkboardGeometry());
}
