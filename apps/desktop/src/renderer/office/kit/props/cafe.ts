/**
 * The café's furniture, in the style of a 1930s Paris café: bentwood chairs
 * at marble-topped tables, a zinc counter with a brass espresso machine, a
 * mirrored back bar of bottles, a
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
  buildSphere,
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
  paper: { token: "room-paper", finish: "paper", shift: { dl: -0.03 }, shadow: false },
  print: { token: "room-screen", finish: "paper", shift: { dl: 0.25 }, shadow: false },
  glass: { token: "room-metal", finish: "gloss", shift: { dl: 0.1, dc: 0.02 }, shadow: false },
  pastry: { token: "room-cork", finish: "matte", shift: { dl: -0.04, dc: 0.05 }, shadow: false },
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

/**
 * Adds a cast-iron bistro pedestal at `x`: three feet curving out from a
 * boss on the floor, and a turned column with rings up to the top at
 * `TABLE_HEIGHT`.
 */
function addPedestalParts(parts: PartSink<CafeSurface>, x: number): void {
  for (let foot = 0; foot < 3; foot++) {
    const angle = (foot * Math.PI * 2) / 3 + Math.PI / 6;
    const out = new Vector3(Math.sin(angle), 0, Math.cos(angle));
    parts.add(
      "iron",
      buildRod(
        new Vector3(x, 0.09, 0).addScaledVector(out, 0.02),
        new Vector3(x, 0.03, 0).addScaledVector(out, 0.19),
        0.014,
      ),
    );
    // The foot's toe, a small ball that rests on the floor.
    parts.add("iron", buildSphere(0.02, 8, 6), {
      x: x + out.x * 0.2,
      y: 0.02,
      z: out.z * 0.2,
    });
  }
  parts.add(
    "iron",
    buildLathe(
      [
        [0, 0.06],
        [0.045, 0.06],
        [0.05, 0.1],
        [0.026, 0.14],
        [0.022, TABLE_HEIGHT - 0.16],
        [0.034, TABLE_HEIGHT - 0.12],
        [0.03, TABLE_HEIGHT - 0.1],
        [0.06, TABLE_HEIGHT - 0.06],
        [0, TABLE_HEIGHT - 0.04],
      ],
      14,
    ),
    { x },
  );
}

/** Adds a sugar bowl with its lid, standing at the origin. */
function addSugarBowlParts(parts: PartSink<CafeSurface>): void {
  parts.add(
    "china",
    buildLathe(
      [
        [0, 0],
        [0.026, 0],
        [0.034, 0.025],
        [0.03, 0.045],
        [0.012, 0.055],
        [0.008, 0.066],
        [0, 0.066],
      ],
      14,
    ),
  );
}

/** Adds a glass carafe of water, standing at the origin. */
function addCarafeParts(parts: PartSink<CafeSurface>): void {
  parts.add(
    "glass",
    buildLathe(
      [
        [0, 0],
        [0.04, 0],
        [0.046, 0.06],
        [0.03, 0.13],
        [0.016, 0.17],
        [0.019, 0.2],
        [0, 0.2],
      ],
      14,
    ),
  );
}

/** Adds a notepad with a pencil across it, lying at the origin. */
function addNotepadParts(parts: PartSink<CafeSurface>): void {
  parts.add("paper", buildSheet(0.13, 0.008, 0.17), { ry: 0.12 });
  for (let line = 0; line < 4; line++) {
    parts.add("print", buildSheet(0.09 - (line % 2) * 0.02, 0.001, 0.006), {
      x: -0.005,
      y: 0.008,
      z: -0.05 + line * 0.03,
      ry: 0.12,
    });
  }
  parts.add(
    "bentwood",
    buildRod(new Vector3(0.05, 0.012, -0.06), new Vector3(0.09, 0.012, 0.08), 0.004),
  );
}

/** Adds a newspaper folded in half, lying at the origin, its columns of print showing. */
function addNewspaperParts(parts: PartSink<CafeSurface>): void {
  parts.add("paper", buildSheet(0.2, 0.01, 0.28), { ry: -0.25 });
  parts.nest({ y: 0.01, ry: -0.25 }, () => {
    parts.add("print", buildSheet(0.16, 0.001, 0.03), { z: -0.11 });
    for (let column = 0; column < 3; column++) {
      for (let line = 0; line < 6; line++) {
        parts.add("print", buildSheet(0.045, 0.001, 0.008), {
          x: -0.055 + column * 0.055,
          z: -0.06 + line * 0.028,
        });
      }
    }
  });
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
      // Each seat has its coffee and a notepad to work on; a carafe and a
      // sugar bowl stand between every two seats.
      parts.nest({ x: x + 0.17, y: TABLE_HEIGHT, z: -0.13 }, () => addCoffeeCupParts(parts));
      parts.nest({ x: x - 0.04, y: TABLE_HEIGHT, z: -0.06 }, () => addNotepadParts(parts));
      if (seat % 2 === 1 || seats === 1) {
        const between = x + TABLE_PITCH / 2;
        parts.nest({ x: between - 0.03, y: TABLE_HEIGHT, z: 0.17 }, () => addCarafeParts(parts));
        parts.nest({ x: between + 0.06, y: TABLE_HEIGHT, z: 0.18 }, () => addSugarBowlParts(parts));
      }
    }
  }
  return parts.merge();
});

/**
 * Builds a long marble-topped table on cast-iron tripods with `seats`
 * bentwood chairs along its north side, their sitters facing south over the
 * table, toward the camera. Each seat has a coffee and a notepad, and a
 * carafe and a sugar bowl stand between every two seats. The top is `seats` x 0.62 + 0.2 long (x) and
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
  if (seatMarkers.length > 0) object.add(...seatMarkers);
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
    parts.nest({ x: 0.13, y: TABLE_HEIGHT, z: -0.1 }, () => addCoffeeCupParts(parts));
    parts.nest({ x: -0.04, y: TABLE_HEIGHT, z: 0.02 }, () => addNewspaperParts(parts));
    parts.nest({ x: 0.17, y: TABLE_HEIGHT, z: 0.12 }, () => addSugarBowlParts(parts));
  }
  return parts.merge();
});

/**
 * Builds a round marble-topped table for one, 0.6 across, on a cast-iron
 * tripod, with a bentwood chair on its north side facing south, and a
 * coffee, a newspaper and a sugar bowl on the top. With
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
  if (seatMarkers.length > 0) object.add(...seatMarkers);
  return { object, seatMarkers };
}

// ---------------------------------------------------------------------------
// The counter.

/** The height of the counter's zinc top. */
const COUNTER_HEIGHT = 1.0;
/** The depth of the counter. */
const COUNTER_DEPTH = 0.55;

/**
 * Adds a brass cash register standing at the origin, its keys facing +z: a
 * sloped keyboard of round keys, a body with a scrolled panel, and the
 * price flags in a crested window on top.
 */
function addCashRegisterParts(parts: PartSink<CafeSurface>): void {
  parts.add("brass", buildBlock(0.3, 0.16, 0.26, 0.015, 1));
  parts.add("brass", buildBlock(0.3, 0.08, 0.12, 0.01, 1), { y: 0.06, z: 0.12, rx: 0.5 });
  for (let row = 0; row < 3; row++) {
    for (let key = 0; key < 6; key++) {
      parts.add("china", buildCylinder(0.011, 0.011, 0.012, 8), {
        x: -0.11 + key * 0.044,
        y: 0.12 - row * 0.022,
        z: 0.11 + row * 0.03,
        rx: 0.5,
      });
    }
  }
  parts.add("wood", buildBlock(0.22, 0.1, 0.12, 0.01, 1), { y: 0.16, z: -0.04 });
  parts.add("china", buildSheet(0.16, 0.05, 0.005), { y: 0.185, z: 0.02 });
  parts.add("brass", buildBlock(0.12, 0.05, 0.08, 0.02, 2), { y: 0.26, z: -0.04 });
  // The crank on its side.
  parts.add("iron", buildRod(new Vector3(0.16, 0.1, 0), new Vector3(0.21, 0.06, 0.03), 0.008));
}

/** Adds a cake stand of croissants, standing at the origin. */
function addPastryStandParts(parts: PartSink<CafeSurface>): void {
  parts.add("china", buildCylinder(0.06, 0.07, 0.012, 16));
  parts.add("china", buildCylinder(0.012, 0.016, 0.09, 8), { y: 0.012 });
  parts.add("china", buildCylinder(0.13, 0.11, 0.012, 20), { y: 0.1 });
  for (let pastry = 0; pastry < 5; pastry++) {
    const angle = (pastry * Math.PI * 2) / 5;
    parts.add("pastry", buildRing(0.03, 0.016, Math.PI * 1.1, 6, 10), {
      x: Math.sin(angle) * 0.07,
      y: 0.125,
      z: Math.cos(angle) * 0.07,
      rx: Math.PI / 2,
      rz: angle,
    });
  }
}

/**
 * Adds a 1930s espresso machine standing at the origin, its front facing
 * +z: a tall brass boiler in bands on a stepped base, a domed crown with a
 * ball finial, a pressure gauge on its front, and two group heads with their
 * handles reaching out to the front, each over a drip tray.
 */
function addEspressoMachineParts(parts: PartSink<CafeSurface>): void {
  parts.add("iron", buildBlock(0.42, 0.05, 0.3, 0.01, 1));
  parts.add("brass", buildCylinder(0.13, 0.15, 0.04, 28), { y: 0.05 });
  parts.add("brass", buildCylinder(0.12, 0.12, 0.42, 28), { y: 0.09 });
  for (const band of [0.14, 0.33, 0.49]) {
    parts.add("iron", buildCylinder(0.124, 0.124, 0.018, 28), { y: band });
  }
  parts.add(
    "brass",
    buildLathe(
      [
        [0, 0],
        [0.135, 0],
        [0.13, 0.03],
        [0.1, 0.09],
        [0.05, 0.13],
        [0.025, 0.15],
        [0, 0.15],
      ],
      28,
    ),
    { y: 0.51 },
  );
  // The finial: a brass ball on a short stem.
  parts.add("brass", buildCylinder(0.012, 0.012, 0.05, 8), { y: 0.66 });
  parts.add("brass", buildSphere(0.035, 12, 8), { y: 0.73 });
  // The pressure gauge: a white dial in a brass rim, on the boiler's front.
  parts.add("brass", buildCylinder(0.05, 0.05, 0.02, 20), { y: 0.38, z: 0.12, rx: Math.PI / 2 });
  parts.add("china", buildCylinder(0.04, 0.04, 0.01, 20), { y: 0.38, z: 0.13, rx: Math.PI / 2 });
  for (const side of [-1, 1]) {
    const x = side * 0.09;
    parts.add("brass", buildCylinder(0.035, 0.03, 0.06, 14), { x, y: 0.16, z: 0.13 });
    // The portafilter's handle, a black grip on a brass neck.
    parts.add("brass", buildRod(new Vector3(x, 0.15, 0.15), new Vector3(x, 0.15, 0.22), 0.008));
    parts.add("iron", buildCylinder(0.014, 0.014, 0.1, 8), {
      x,
      y: 0.15,
      z: 0.27,
      rx: Math.PI / 2,
    });
    parts.add("iron", buildBlock(0.08, 0.012, 0.08, 0.004, 1), { x, y: 0.05, z: 0.15 });
  }
}

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
  // The espresso machine at the east end, as a 1930s Paris bar had one.
  const machineX = length / 2 - 0.4;
  parts.nest({ x: machineX, y: COUNTER_HEIGHT, z: -0.04 }, () => addEspressoMachineParts(parts));
  // A brass cash register at the west end, beer taps and a stand of pastries between.
  parts.nest({ x: -length / 2 + 0.3, y: COUNTER_HEIGHT, z: -0.02 }, () =>
    addCashRegisterParts(parts),
  );
  for (const offset of [0, 0.12]) {
    const x = -length / 2 + 0.75 + offset;
    parts.add("brass", buildCylinder(0.02, 0.025, 0.24, 10), { x, y: COUNTER_HEIGHT, z: -0.12 });
    parts.add(
      "brass",
      buildRod(
        new Vector3(x, 0.2 + COUNTER_HEIGHT, -0.12),
        new Vector3(x, 0.2 + COUNTER_HEIGHT, -0.02),
        0.01,
      ),
    );
    parts.add("china", buildCylinder(0.012, 0.016, 0.1, 8), {
      x,
      y: 0.21 + COUNTER_HEIGHT,
      z: -0.14,
    });
  }
  parts.nest({ x: -length / 2 + 1.25, y: COUNTER_HEIGHT, z: 0.02 }, () =>
    addPastryStandParts(parts),
  );
  // A row of cups along the top, west of the machine.
  for (let cup = 0; cup < 3; cup++) {
    parts.nest({ x: machineX - 0.35 - cup * 0.16, y: COUNTER_HEIGHT, z: 0.05 }, () =>
      addCoffeeCupParts(parts),
    );
  }
  return parts.merge();
});

/**
 * Builds the café's zinc counter, `length` long (x) and 0.61 deep, its top
 * 1.0 high: a panelled wooden front facing +z, a zinc top and a brass foot
 * rail. On the top stand a brass cash register at its west end, two beer
 * taps, a stand of croissants, a row of cups and a brass espresso machine
 * near its east end.
 */
export function buildCounter(length: number): Object3D {
  return buildPropGroup("counter", readCounterGeometry(Math.round(length * 100) / 100));
}

// ---------------------------------------------------------------------------
// The back bar.

const BACK_BAR_SURFACES = {
  wood: { token: "room-wood", finish: "lacquer", shift: { dl: -0.06 }, shadow: true },
  mirror: { token: "room-metal", finish: "gloss", shift: { dl: 0.08 }, shadow: false },
  brass: { token: "brass", finish: "brass", shadow: true },
  green: { token: "ok", finish: "gloss", shift: { dl: -0.12 }, shadow: false },
  amber: { token: "brass", finish: "gloss", shift: { dl: -0.06, dc: 0.04 }, shadow: false },
  red: { token: "fail", finish: "gloss", shift: { dl: -0.14 }, shadow: false },
  clear: { token: "room-paper", finish: "gloss", shift: { dl: -0.04 }, shadow: false },
} as const satisfies Record<string, Surface>;

/** The height of the back bar's cabinet, and of its whole frame. */
const BACK_BAR_CABINET = 0.9;
const BACK_BAR_HEIGHT = 2.25;
const BACK_BAR_DEPTH = 0.4;
/** The bottle colours, in the order the shelves repeat them. */
const BOTTLE_SURFACES = ["green", "amber", "clear", "red", "amber", "green", "clear"] as const;

/** Adds a bottle standing at the origin: a body, a shoulder and a neck, `height` tall. */
function addBottleParts(
  parts: PartSink<keyof typeof BACK_BAR_SURFACES>,
  surface: (typeof BOTTLE_SURFACES)[number],
  height: number,
): void {
  const body = height * 0.62;
  parts.add(
    surface,
    buildLathe(
      [
        [0, 0],
        [0.034, 0],
        [0.035, body],
        [0.016, body + height * 0.14],
        [0.012, height],
        [0, height],
      ],
      12,
    ),
  );
}

const readBackBarGeometry = memoizeByKey((length: number) => {
  const parts = new PartList(BACK_BAR_SURFACES);
  // The cabinet: closed doors under a counter top.
  parts.add("wood", buildBlock(length, BACK_BAR_CABINET, BACK_BAR_DEPTH, 0.015, 1));
  parts.add("brass", buildBlock(length + 0.02, 0.02, BACK_BAR_DEPTH + 0.02, 0.006, 1), {
    y: BACK_BAR_CABINET,
  });
  // The mirror behind the shelves, in a frame with an arched Deco crest.
  const mirrorHeight = BACK_BAR_HEIGHT - BACK_BAR_CABINET - 0.15;
  parts.add("wood", buildBlock(length, mirrorHeight + 0.1, 0.05, 0.01, 1), {
    y: BACK_BAR_CABINET,
    z: -BACK_BAR_DEPTH / 2 + 0.025,
  });
  parts.add("mirror", buildSheet(length - 0.16, mirrorHeight - 0.08, 0.01), {
    y: BACK_BAR_CABINET + 0.05,
    z: -BACK_BAR_DEPTH / 2 + 0.055,
  });
  parts.add("wood", buildBlock(length * 0.5, 0.14, 0.06, 0.03, 2), {
    y: BACK_BAR_HEIGHT - 0.05,
    z: -BACK_BAR_DEPTH / 2 + 0.03,
  });
  // Two glass shelves of bottles on brass brackets, and bottles on the cabinet's top.
  const count = Math.max(4, Math.floor((length - 0.3) / 0.11));
  const shelves = [BACK_BAR_CABINET + 0.02, BACK_BAR_CABINET + 0.47, BACK_BAR_CABINET + 0.88];
  shelves.forEach((y, shelf) => {
    if (shelf > 0) {
      parts.add("brass", buildBlock(length - 0.2, 0.015, 0.16, 0.004, 1), {
        y: y - 0.015,
        z: -BACK_BAR_DEPTH / 2 + 0.14,
      });
    }
    for (let index = 0; index < count; index++) {
      const x = -length / 2 + 0.2 + (index * (length - 0.4)) / Math.max(1, count - 1);
      const surface = BOTTLE_SURFACES[(index + shelf * 3) % BOTTLE_SURFACES.length]!;
      parts.nest({ x, y, z: -BACK_BAR_DEPTH / 2 + 0.14 }, () =>
        addBottleParts(parts, surface, 0.26 + ((index * 7 + shelf * 5) % 4) * 0.03),
      );
    }
  });
  return parts.merge();
});

/**
 * Builds the back bar that stands behind the counter: a cabinet under a
 * mirror in a wooden frame, with two shelves of bottles in green, amber, red
 * and clear glass, and more bottles on the cabinet's top. It is `length`
 * long (x), 0.4 deep and 2.3 tall, its front facing +z.
 */
export function buildBackBar(length: number): Object3D {
  return buildPropGroup("back-bar", readBackBarGeometry(Math.round(length * 100) / 100));
}

// ---------------------------------------------------------------------------
// The posters.

const POSTER_SURFACES = {
  frame: { token: "room-wood", finish: "lacquer", shift: { dl: -0.12 }, shadow: false },
  paper: { token: "room-paper", finish: "paper", shift: { dl: -0.04, dc: 0.02 }, shadow: false },
  ink: { token: "room-inlay-2", finish: "paper", shadow: false },
  red: { token: "fail", finish: "paper", shift: { dl: -0.06 }, shadow: false },
  gold: { token: "brass", finish: "paper", shadow: false },
  green: { token: "ok", finish: "paper", shift: { dl: -0.08 }, shadow: false },
} as const satisfies Record<string, Surface>;

const POSTER_WIDTH = 0.5;
const POSTER_HEIGHT = 0.72;

/**
 * Returns the geometry of a framed Deco poster in one of two designs: `0`, a
 * sun rising in rays over the sea, for a liner; `1`, a bottle of apéritif
 * on bands of colour. The poster's back is at z = 0, its middle at y = 0.
 */
const readPosterGeometry = memoizeByKey((design: 0 | 1) => {
  const parts = new PartList(POSTER_SURFACES);
  const back = -POSTER_HEIGHT / 2;
  parts.add("frame", buildSheet(POSTER_WIDTH + 0.06, POSTER_HEIGHT + 0.06, 0.02), {
    y: back - 0.03,
    z: 0.01,
  });
  parts.add("paper", buildSheet(POSTER_WIDTH, POSTER_HEIGHT, 0.004), { y: back, z: 0.022 });
  const flat = (
    surface: keyof typeof POSTER_SURFACES,
    w: number,
    h: number,
    x: number,
    y: number,
  ) => parts.add(surface, buildSheet(w, h, 0.002), { x, y, z: 0.026 });
  if (design === 0) {
    flat("green", POSTER_WIDTH - 0.06, 0.2, 0, back + 0.05);
    flat("gold", 0.2, 0.1, 0, back + 0.25);
    for (let ray = -3; ray <= 3; ray++) {
      parts.add("gold", buildSheet(0.012, 0.22, 0.002), {
        y: back + 0.3,
        z: 0.026,
        rz: ray * 0.32,
      });
    }
    flat("ink", 0.3, 0.035, 0, back + POSTER_HEIGHT - 0.1);
  } else {
    flat("red", POSTER_WIDTH - 0.06, 0.28, 0, back + 0.36);
    flat("gold", POSTER_WIDTH - 0.06, 0.06, 0, back + 0.3);
    parts.add("ink", buildCylinder(0.045, 0.045, 0.22, 12), { y: back + 0.2, z: 0.07 });
    parts.add("ink", buildCylinder(0.016, 0.03, 0.1, 10), { y: back + 0.42, z: 0.07 });
    flat("ink", 0.36, 0.04, 0, back + 0.06);
  }
  return parts.merge();
});

/** Builds a framed Deco poster, 0.56 wide and 0.78 tall, in design `0` or `1`, to hang on a wall. */
export function buildPoster(design: 0 | 1): Object3D {
  return buildPropGroup("poster", readPosterGeometry(design));
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
  const reach = 0.85;
  const drop = 0.32;
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
 * its origin, the top of the canvas, and slopes 0.85 out (+z) and 0.32 down,
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
