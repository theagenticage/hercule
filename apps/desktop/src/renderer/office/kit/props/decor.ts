/**
 * What makes the office lived in: potted plants, rugs, the tea
 * trolley and the coat stand.
 */
import { Shape, Vector3, type BufferGeometry, type Object3D } from "three";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { addCupParts } from "./desk";
import {
  PartList,
  buildBlock,
  buildCylinder,
  buildExtrusion,
  buildLathe,
  buildPropGroup,
  buildRing,
  buildRod,
  buildSheet,
  buildSphere,
  createRandom,
  memoizeByKey,
  memoize,
  type PartSink,
  type Surface,
} from "./shared";

// ---------------------------------------------------------------------------
// Plants.

const PLANT_SURFACES = {
  pot: { token: "room-inlay-2", finish: "lacquer", shadow: true },
  brass: { token: "brass", finish: "brass", shadow: false },
  soil: { token: "room-wood", finish: "matte", shift: { dl: -0.28, dc: -0.03 }, shadow: false },
  dark: { token: "room-plant", finish: "satin", shift: { dl: -0.12, dc: -0.02 }, shadow: true },
  light: { token: "room-plant", finish: "satin", shift: { dl: 0.03 }, shadow: true },
} as const satisfies Record<string, Surface>;

type LeafSurface = "dark" | "light";

/**
 * Builds a leaf `length` long that rises from the origin along +x at `pitch`
 * radians and droops under its own weight by `droop`.
 *
 * - A plain leaf is a broad blade, pointed at its tip, a little cupped.
 * - A `feathered` leaf is a palm frond: long leaflets swept toward its tip,
 *   which hang down from the rib on either side.
 */
function buildLeaf(
  length: number,
  width: number,
  pitch: number,
  droop: number,
  feathered: boolean,
): BufferGeometry {
  const outline = new Shape();
  outline.moveTo(0, 0);
  if (feathered) {
    const leaflets = 11;
    const reach = (t: number) => width * Math.sin(Math.PI * Math.min(1, 0.15 + t)) * (1 - t * 0.3);
    for (let leaflet = 0; leaflet < leaflets; leaflet++) {
      const t = (leaflet + 0.5) / (leaflets + 0.5);
      outline.lineTo(length * t, reach(t) * 0.06);
      outline.lineTo(length * (t + 0.09), reach(t));
      outline.lineTo(length * (t + 0.035), reach(t) * 0.06);
    }
    outline.lineTo(length, 0);
    for (let leaflet = leaflets - 1; leaflet >= 0; leaflet--) {
      const t = (leaflet + 0.5) / (leaflets + 0.5);
      outline.lineTo(length * (t + 0.035), -reach(t) * 0.06);
      outline.lineTo(length * (t + 0.09), -reach(t));
      outline.lineTo(length * t, -reach(t) * 0.06);
    }
  } else {
    outline.bezierCurveTo(length * 0.25, width * 0.75, length * 0.75, width * 0.75, length, 0);
    outline.bezierCurveTo(length * 0.75, -width * 0.75, length * 0.25, -width * 0.75, 0, 0);
  }
  outline.closePath();
  const geometry = buildExtrusion(outline, 0.004, 0, feathered ? 1 : 8).rotateX(-Math.PI / 2);
  // Bend the flat blade: up at its pitch, then down as it reaches out. A
  // plain leaf cups up across its width; a frond's leaflets hang down.
  const sideways = feathered ? -0.75 : 0.3;
  const position = geometry.getAttribute("position");
  for (let index = 0; index < position.count; index++) {
    const x = position.getX(index);
    const z = position.getZ(index);
    const lift = x * Math.tan(pitch) - droop * x * x + Math.abs(z) * sideways;
    position.setY(index, position.getY(index) + lift);
  }
  return toCreasedNormals(geometry, (60 / 180) * Math.PI);
}

/** Adds a pot: a lacquered, stepped Deco planter `radius` wide and `height` tall, with a brass band and soil. */
function addPot(
  parts: PartSink<keyof typeof PLANT_SURFACES>,
  radius: number,
  height: number,
): void {
  parts.add(
    "pot",
    buildLathe(
      [
        [0, 0],
        [radius * 0.72, 0],
        [radius * 0.74, height * 0.08],
        [radius * 0.82, height * 0.1],
        [radius * 0.94, height * 0.82],
        [radius, height * 0.84],
        [radius, height],
        [radius * 0.88, height],
        [radius * 0.86, height * 0.9],
        [0, height * 0.9],
      ],
      32,
    ),
  );
  parts.add("brass", buildCylinder(radius * 0.92, radius * 0.9, height * 0.05, 32), {
    y: height * 0.6,
  });
  parts.add("soil", buildCylinder(radius * 0.87, radius * 0.87, 0.01, 24), { y: height * 0.88 });
}

/** Adds leaves around a point, in turn dark and light, each turned by its own angle. */
function addLeaves(
  parts: PartSink<LeafSurface>,
  random: () => number,
  count: number,
  build: (index: number) => BufferGeometry,
): void {
  for (let index = 0; index < count; index++) {
    const surface: LeafSurface = index % 3 === 0 ? "light" : "dark";
    parts.add(surface, build(index), { ry: (index / count) * Math.PI * 2 + random() * 0.5 });
  }
}

const readPlantGeometry = memoizeByKey((size: "small" | "tall") => {
  const parts = new PartList(PLANT_SURFACES);
  const random = createRandom(size === "tall" ? 5 : 3);
  if (size === "small") {
    // An aspidistra: broad blades from the soil, two of them grown long enough to spill over the rim.
    addPot(parts, 0.15, 0.24);
    parts.nest({ y: 0.21 }, () => {
      addLeaves(parts, random, 9, (index) => {
        const long = index === 2 || index === 6;
        const length = long ? 0.44 : 0.3 + random() * 0.1;
        return buildLeaf(length, 0.11, long ? 0.6 : 0.85 + random() * 0.3, long ? 3 : 2.1, false);
      });
    });
    return parts.merge();
  }
  // A kentia palm: a tall planter, slim stems, and arching fronds.
  addPot(parts, 0.2, 0.42);
  const crowns: ReadonlyArray<readonly [number, number, number]> = [
    [0.02, 1.1, 0.0],
    [-0.04, 0.92, 0.04],
    [0.05, 0.78, -0.04],
  ];
  for (const [x, height, z] of crowns) {
    parts.add(
      "dark",
      buildRod(new Vector3(x * 0.3, 0.38, z * 0.3), new Vector3(x, height, z), 0.009, 6),
    );
    parts.nest({ x, y: height, z }, () => {
      addLeaves(parts, random, 5, () =>
        buildLeaf(0.5 + random() * 0.18, 0.15, 0.55 + random() * 0.5, 1.5 + random() * 0.6, true),
      );
    });
  }
  return parts.merge();
});

/**
 * Builds a potted plant in a lacquered Deco planter with a brass band. A
 * small one is an aspidistra about 0.75 across and 0.5 tall, its pot 0.3
 * across; a tall one is a kentia palm about 1.3 across and 1.4 tall, its pot
 * 0.4 across. Both are a little overgrown.
 */
export function buildPlant(size: "small" | "tall"): Object3D {
  return buildPropGroup(`plant-${size}`, readPlantGeometry(size));
}

// ---------------------------------------------------------------------------
// The rug.

const RUG_SURFACES = {
  border: { token: "room-inlay-2", finish: "fabric", shadow: false },
  field: { token: "room-fabric", finish: "fabric", shift: { dl: -0.03, dc: -0.01 }, shadow: false },
  pattern: { token: "room-cork", finish: "fabric", shadow: false },
} as const satisfies Record<string, Surface>;

const readRugGeometry = memoizeByKey((size: string) => {
  const [width = 2, depth = 1.4] = size.split("x").map(Number);
  const parts = new PartList(RUG_SURFACES);
  // Layers 2 mm apart, so they never flicker into each other at a distance.
  parts.add("border", buildSheet(width, 0.008, depth));
  // A fine line inside the border, then the field.
  const line = 0.07;
  for (const side of [-1, 1]) {
    parts.add("pattern", buildSheet(width - line * 2 + 0.02, 0.01, 0.02), {
      z: side * (depth / 2 - line),
    });
    parts.add("pattern", buildSheet(0.02, 0.01, depth - line * 2), {
      x: side * (width / 2 - line),
    });
  }
  const inset = 0.12;
  parts.add("field", buildSheet(width - inset * 2, 0.01, depth - inset * 2));
  // A stepped diamond in the middle: bands that narrow away from the centre line.
  const scale = Math.min(1, depth / 1.4, width / 2);
  const band = 0.034 * scale;
  [0.4, 0.3, 0.2, 0.1].forEach((span, step) => {
    for (const side of step === 0 ? [0] : [-1, 1]) {
      parts.add("pattern", buildSheet(span * 2 * scale, 0.012, band), { z: side * step * band });
    }
  });
  parts.add("border", buildSheet(0.1 * scale, 0.014, band));
  // A stepped bracket in each corner of the field.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const cx = sx * (width / 2 - inset - 0.05);
      const cz = sz * (depth / 2 - inset - 0.05);
      parts.add("pattern", buildSheet(0.18, 0.012, 0.018), { x: cx - sx * 0.081, z: cz });
      parts.add("pattern", buildSheet(0.018, 0.012, 0.18), { x: cx, z: cz - sz * 0.081 });
      parts.add("pattern", buildSheet(0.09, 0.012, 0.018), {
        x: cx - sx * 0.081,
        z: cz - sz * 0.05,
      });
      parts.add("pattern", buildSheet(0.018, 0.012, 0.09), {
        x: cx - sx * 0.05,
        z: cz - sz * 0.081,
      });
    }
  }
  // A short fringe along both narrow ends.
  const tassels = Math.floor(depth / 0.035);
  for (const side of [-1, 1]) {
    for (let tassel = 0; tassel < tassels; tassel++) {
      parts.add("pattern", buildSheet(0.04, 0.004, 0.008), {
        x: side * (width / 2 + 0.018),
        z: -depth / 2 + (tassel + 0.5) * (depth / tassels),
      });
    }
  }
  return parts.merge();
});

/**
 * Builds a rug `width` by `depth`, lying flat on the floor, with a short
 * fringe that reaches 0.04 past each end along x. It is 0.014 tall and
 * casts no shadow.
 */
export function buildRug(width: number, depth: number): Object3D {
  return buildPropGroup("rug", readRugGeometry(`${width}x${depth}`));
}

// ---------------------------------------------------------------------------
// The tea trolley.

const TROLLEY_SURFACES = {
  brass: { token: "brass", finish: "brass", shadow: true },
  wood: { token: "room-wood", finish: "lacquer", shadow: true },
  wheel: { token: "room-inlay-2", finish: "lacquer", shadow: true },
  china: { token: "room-paper", finish: "gloss", shadow: false },
  tisane: {
    token: "room-wood",
    finish: "gloss",
    shift: { dl: 0.06, dc: 0.02, dh: 15 },
    shadow: false,
  },
} as const satisfies Record<string, Surface>;

/** Adds a round china teapot, its spout toward +x, standing at the origin. */
function addTeapot(parts: PartSink<"china">): void {
  // The body is a slice of an ellipse, sampled finely enough that its outline stays round up close.
  const body = Array.from({ length: 13 }, (_, step): [number, number] => {
    const y = (step / 12) * 0.108;
    return [0.078 * Math.sqrt(1 - ((y - 0.05) / 0.065) ** 2), y];
  });
  parts.add(
    "china",
    buildLathe(
      [[0, 0], ...body, [0.03, 0.11], [0.034, 0.118], [0.012, 0.128], [0.014, 0.138], [0, 0.142]],
      24,
    ),
  );
  parts.add("china", buildCylinder(0.008, 0.016, 0.09, 10), { x: 0.06, y: 0.035, rz: -0.9 });
  parts.add("china", buildRing(0.035, 0.007, Math.PI * 1.2, 6, 14), {
    x: -0.075,
    y: 0.065,
    rz: Math.PI * 0.4,
  });
}

const readTrolleyGeometry = memoize(() => {
  const parts = new PartList(TROLLEY_SURFACES);
  const halfX = 0.32;
  const halfZ = 0.18;
  // Four wheels, four brass posts, and a push handle at the -x end.
  for (const x of [-halfX, halfX]) {
    for (const z of [-halfZ, halfZ]) {
      parts.add("wheel", buildCylinder(0.04, 0.04, 0.025, 16), {
        x: x - 0.0125,
        y: 0.04,
        z,
        rz: -Math.PI / 2,
      });
      parts.add("brass", buildCylinder(0.011, 0.011, x < 0 ? 0.84 : 0.73, 10), { x, y: 0.04, z });
    }
  }
  parts.add(
    "brass",
    buildRod(
      new Vector3(-halfX, 0.88, -halfZ - 0.01),
      new Vector3(-halfX, 0.88, halfZ + 0.01),
      0.013,
      10,
    ),
  );
  for (const z of [-halfZ, halfZ]) {
    parts.add("brass", buildSphere(0.016, 10, 8), { x: -halfX, y: 0.88, z: z * 1.06 });
    parts.add("brass", buildSphere(0.016, 10, 8), { x: halfX, y: 0.775, z });
  }
  // Two trays; the top one has a raised rim.
  for (const y of [0.25, 0.73]) {
    parts.add("wood", buildBlock(halfX * 2 + 0.08, 0.025, halfZ * 2 + 0.08, 0.012, 2), { y });
  }
  for (const side of [-1, 1]) {
    parts.add("wood", buildBlock(halfX * 2 + 0.08, 0.035, 0.014, 0.006, 1), {
      y: 0.75,
      z: side * (halfZ + 0.033),
    });
    parts.add("wood", buildBlock(0.014, 0.035, halfZ * 2 + 0.08, 0.006, 1), {
      x: side * (halfX + 0.033),
      y: 0.75,
    });
  }
  // The tea service on top, and a stack of plates below.
  parts.nest({ x: -0.1, y: 0.755 }, () => addTeapot(parts));
  parts.nest({ x: 0.16, y: 0.755, z: -0.08, ry: 0.5 }, () => addCupParts(parts));
  parts.nest({ x: 0.2, y: 0.755, z: 0.1, ry: -0.9 }, () => addCupParts(parts));
  parts.nest({ x: 0.06, y: 0.275, z: 0.02 }, () => {
    for (let plate = 0; plate < 4; plate++) {
      parts.add(
        "china",
        buildLathe(
          [
            [0, 0],
            [0.06, 0],
            [0.09, 0.008],
            [0.1, 0.014],
            [0.094, 0.015],
            [0, 0.009],
          ],
          24,
        ),
        { y: plate * 0.012 },
      );
    }
  });
  return parts.merge();
});

/**
 * Builds a tea trolley with a pot and two cups on top and plates below: 0.81
 * wide (with its push handle at -x), 0.47 deep and 0.9 tall.
 */
export function buildTeaTrolley(): Object3D {
  return buildPropGroup("tea-trolley", readTrolleyGeometry());
}

// ---------------------------------------------------------------------------
// The coat stand.

const STAND_SURFACES = {
  wood: { token: "room-wood", finish: "lacquer", shadow: true },
  base: { token: "room-inlay-2", finish: "lacquer", shadow: true },
  brass: { token: "brass", finish: "brass", shadow: false },
  coat: { token: "room-cork", finish: "fabric", shift: { dl: -0.1, dc: 0.015 }, shadow: true },
  hat: { token: "room-inlay-2", finish: "fabric", shadow: true },
  band: { token: "brass", finish: "satin", shadow: false },
} as const satisfies Record<string, Surface>;

const STAND_HEIGHT = 1.55;

const readStandGeometry = memoize(() => {
  const parts = new PartList(STAND_SURFACES);
  parts.add(
    "base",
    buildLathe(
      [
        [0, 0],
        [0.17, 0],
        [0.172, 0.02],
        [0.13, 0.035],
        [0.12, 0.05],
        [0.05, 0.065],
        [0, 0.07],
      ],
      32,
    ),
  );
  parts.add("wood", buildCylinder(0.02, 0.026, STAND_HEIGHT - 0.07, 12), { y: 0.07 });
  for (const y of [0.07, 0.95, STAND_HEIGHT - 0.12]) {
    parts.add("brass", buildCylinder(0.03, 0.03, 0.02, 14), { y });
  }
  parts.add("brass", buildSphere(0.03, 14, 10), { y: STAND_HEIGHT });
  // Four hooks that rise out and up, each with a ball at its tip.
  const hookAngles = [0.4, 0.4 + Math.PI / 2, 0.4 + Math.PI, 0.4 + (Math.PI * 3) / 2];
  for (const angle of hookAngles) {
    const tip = new Vector3(Math.cos(angle) * 0.13, STAND_HEIGHT - 0.04, Math.sin(angle) * 0.13);
    parts.add("brass", buildRod(new Vector3(0, STAND_HEIGHT - 0.11, 0), tip, 0.007, 6));
    parts.add("brass", buildSphere(0.014, 10, 8), { x: tip.x, y: tip.y, z: tip.z });
  }
  // A camel coat hung from the first hook, flattened toward the pole.
  const coatAngle = hookAngles[0]!;
  parts.nest(
    {
      x: Math.cos(coatAngle) * 0.13,
      y: STAND_HEIGHT - 0.06,
      z: Math.sin(coatAngle) * 0.13,
      ry: -coatAngle + Math.PI / 2,
    },
    () => {
      parts.add(
        "coat",
        buildLathe(
          [
            [0, -0.74],
            [0.165, -0.74],
            [0.18, -0.72],
            [0.15, -0.44],
            [0.145, -0.2],
            [0.15, -0.12],
            [0.12, -0.06],
            [0.06, -0.025],
            [0, 0],
          ],
          20,
        ),
        { sz: 0.45, z: -0.03 },
      );
      // A belt, tied at the waist.
      parts.add("hat", buildCylinder(0.151, 0.153, 0.035, 20), { y: -0.44, z: -0.03, sz: 0.47 });
      parts.add("coat", buildRing(0.045, 0.014, Math.PI * 2, 6, 16), {
        y: -0.03,
        rx: Math.PI / 2,
        sy: 0.6,
      });
    },
  );
  // A homburg on the top of the stand, set at an angle.
  parts.nest({ y: STAND_HEIGHT + 0.012, rz: 0.14, rx: -0.08 }, () => {
    parts.add(
      "hat",
      buildLathe(
        [
          [0, 0],
          [0.115, 0],
          [0.12, 0.012],
          [0.105, 0.008],
          [0.075, 0.01],
          [0.074, 0.06],
          [0.062, 0.078],
          [0.03, 0.07],
          [0, 0.074],
        ],
        24,
      ),
    );
    parts.add("band", buildCylinder(0.0755, 0.0755, 0.016, 24), { y: 0.012 });
  });
  return parts.merge();
});

/**
 * Builds a coat stand with a belted camel coat on one hook and a homburg on
 * top: 0.34 across its base, 0.5 across its coat, and 1.64 tall to the hat.
 */
export function buildCoatStand(): Object3D {
  return buildPropGroup("coat-stand", readStandGeometry());
}
