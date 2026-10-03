/**
 * PROTOTYPE - the office's seats: the club armchair and the waiting bench.
 *
 * Every seat follows one rule the colleagues rely on: a seat's centre stands
 * directly above its marker, and its top is at `SEAT_HEIGHT`, so a colleague
 * who stands on the marker and sits down lands on the cushion.
 */
import { Group, Shape } from "three";

import { SEAT_HEIGHT, type SeatProp, type SeatsProp } from "../../engine/contracts";

import {
  PartList,
  addMeshes,
  buildBlock,
  buildCylinder,
  buildExtrusion,
  buildLathe,
  buildMarker,
  memoize,
  memoizeByKey,
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
// The waiting bench.

const BENCH_SURFACES = {
  wood: { token: "room-wood", finish: "lacquer", shadow: true },
  fabric: { token: "room-fabric", finish: "fabric", shadow: true },
  brass: { token: "brass", finish: "brass", shadow: false },
} as const satisfies Record<string, Surface>;

/** The width of one bench seat. */
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
