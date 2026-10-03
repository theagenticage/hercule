/**
 * PROTOTYPE - the desks: a clerk's desk with its chair, and the user's
 * partner desk. A desk is the piece the office has most of (the ten-x fleet
 * has 140), so its geometry is merged into one mesh per finish and shared by
 * every desk: a desk with its chair is five meshes while its lamp is dark and
 * nothing lies on it, and eight at most.
 */
import { CapsuleGeometry, Group, Mesh, PlaneGeometry, Shape, Vector3, type Object3D } from "three";
import { DESK_HEIGHT, SEAT_HEIGHT, type DeskHandle } from "../../engine/contracts";
import { paint } from "../../engine/palette";
import {
  PartList,
  addMeshes,
  buildBlock,
  buildCylinder,
  buildExtrusion,
  buildLathe,
  buildMarker,
  buildRing,
  buildRod,
  buildSheet,
  buildSphere,
  memoize,
  memoizeByKey,
  readPoolMaterial,
  type MergedProp,
  type PartSink,
  type Surface,
} from "./shared";

/** The surfaces of a clerk's desk and its chair. */
const DESK_SURFACES = {
  wood: { token: "room-wood", finish: "lacquer", shadow: true },
  brass: { token: "brass", finish: "brass", shadow: true },
  blotter: { token: "room-desk", finish: "paper", shift: { dl: -0.05, dc: 0.012 }, shadow: false },
  shade: { token: "room-lamp", finish: "gloss", shadow: true, changesAtRuntime: true },
  machine: { token: "room-screen", finish: "lacquer", shadow: true },
  paper: { token: "room-paper", finish: "paper", shadow: false },
  fabric: { token: "room-fabric", finish: "fabric", shadow: true },
} as const satisfies Record<string, Surface>;

/** The surfaces of the things that come and go on a desk: the note and the cup. */
export const EXTRA_SURFACES = {
  note: { token: "you", finish: "paper", shadow: false },
  china: { token: "room-paper", finish: "gloss", shadow: false },
  tisane: {
    token: "room-wood",
    finish: "gloss",
    shift: { dl: 0.06, dc: 0.02, dh: 15 },
    shadow: false,
  },
} as const satisfies Record<string, Surface>;

/** The lit green glass of a banker's lamp: the book's `--lamp-on`, a touch lighter and yellower than the dark glass. */
export function paintLitShade() {
  return paint("room-lamp", "glow", { dl: 0.06, dc: -0.01, dh: -4 });
}

// ---------------------------------------------------------------------------
// Parts shared by several props: the chair, the banker's lamp, the cup.

export type ChairSurface = "wood" | "fabric";

/**
 * Adds a clerk's chair: a round upholstered seat on four legs, with a curved
 * wooden back. Its seat's centre is at the origin, its top at `SEAT_HEIGHT`,
 * and its sitter faces +z.
 */
export function addChairParts(parts: PartSink<ChairSurface>): void {
  const seatTop = SEAT_HEIGHT;
  parts.add("fabric", buildBlock(0.44, 0.075, 0.42, 0.035, 2), { y: seatTop - 0.075 });
  parts.add("wood", buildBlock(0.42, 0.05, 0.4, 0.018, 1), { y: seatTop - 0.12 });
  for (const x of [-0.17, 0.17]) {
    for (const z of [-0.155, 0.155]) {
      parts.add("wood", buildCylinder(0.017, 0.022, seatTop - 0.12, 10), { x, z });
    }
  }
  // The back: a band of wood curved around the sitter, on two posts.
  const back = new Shape();
  const spread = 0.95;
  const start = Math.PI / 2 - spread;
  const end = Math.PI / 2 + spread;
  back.absarc(0, 0, 0.305, start, end, false);
  back.absarc(0, 0, 0.27, end, start, true);
  parts.add("wood", buildExtrusion(back, 0.17, 0.012, 6), {
    y: seatTop + 0.08,
    rx: -Math.PI / 2,
  });
  const cushion = new Shape();
  const padSpread = 0.72;
  cushion.absarc(0, 0, 0.272, Math.PI / 2 - padSpread, Math.PI / 2 + padSpread, false);
  cushion.absarc(0, 0, 0.25, Math.PI / 2 + padSpread, Math.PI / 2 - padSpread, true);
  parts.add("fabric", buildExtrusion(cushion, 0.11, 0.012, 5), {
    y: seatTop + 0.11,
    rx: -Math.PI / 2,
  });
  for (const x of [-0.15, 0.15]) {
    parts.add("wood", buildCylinder(0.014, 0.014, 0.12, 8), {
      x,
      y: seatTop - 0.03,
      z: -Math.sqrt(0.2875 ** 2 - x * x),
    });
  }
}

export type LampSurface = "brass" | "shade";

/** Builds a banker's lamp's shade: half a capsule lying along x, flat underneath. */
function buildShadeGeometry() {
  const geometry = new CapsuleGeometry(0.052, 0.17, 6, 20).rotateZ(Math.PI / 2);
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  for (let index = 0; index < position.count; index++) {
    if (position.getY(index) < 0) {
      position.setY(index, 0);
      normal.setXYZ(index, 0, -1, 0);
    }
  }
  return geometry;
}

/** The height of a banker's lamp's shade above the surface the lamp stands on. */
const SHADE_HEIGHT = 0.21;

/**
 * Adds a banker's lamp: a stepped brass foot and stem under a green glass
 * shade that tilts toward +z by `tilt` radians. Its foot stands at the origin.
 * A lamp with no tilt hangs its shade level over the stem, to light both sides
 * of a table.
 */
export function addBankersLampParts(parts: PartSink<LampSurface>, tilt = 0.28): void {
  parts.add(
    "brass",
    buildLathe([
      [0, 0],
      [0.068, 0],
      [0.07, 0.008],
      [0.058, 0.016],
      [0.032, 0.022],
      [0.012, 0.03],
      [0, 0.03],
    ]),
  );
  parts.add("brass", buildCylinder(0.0075, 0.0075, SHADE_HEIGHT - 0.03, 8), { y: 0.03 });
  parts.add("shade", buildShadeGeometry(), {
    y: SHADE_HEIGHT - 0.012,
    z: tilt === 0 ? 0 : 0.04,
    rx: tilt,
  });
}

/** Returns the shared flat plane of a pool of light, by its size as "<width>x<depth>". */
const readPoolGeometry = memoizeByKey((size: string) => {
  const [width = 1, depth = 1] = size.split("x").map(Number);
  return new PlaneGeometry(width, depth).rotateX(-Math.PI / 2);
});

/**
 * Builds the pool of light a lit banker's lamp throws, `width` by `depth`,
 * lying flat and centred at the origin. It starts hidden.
 */
export function buildPoolMesh(width: number, depth: number): Mesh {
  const mesh = new Mesh(readPoolGeometry(`${width}x${depth}`), readPoolMaterial());
  mesh.renderOrder = 1;
  mesh.visible = false;
  mesh.name = "lamp-pool";
  return mesh;
}

export type CupSurface = "china" | "tisane";

/** Adds a cup of tisane on its saucer, standing at the origin, its handle toward +x. */
export function addCupParts(parts: PartSink<CupSurface>): void {
  parts.add(
    "china",
    buildLathe(
      [
        [0, 0],
        [0.045, 0],
        [0.06, 0.004],
        [0.068, 0.012],
        [0.064, 0.013],
        [0.05, 0.008],
        [0, 0.008],
      ],
      20,
    ),
  );
  parts.add(
    "china",
    buildLathe(
      [
        [0, 0.008],
        [0.022, 0.008],
        [0.034, 0.024],
        [0.039, 0.05],
        [0.035, 0.05],
        [0.03, 0.026],
        [0.019, 0.014],
        [0, 0.014],
      ],
      20,
    ),
  );
  parts.add("china", buildRing(0.013, 0.0035, Math.PI * 1.3, 4, 10), {
    x: 0.043,
    y: 0.032,
    rz: -Math.PI * 0.65,
  });
  parts.add("tisane", buildCylinder(0.031, 0.031, 0.002, 16), { y: 0.038 });
}

/** Adds a typewriter whose keys face +z, standing at the origin. */
function addTypewriterParts(parts: PartSink<"machine" | "paper" | "brass">): void {
  parts.add("machine", buildBlock(0.3, 0.06, 0.2, 0.025, 2));
  parts.add("machine", buildBlock(0.27, 0.05, 0.085, 0.02, 2), { y: 0.04, z: -0.05 });
  // The platen, the roller the paper wraps around, with a knob at each end.
  parts.add("machine", buildCylinder(0.021, 0.021, 0.33, 14), {
    x: 0.165,
    y: 0.105,
    z: -0.07,
    rz: Math.PI / 2,
  });
  for (const x of [-0.165, 0.185]) {
    parts.add("brass", buildCylinder(0.016, 0.016, 0.02, 10), {
      x,
      y: 0.105,
      z: -0.07,
      rz: Math.PI / 2,
    });
  }
  parts.add(
    "brass",
    buildRod(new Vector3(-0.175, 0.11, -0.07), new Vector3(-0.2, 0.135, -0.035), 0.004),
  );
  // The sheet in the machine, curling back off the platen. It stands only a
  // hand high, as on a page half typed, so it never hides the typist's face.
  parts.add("paper", buildSheet(0.19, 0.09, 0.003), { y: 0.1, z: -0.085, rx: -0.22 });
  // Three rows of round keys on the sloped front, and the space bar.
  const rows = [9, 9, 8];
  rows.forEach((count, row) => {
    for (let index = 0; index < count; index++) {
      // Each row stands a step higher than the one in front, on longer stems.
      parts.add("paper", buildCylinder(0.0098, 0.0098, 0.012 + row * 0.009, 8), {
        x: (index - (count - 1) / 2) * 0.028 + row * 0.006,
        y: 0.056,
        z: 0.07 - row * 0.03,
      });
    }
  });
  parts.add("paper", buildBlock(0.14, 0.01, 0.016, 0.005, 1), { y: 0.05, z: 0.1 });
}

// ---------------------------------------------------------------------------
// The clerk's desk.

/** How far the chair's seat stands in front of the desk's centre. */
const CHAIR_Z = 0.75;

/** Builds the clerk's desk's shared geometry. */
const readDeskGeometry = memoize(() => {
  const parts = new PartList(DESK_SURFACES);
  const top = DESK_HEIGHT;
  // The top, with a brass line under its edge.
  parts.add("wood", buildBlock(1.2, 0.045, 0.72, 0.02, 2), { y: top - 0.045 });
  parts.add("brass", buildBlock(1.16, 0.012, 0.68, 0.005, 1), { y: top - 0.057 });
  // Two pedestals of three drawers, on stepped plinths, either side of the kneehole.
  for (const side of [-1, 1]) {
    const x = side * 0.41;
    parts.add("wood", buildBlock(0.3, 0.05, 0.6, 0.012, 1), { x });
    parts.add("wood", buildBlock(0.34, top - 0.057 - 0.05, 0.64, 0.03, 2), { x, y: 0.05 });
    for (let drawer = 0; drawer < 3; drawer++) {
      const y = 0.085 + drawer * 0.18;
      parts.add("wood", buildBlock(0.28, 0.16, 0.02, 0.008, 1), { x, y, z: 0.322 });
      parts.add("brass", buildBlock(0.075, 0.013, 0.016, 0.006, 1), { x, y: y + 0.11, z: 0.336 });
    }
  }
  // The shallow centre drawer over the kneehole, and the panel at the back of it.
  parts.add("wood", buildBlock(0.48, 0.055, 0.6, 0.01, 1), { y: top - 0.112, z: -0.01 });
  parts.add("brass", buildBlock(0.1, 0.012, 0.014, 0.006, 1), { y: top - 0.09, z: 0.296 });
  parts.add("wood", buildBlock(0.48, 0.36, 0.025, 0.008, 1), { y: 0.24, z: -0.28 });
  // The blotter, the papers and the pencil cup.
  parts.add("blotter", buildSheet(0.6, 0.005, 0.34), { x: 0.02, y: top, z: 0.12 });
  [0.06, -0.09, 0.2].forEach((turn, index) => {
    parts.add("paper", buildSheet(0.15, 0.003, 0.2), {
      x: 0.45 + index * 0.006,
      y: top + index * 0.0032,
      z: -0.02,
      ry: turn,
    });
  });
  parts.nest({ x: 0.45, y: top, z: -0.24 }, () => {
    parts.add(
      "brass",
      buildLathe(
        [
          [0, 0],
          [0.031, 0],
          [0.033, 0.075],
          [0.028, 0.075],
          [0.026, 0.01],
          [0, 0.01],
        ],
        16,
      ),
    );
    for (const [dx, dz, lean] of [
      [-0.008, 0.004, -0.2],
      [0.009, -0.006, 0.16],
      [0.002, 0.01, 0.05],
    ] as const) {
      const from = new Vector3(dx, 0.01, dz);
      const to = new Vector3(dx + lean * 0.22, 0.135, dz - lean * 0.1);
      parts.add("wood", buildRod(from, to, 0.0055, 6));
    }
  });
  parts.nest({ y: top, z: 0.15 }, () => addTypewriterParts(parts));
  parts.nest({ x: -0.41, y: top, z: -0.17 }, () => addBankersLampParts(parts));
  parts.nest({ z: CHAIR_Z, ry: Math.PI }, () => addChairParts(parts));
  return parts.merge();
});

/** Builds the note's shared geometry: a marigold card folded into a tent, standing at the origin. */
const readNoteGeometry = memoize(() => {
  const parts = new PartList(EXTRA_SURFACES);
  parts.add("note", buildSheet(0.15, 0.085, 0.004), { z: 0.028, rx: -0.34 });
  parts.add("note", buildSheet(0.15, 0.085, 0.004), { z: -0.028, rx: 0.34 });
  return parts.merge();
});

/** Builds the cup's shared geometry. */
const readCupGeometry = memoize(() => {
  const parts = new PartList(EXTRA_SURFACES);
  addCupParts(parts);
  return parts.merge();
});

/** Adds an instance of `merged` that shows only while it is switched on. Returns its group. */
export function addToggle<S extends string>(
  parent: Object3D,
  merged: MergedProp<S>,
  x: number,
  y: number,
  z: number,
  turn: number,
): Group {
  const group = new Group();
  group.position.set(x, y, z);
  group.rotation.y = turn;
  group.visible = false;
  addMeshes(group, merged);
  parent.add(group);
  return group;
}

/**
 * Builds a clerk's desk with its chair, lamp and typewriter. The chair is on
 * the desk's +z side, so its sitter faces -z, across the desk.
 *
 * The desk is 1.2 wide (x) and 0.72 deep (z, from -0.36 to 0.36), its top at
 * `DESK_HEIGHT`. The chair's seat is centred on the marker at (0, 0, 0.75),
 * and its back reaches z = 1.06. The lamp's shade tops out at 0.97.
 */
export function buildDesk(): DeskHandle {
  const object = new Group();
  object.name = "desk";
  const meshes = addMeshes(object, readDeskGeometry());
  const shade = meshes.get("shade")!;
  const pool = buildPoolMesh(0.62, 0.56);
  pool.position.set(-0.28, DESK_HEIGHT + 0.0075, 0.02);
  object.add(pool);
  const note = addToggle(object, readNoteGeometry(), -0.3, DESK_HEIGHT, 0.22, 0.35);
  const cup = addToggle(object, readCupGeometry(), 0.34, DESK_HEIGHT, 0.24, -0.6);
  const seatMarker = buildMarker(0, CHAIR_Z, Math.PI);
  object.add(seatMarker);
  return {
    object,
    seatMarker,
    setLamp(on) {
      shade.material = on ? paintLitShade() : paint("room-lamp", "gloss");
      pool.visible = on;
    },
    setNote(on) {
      note.visible = on;
    },
    setCup(on) {
      cup.visible = on;
    },
  };
}

// ---------------------------------------------------------------------------
// The user's partner desk.

/** The surfaces of the user's desk and chair. */
const YOUR_DESK_SURFACES = {
  lacquer: { token: "room-inlay-2", finish: "lacquer", shadow: true },
  brass: { token: "brass", finish: "brass", shadow: true },
  blotter: { token: "room-desk", finish: "paper", shift: { dl: -0.05, dc: 0.012 }, shadow: false },
  shade: { token: "room-lamp", finish: "gloss", shadow: true, changesAtRuntime: true },
  wood: { token: "room-wood", finish: "lacquer", shadow: true },
  paper: { token: "room-paper", finish: "paper", shadow: false },
  fabric: { token: "you", finish: "fabric", shadow: true },
} as const satisfies Record<string, Surface>;

/** The radius of the rounded outer end of each of the partner desk's pedestals. */
const PEDESTAL_RADIUS = 0.36;
/** The x of the centre of the right pedestal's rounded end; the left one mirrors it. */
const PEDESTAL_END = 0.64;

/**
 * Adds the user's chair: a marigold tub chair on a swivel column. Its seat's
 * centre is at the origin, its top at `SEAT_HEIGHT`, and its sitter faces +z.
 */
function addYourChairParts(parts: PartSink<keyof typeof YOUR_DESK_SURFACES>): void {
  const seatTop = SEAT_HEIGHT;
  parts.add("fabric", buildBlock(0.5, 0.085, 0.48, 0.04, 2), { y: seatTop - 0.085, z: 0.02 });
  parts.add("lacquer", buildBlock(0.46, 0.05, 0.44, 0.02, 1), { y: seatTop - 0.13 });
  // The tub: a curved back that wraps round into arms, with a rolled top.
  const tub = new Shape();
  const spread = 1.3;
  tub.absarc(0, 0, 0.335, Math.PI / 2 - spread, Math.PI / 2 + spread, false);
  tub.absarc(0, 0, 0.275, Math.PI / 2 + spread, Math.PI / 2 - spread, true);
  parts.add("fabric", buildExtrusion(tub, 0.36, 0.02, 8), { y: seatTop - 0.13, rx: -Math.PI / 2 });
  parts.add("fabric", buildRing(0.305, 0.04, spread * 2, 10, 40), {
    y: seatTop + 0.25,
    rx: -Math.PI / 2,
    rz: Math.PI / 2 - spread,
  });
  // Round caps over the ends of the rolled top, where the arms end.
  for (const angle of [Math.PI / 2 - spread, Math.PI / 2 + spread]) {
    parts.add("fabric", buildSphere(0.04, 12, 8), {
      x: 0.305 * Math.cos(angle),
      y: seatTop + 0.25,
      z: -0.305 * Math.sin(angle),
    });
  }
  // The swivel: a brass column on a round, stepped foot.
  parts.add("brass", buildCylinder(0.03, 0.035, seatTop - 0.13 - 0.05, 12), { y: 0.05 });
  parts.add(
    "lacquer",
    buildLathe(
      [
        [0, 0],
        [0.24, 0],
        [0.245, 0.02],
        [0.2, 0.035],
        [0.08, 0.05],
        [0, 0.055],
      ],
      32,
    ),
  );
}

/** Builds the user's desk's shared geometry. */
const readYourDeskGeometry = memoize(() => {
  const parts = new PartList(YOUR_DESK_SURFACES);
  const top = DESK_HEIGHT;
  // Two streamlined pedestals with rounded outer ends, wrapped by three brass speed lines.
  for (const side of [-1, 1]) {
    parts.nest({ ry: side === 1 ? 0 : Math.PI }, () => {
      const outline = new Shape();
      outline.moveTo(0.42, -PEDESTAL_RADIUS);
      outline.lineTo(PEDESTAL_END, -PEDESTAL_RADIUS);
      outline.absarc(PEDESTAL_END, 0, PEDESTAL_RADIUS, -Math.PI / 2, Math.PI / 2, false);
      outline.lineTo(0.42, PEDESTAL_RADIUS);
      outline.lineTo(0.42, -PEDESTAL_RADIUS);
      parts.add("lacquer", buildExtrusion(outline, top - 0.13, 0.02), {
        y: 0.07,
        rx: -Math.PI / 2,
      });
      const plinth = new Shape();
      plinth.moveTo(0.45, -PEDESTAL_RADIUS + 0.03);
      plinth.lineTo(PEDESTAL_END, -PEDESTAL_RADIUS + 0.03);
      plinth.absarc(PEDESTAL_END, 0, PEDESTAL_RADIUS - 0.03, -Math.PI / 2, Math.PI / 2, false);
      plinth.lineTo(0.45, PEDESTAL_RADIUS - 0.03);
      plinth.lineTo(0.45, -PEDESTAL_RADIUS + 0.03);
      parts.add("lacquer", buildExtrusion(plinth, 0.05, 0.01), { y: 0.01, rx: -Math.PI / 2 });
      for (const y of [0.3, 0.345, 0.39]) {
        parts.add("brass", buildRing(PEDESTAL_RADIUS + 0.021, 0.0055, Math.PI, 5, 36), {
          x: PEDESTAL_END,
          y,
          rx: Math.PI / 2,
          rz: -Math.PI / 2,
        });
        for (const z of [-1, 1]) {
          parts.add(
            "brass",
            buildRod(
              new Vector3(0.43, y, z * (PEDESTAL_RADIUS + 0.021)),
              new Vector3(PEDESTAL_END, y, z * (PEDESTAL_RADIUS + 0.021)),
              0.0055,
              5,
            ),
          );
        }
      }
    });
  }
  // The top, on a brass line, and the panel the visitors face, with a brass sunburst.
  parts.add("lacquer", buildBlock(2.06, 0.05, 0.94, 0.04, 2), { y: top - 0.05 });
  parts.add("brass", buildBlock(2.0, 0.014, 0.88, 0.006, 1), { y: top - 0.064 });
  parts.add("lacquer", buildBlock(0.86, 0.46, 0.03, 0.01, 1), { y: top - 0.53, z: 0.3 });
  const sunCentre = new Vector3(0, top - 0.5, 0.318);
  for (let ray = 0; ray < 9; ray++) {
    const angle = (ray / 8) * Math.PI;
    const length = ray % 2 === 0 ? 0.3 : 0.22;
    parts.add(
      "brass",
      buildRod(
        sunCentre.clone().add(new Vector3(Math.cos(angle) * 0.06, Math.sin(angle) * 0.06, 0)),
        sunCentre.clone().add(new Vector3(Math.cos(angle) * length, Math.sin(angle) * length, 0)),
        0.004,
        5,
      ),
    );
  }
  parts.add("brass", buildSphere(0.045, 16, 8, Math.PI / 2), {
    x: sunCentre.x,
    y: sunCentre.y,
    z: sunCentre.z - 0.01,
    rx: Math.PI / 2,
    sy: 0.4,
  });
  // On the top: the blotter, the lamp, the in-tray, and the bell for visitors.
  parts.add("blotter", buildSheet(0.82, 0.005, 0.44), { y: top, z: -0.08 });
  parts.nest({ x: -0.72, y: top, z: -0.2, ry: Math.PI }, () => addBankersLampParts(parts));
  parts.nest({ x: 0.66, y: top, z: -0.12, ry: -0.08 }, () => {
    parts.add("wood", buildBlock(0.34, 0.012, 0.27, 0.006, 1));
    for (const side of [-1, 1]) {
      parts.add("wood", buildBlock(0.012, 0.035, 0.27, 0.005, 1), { x: side * 0.164 });
      parts.add("wood", buildBlock(0.34, 0.035, 0.012, 0.005, 1), { z: side * 0.129 });
    }
    parts.add("paper", buildSheet(0.26, 0.004, 0.2), { y: 0.012, ry: 0.04 });
  });
  parts.nest({ x: 0.36, y: top, z: 0.3 }, () => {
    parts.add(
      "wood",
      buildLathe(
        [
          [0, 0],
          [0.052, 0],
          [0.055, 0.01],
          [0.048, 0.016],
          [0, 0.016],
        ],
        20,
      ),
    );
    parts.add("brass", buildSphere(0.042, 20, 8, Math.PI / 2), { y: 0.016, sy: 0.9 });
    parts.add("brass", buildCylinder(0.004, 0.004, 0.02, 6), { y: 0.05 });
    parts.add("brass", buildSphere(0.008, 8, 6), { y: 0.072 });
  });
  parts.nest({ z: -0.85 }, () => addYourChairParts(parts));
  return parts.merge();
});

/** Builds the marigold cards in the user's in-tray, one per colleague waiting, up to three. */
const readTrayCardsGeometry = memoize(() => {
  const parts = new PartList(EXTRA_SURFACES);
  [0.06, -0.05, 0.12].forEach((turn, index) => {
    parts.add("note", buildSheet(0.22, 0.004, 0.15), {
      x: index * 0.012,
      y: 0.017 + index * 0.0045,
      z: index * 0.008,
      ry: turn,
    });
  });
  return parts.merge();
});

/**
 * Builds the user's own desk: a partner desk, wider than a clerk's, with
 * the user's chair on its -z side, so the user faces +z, toward visitors.
 * Its `seatMarker` is the user's chair. A visitor stands at (0, 0, 0.95),
 * facing -z.
 *
 * The desk is 2.06 wide (x, from -1.03 to 1.03) and 0.94 deep (z, from -0.47
 * to 0.47), its top at `DESK_HEIGHT`. The chair's seat is centred on the
 * marker at (0, 0, -0.85), and its back reaches z = -1.21. The brass bell
 * stands on the visitors' side of the top, the lamp and the in-tray on the
 * user's side. `setNote(true)` fills the in-tray with marigold cards.
 */
export function buildYourDesk(): DeskHandle {
  const object = new Group();
  object.name = "your-desk";
  const meshes = addMeshes(object, readYourDeskGeometry());
  const shade = meshes.get("shade")!;
  const pool = buildPoolMesh(0.8, 0.6);
  pool.position.set(-0.58, DESK_HEIGHT + 0.0075, -0.08);
  object.add(pool);
  const cards = addToggle(object, readTrayCardsGeometry(), 0.66, DESK_HEIGHT, -0.12, -0.08);
  const cup = addToggle(object, readCupGeometry(), -0.3, DESK_HEIGHT, -0.32, 0.4);
  const seatMarker = buildMarker(0, -0.85, 0);
  object.add(seatMarker);
  return {
    object,
    seatMarker,
    setLamp(on) {
      shade.material = on ? paintLitShade() : paint("room-lamp", "gloss");
      pool.visible = on;
    },
    setNote(on) {
      cards.visible = on;
    },
    setCup(on) {
      cup.visible = on;
    },
  };
}
