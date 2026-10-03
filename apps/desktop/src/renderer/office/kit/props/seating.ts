/**
 * PROTOTYPE - the office's seats: the club armchair, the stool, the waiting
 * bench and the library table with its chairs and reading lamps.
 *
 * Every seat follows one rule the colleagues rely on: a seat's centre stands
 * directly above its marker, and its top is at `SEAT_HEIGHT`, so a colleague
 * who stands on the marker and sits down lands on the cushion.
 */
import { Group, Mesh, PlaneGeometry, Shape, type Object3D } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  DESK_HEIGHT,
  LAMP,
  SEAT_HEIGHT,
  type Lamp,
  type SeatProp,
  type SeatsProp,
} from "../../engine/contracts";
import { paint } from "../../engine/palette";
import { addBankersLampParts, addChairParts, paintLitShade } from "./desk";
import {
  PartList,
  addMeshes,
  buildBlock,
  buildCylinder,
  buildExtrusion,
  buildLathe,
  buildMarker,
  buildSheet,
  memoize,
  memoizeByKey,
  readPoolMaterial,
  type Surface,
} from "./shared";

// ---------------------------------------------------------------------------
// The club armchair.

const ARMCHAIR_SURFACES = {
  fabric: { token: "room-fabric", finish: "fabric", shadow: true },
  wood: { token: "room-wood", finish: "lacquer", shift: { dl: -0.08 }, shadow: false },
} as const satisfies Record<string, Surface>;

/** How far the armchair's seat centre stands in front of its origin. */
const ARMCHAIR_SEAT_Z = 0.05;
/**
 * Where the armchair's front ends, in z: 0.19 m in front of the seat centre,
 * just behind a seated colleague's knees. The thighs rest on the cushion and
 * the shins and feet hang over its edge, instead of sinking into a deeper seat.
 */
const ARMCHAIR_FRONT_Z = 0.24;

const readArmchairGeometry = memoize(() => {
  const parts = new PartList(ARMCHAIR_SURFACES);
  const front = ARMCHAIR_FRONT_Z;
  // The base, the loose seat cushion on it, and the rounded back.
  parts.add("fabric", buildBlock(0.6, 0.27, 0.6, 0.06, 2), { y: 0.06, z: front - 0.32 });
  parts.add("fabric", buildBlock(0.58, 0.1, 0.44, 0.045, 2), {
    y: SEAT_HEIGHT - 0.1,
    z: front - 0.22,
  });
  parts.add("fabric", buildBlock(0.86, 0.58, 0.2, 0.09, 3), {
    y: 0.2,
    z: -0.32,
    rx: -0.1,
  });
  // A soft back cushion leaning on the back.
  parts.add("fabric", buildBlock(0.56, 0.36, 0.12, 0.05, 2), {
    y: SEAT_HEIGHT - 0.02,
    z: -0.23,
    rx: -0.16,
  });
  // The rolled arms, one either side.
  for (const side of [-1, 1]) {
    parts.add("fabric", buildBlock(0.15, 0.5, 0.62, 0.07, 3), {
      x: side * 0.355,
      y: 0.06,
      z: front - 0.32,
    });
    parts.add("fabric", buildCylinder(0.085, 0.085, 0.58, 20), {
      x: side * 0.36,
      y: 0.52,
      z: front - 0.03,
      rx: -Math.PI / 2,
    });
  }
  // Four short, turned feet.
  for (const x of [-0.34, 0.34]) {
    for (const footZ of [-0.3, front - 0.09]) {
      parts.add(
        "wood",
        buildLathe(
          [
            [0, 0],
            [0.028, 0],
            [0.036, 0.03],
            [0.04, 0.06],
            [0, 0.06],
          ],
          12,
        ),
        { x, z: footZ },
      );
    }
  }
  return parts.merge();
});

/**
 * Builds a club armchair, 0.89 wide, 0.66 deep (z from -0.42 to 0.24) and
 * 0.8 tall. Its sitter faces +z; the seat's centre is above the marker at
 * (0, 0, 0.05), its top at `SEAT_HEIGHT`.
 */
export function buildArmchair(): SeatProp {
  const object = new Group();
  object.name = "armchair";
  addMeshes(object, readArmchairGeometry());
  const seatMarker = buildMarker(0, ARMCHAIR_SEAT_Z, 0);
  object.add(seatMarker);
  return { object, seatMarker };
}

// ---------------------------------------------------------------------------
// The stool.

const STOOL_SURFACES = {
  fabric: { token: "room-fabric", finish: "fabric", shadow: true },
  brass: { token: "brass", finish: "brass", shadow: true },
  base: { token: "room-inlay-2", finish: "lacquer", shadow: true },
} as const satisfies Record<string, Surface>;

const readStoolGeometry = memoize(() => {
  const parts = new PartList(STOOL_SURFACES);
  // A round buttoned cushion on a lacquered rim, on a brass column and a stepped foot.
  parts.add(
    "fabric",
    buildLathe(
      [
        [0, SEAT_HEIGHT - 0.075],
        [0.17, SEAT_HEIGHT - 0.075],
        [0.188, SEAT_HEIGHT - 0.06],
        [0.192, SEAT_HEIGHT - 0.035],
        [0.18, SEAT_HEIGHT - 0.01],
        [0.14, SEAT_HEIGHT - 0.001],
        [0.03, SEAT_HEIGHT - 0.006],
        [0, SEAT_HEIGHT - 0.008],
      ],
      28,
    ),
  );
  parts.add("base", buildCylinder(0.17, 0.15, 0.03, 28), { y: SEAT_HEIGHT - 0.1 });
  parts.add("brass", buildCylinder(0.024, 0.03, SEAT_HEIGHT - 0.1 - 0.05, 12), { y: 0.05 });
  parts.add("brass", buildCylinder(0.038, 0.038, 0.02, 16), { y: SEAT_HEIGHT - 0.125 });
  parts.add(
    "base",
    buildLathe(
      [
        [0, 0],
        [0.17, 0],
        [0.172, 0.018],
        [0.13, 0.03],
        [0.06, 0.05],
        [0, 0.052],
      ],
      28,
    ),
  );
  return parts.merge();
});

/**
 * Builds a low round stool, 0.38 across and `SEAT_HEIGHT` tall: a cushion
 * on a brass column. Its sitter faces +z, over the marker at its centre.
 */
export function buildStool(): SeatProp {
  const object = new Group();
  object.name = "stool";
  addMeshes(object, readStoolGeometry());
  const seatMarker = buildMarker(0, 0, 0);
  object.add(seatMarker);
  return { object, seatMarker };
}

// ---------------------------------------------------------------------------
// The waiting bench.

const BENCH_SURFACES = {
  wood: { token: "room-wood", finish: "lacquer", shadow: true },
  fabric: { token: "room-fabric", finish: "fabric", shadow: true },
  brass: { token: "brass", finish: "brass", shadow: false },
} as const satisfies Record<string, Surface>;

/** The width of one bench seat, and of one seat at the library table. */
const BENCH_PITCH = 0.6;
/** The thickness of the bench's end panels, which stand outside the seats. */
const BENCH_END = 0.06;

const readBenchGeometry = memoizeByKey((seats: number) => {
  const parts = new PartList(BENCH_SURFACES);
  const width = seats * BENCH_PITCH;
  // One long seat cushion with a seam between seats, on a wooden rail.
  for (let seat = 0; seat < seats; seat++) {
    parts.add("fabric", buildBlock(BENCH_PITCH - 0.012, 0.08, 0.46, 0.035, 2), {
      x: -width / 2 + BENCH_PITCH / 2 + seat * BENCH_PITCH,
      y: SEAT_HEIGHT - 0.08,
      z: 0.04,
    });
  }
  parts.add("wood", buildBlock(width, 0.08, 0.48, 0.015, 1), { y: SEAT_HEIGHT - 0.155, z: 0.02 });
  parts.add("brass", buildBlock(width - 0.04, 0.012, 0.012, 0.005, 1), {
    y: SEAT_HEIGHT - 0.125,
    z: 0.265,
  });
  // The padded back on a wooden frame.
  parts.add("wood", buildBlock(width, 0.36, 0.05, 0.02, 1), {
    y: SEAT_HEIGHT - 0.04,
    z: -0.22,
    rx: -0.1,
  });
  parts.add("fabric", buildBlock(width - 0.08, 0.28, 0.06, 0.03, 2), {
    y: SEAT_HEIGHT + 0.01,
    z: -0.185,
    rx: -0.1,
  });
  // Two end panels with a rounded, stepped top, which stand on the floor.
  const end = new Shape();
  end.moveTo(-0.27, 0);
  end.lineTo(0.27, 0);
  end.lineTo(0.27, 0.5);
  end.absarc(0.17, 0.5, 0.1, 0, Math.PI / 2, false);
  end.lineTo(-0.12, 0.6);
  end.lineTo(-0.12, 0.78);
  end.absarc(-0.2, 0.78, 0.08, 0, Math.PI, false);
  end.lineTo(-0.28, 0);
  for (const side of [-1, 1]) {
    parts.add("wood", buildExtrusion(end, BENCH_END - 0.016, 0.008, 8), {
      x: side * (width / 2 + BENCH_END / 2) + (BENCH_END - 0.016) / 2,
      ry: -Math.PI / 2,
    });
  }
  return parts.merge();
});

/**
 * Builds a waiting bench of `seats` seats, along x. Its sitters face +z; the
 * markers are 0.6 apart at z = 0.05. The bench is `seats` x 0.6 + 0.12 wide
 * (its end panels stand outside the seats), 0.56 deep (z from -0.28 to
 * 0.28) and 0.86 tall.
 */
export function buildBench(seats: number): SeatsProp {
  const object = new Group();
  object.name = "bench";
  addMeshes(object, readBenchGeometry(seats));
  const width = seats * BENCH_PITCH;
  const seatMarkers = Array.from({ length: seats }, (_, index) =>
    buildMarker(-width / 2 + BENCH_PITCH / 2 + index * BENCH_PITCH, 0.05, 0),
  );
  object.add(...seatMarkers);
  return { object, seatMarkers };
}

// ---------------------------------------------------------------------------
// The library table.

const TABLE_SURFACES = {
  wood: { token: "room-wood", finish: "lacquer", shadow: true },
  fabric: { token: "room-fabric", finish: "fabric", shadow: true },
  leather: {
    token: "room-fabric",
    finish: "satin",
    shift: { dl: -0.08, dc: -0.01 },
    shadow: false,
  },
  brass: { token: "brass", finish: "brass", shadow: true },
  shade: { token: "room-lamp", finish: "gloss", shadow: true, changesAtRuntime: true },
  paper: { token: "room-paper", finish: "paper", shadow: false },
  cover: { token: "room-inlay-2", finish: "satin", shadow: false },
} as const satisfies Record<string, Surface>;

/** The width each seat takes along the library table. */
const TABLE_PITCH = 0.8;
/** How far the library table's chairs stand from its long middle line. */
const TABLE_CHAIR_Z = 0.75;

/** Returns the x of each seat along a library table of `seats` seats a side. */
function placeTableSeats(seats: number): number[] {
  const width = seats * TABLE_PITCH;
  return Array.from(
    { length: seats },
    (_, index) => -width / 2 + TABLE_PITCH / 2 + index * TABLE_PITCH,
  );
}

/** Returns the x of each reading lamp: one between each pair of seats, or one in the middle. */
function placeTableLamps(seats: number): number[] {
  const seatXs = placeTableSeats(seats);
  if (seats < 2) return [0];
  return seatXs.slice(1).map((x) => x - TABLE_PITCH / 2);
}

const readTableGeometry = memoizeByKey((seats: number) => {
  const parts = new PartList(TABLE_SURFACES);
  const width = seats * TABLE_PITCH;
  const top = DESK_HEIGHT;
  // The top, with a green leather writing surface set into it.
  parts.add("wood", buildBlock(width, 0.05, 1.0, 0.025, 2), { y: top - 0.05 });
  parts.add("leather", buildSheet(width - 0.16, 0.003, 0.84), { y: top - 0.001 });
  parts.add("wood", buildBlock(width - 0.1, 0.06, 0.9, 0.012, 1), { y: top - 0.11 });
  // Two stepped trestle ends near the table's ends, joined by a low stretcher.
  for (const side of [-1, 1]) {
    const x = side * (width / 2 - 0.13);
    parts.add("wood", buildBlock(0.16, 0.05, 0.86, 0.02, 2), { x });
    parts.add("wood", buildBlock(0.12, 0.04, 0.76, 0.015, 1), { x, y: 0.05 });
    parts.add("wood", buildBlock(0.08, top - 0.11 - 0.09, 0.56, 0.02, 2), { x, y: 0.09 });
    parts.add("brass", buildBlock(0.084, 0.012, 0.5, 0.005, 1), { x, y: 0.3 });
  }
  parts.add("wood", buildBlock(width - 0.3, 0.05, 0.07, 0.02, 1), { y: 0.14 });
  // Reading lamps along the middle, their shades level to light both sides.
  for (const x of placeTableLamps(seats)) {
    parts.nest({ x, y: top }, () => addBankersLampParts(parts, 0));
  }
  // A closed book and an open one, for a reader who stepped away.
  const seatXs = placeTableSeats(seats);
  const first = seatXs[0] ?? 0;
  const last = seatXs[seatXs.length - 1] ?? 0;
  parts.nest({ x: first + 0.1, y: top, z: 0.28, ry: 0.3 }, () => {
    parts.add("cover", buildBlock(0.15, 0.03, 0.21, 0.004, 1));
    parts.add("paper", buildSheet(0.14, 0.024, 0.195), { x: 0.004, y: 0.003 });
    parts.add("cover", buildBlock(0.13, 0.025, 0.18, 0.004, 1), { y: 0.03, ry: -0.2 });
  });
  parts.nest({ x: last - 0.05, y: top, z: -0.3, ry: Math.PI - 0.15 }, () => {
    for (const side of [-1, 1]) {
      parts.add("cover", buildSheet(0.15, 0.004, 0.21), { x: side * 0.076, rz: side * -0.06 });
      parts.add("paper", buildSheet(0.14, 0.012, 0.2), {
        x: side * 0.074,
        y: 0.004,
        rz: side * -0.06,
      });
    }
  });
  // The chairs: the first row on the +z side, facing -z, then the -z side, facing +z.
  for (const x of seatXs) {
    parts.nest({ x, z: TABLE_CHAIR_Z, ry: Math.PI }, () => addChairParts(parts));
    parts.nest({ x, z: -TABLE_CHAIR_Z }, () => addChairParts(parts));
  }
  return parts.merge();
});

/** Returns the merged pools of light the library table's lamps throw on its top. */
const readTablePoolGeometry = memoizeByKey((seats: number) => {
  const pools = placeTableLamps(seats).map((x) =>
    new PlaneGeometry(0.7, 0.9).rotateX(-Math.PI / 2).translate(x, 0, 0),
  );
  const merged = mergeGeometries(pools);
  if (merged === null) throw new Error("The props kit could not merge the table's pools of light.");
  return merged;
});

/**
 * Builds a long library table with `seats` chairs on each long side, along
 * x: the first half of the markers on the +z side facing -z, then the -z
 * side facing +z. The table is `seats` x 0.8 wide and 1.0 deep; with its
 * chairs it is 2.1 deep (z from -1.05 to 1.05). Its reading lamps are a room
 * light: the office lights them in the evening (`userData[LAMP]`), with no
 * real light, only lit shades and soft pools on the leather.
 */
export function buildLongTable(seats: number): SeatsProp {
  const object = new Group();
  object.name = "long-table";
  const meshes = addMeshes(object, readTableGeometry(seats));
  const shade = meshes.get("shade")!;
  const pool = new Mesh(readTablePoolGeometry(seats), readPoolMaterial());
  pool.position.y = DESK_HEIGHT + 0.004;
  pool.renderOrder = 1;
  pool.visible = false;
  object.add(pool);
  const lamp: Lamp = {
    setOn(on) {
      shade.material = on ? paintLitShade() : paint("room-lamp", "gloss");
      pool.visible = on;
    },
  };
  object.userData[LAMP] = lamp;
  const seatXs = placeTableSeats(seats);
  const seatMarkers: Object3D[] = [
    ...seatXs.map((x) => buildMarker(x, TABLE_CHAIR_Z, Math.PI)),
    ...seatXs.map((x) => buildMarker(x, -TABLE_CHAIR_Z, 0)),
  ];
  object.add(...seatMarkers);
  return { object, seatMarkers };
}
