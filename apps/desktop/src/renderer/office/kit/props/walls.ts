/**
 * What hangs on the office's walls: the Triage room's case board, the
 * sunburst clock and the "Now serving" sign over the user's desk. Each one's
 * back is at z = 0, against the wall.
 */
import {
  CanvasTexture,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Shape,
  type Object3D,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { readColor, subscribePalette } from "../../engine/palette";
import {
  PartList,
  addMeshes,
  buildBlock,
  buildCylinder,
  buildExtrusion,
  buildRing,
  buildSheet,
  buildSphere,
  memoize,
  memoizeByKey,
  paintSurface,
  type Surface,
} from "./shared";

// ---------------------------------------------------------------------------
// The case board.

const BOARD_SURFACES = {
  wood: { token: "room-wood", finish: "lacquer", shadow: true },
  cork: { token: "room-cork", finish: "matte", shadow: false },
  brass: { token: "brass", finish: "brass", shadow: false },
} as const satisfies Record<string, Surface>;

/** The bottom and top of the cork, in the board's space. */
const CORK_BOTTOM = 0.81;
const CORK_TOP = 1.99;

const readBoardGeometry = memoizeByKey((width: number) => {
  const parts = new PartList(BOARD_SURFACES);
  const height = CORK_TOP - CORK_BOTTOM;
  // The backboard, the cork set into it, and a stepped frame around both.
  parts.add("wood", buildBlock(width, height + 0.1, 0.035, 0.01, 1), {
    y: CORK_BOTTOM - 0.05,
    z: 0.0175,
  });
  parts.add("cork", buildSheet(width - 0.08, height, 0.02), { y: CORK_BOTTOM, z: 0.045 });
  for (const side of [-1, 1]) {
    parts.add("wood", buildBlock(0.05, height + 0.1, 0.065, 0.015, 2), {
      x: side * (width / 2 - 0.025),
      y: CORK_BOTTOM - 0.05,
      z: 0.0325,
    });
  }
  parts.add("wood", buildBlock(width + 0.04, 0.06, 0.07, 0.015, 2), { y: CORK_TOP, z: 0.035 });
  parts.add("wood", buildBlock(width - 0.1, 0.03, 0.045, 0.01, 1), {
    y: CORK_TOP + 0.06,
    z: 0.025,
  });
  // The bottom rail is a ledge for chalk and spare pins, trimmed in brass.
  parts.add("wood", buildBlock(width + 0.04, 0.05, 0.09, 0.015, 2), {
    y: CORK_BOTTOM - 0.07,
    z: 0.045,
  });
  parts.add("brass", buildBlock(width + 0.02, 0.008, 0.008, 0.003, 1), {
    y: CORK_BOTTOM - 0.05,
    z: 0.092,
  });
  parts.add("brass", buildBlock(0.16, 0.035, 0.006, 0.004, 1), { y: CORK_TOP + 0.0125, z: 0.072 });
  return parts.merge();
});

/**
 * Builds the Triage room's case board, `width` wide, mounted on a wall: its
 * back is at z = 0. The board stands from y = 0.74 to 2.08 (its frame), its
 * cork from 0.81 to 1.99, and it is 0.09 deep. It is `width` + 0.04 wide at
 * its rails.
 *
 * The board is built empty. Once Triage exists (#91), Triage pins Proposals
 * on it as cards.
 */
export function buildCaseBoard(width: number): Object3D {
  const object = new Group();
  object.name = "case-board";
  addMeshes(object, readBoardGeometry(width));
  return object;
}

// ---------------------------------------------------------------------------
// The sunburst clock.

const CLOCK_SURFACES = {
  brass: { token: "brass", finish: "brass", shadow: true },
  case: { token: "room-inlay-2", finish: "lacquer", shadow: true },
  face: { token: "room-paper", finish: "paper", shadow: false },
  ink: { token: "room-inlay-2", finish: "satin", shadow: false },
} as const satisfies Record<string, Surface>;

const readClockGeometry = memoize(() => {
  const parts = new PartList(CLOCK_SURFACES);
  // The case, the face and the brass bezel, all facing +z.
  parts.add("case", buildCylinder(0.19, 0.2, 0.035, 40), { rx: Math.PI / 2 });
  parts.add("face", buildCylinder(0.165, 0.165, 0.004, 40), { z: 0.035, rx: Math.PI / 2 });
  parts.add("brass", buildRing(0.172, 0.01, Math.PI * 2, 8, 48), { z: 0.038 });
  // Twenty-four brass rays, long and short in turn.
  for (let ray = 0; ray < 24; ray++) {
    const angle = (ray / 24) * Math.PI * 2;
    const length = ray % 2 === 0 ? 0.13 : 0.075;
    parts.add("brass", buildCylinder(0.0025, 0.009, length, 6), {
      x: Math.cos(angle) * 0.195,
      y: Math.sin(angle) * 0.195,
      z: 0.014,
      rz: angle - Math.PI / 2,
      sz: 0.5,
    });
  }
  // The hour marks: a bar at each quarter, a dot at each other hour.
  for (let hour = 0; hour < 12; hour++) {
    const angle = (hour / 12) * Math.PI * 2;
    const x = Math.sin(angle) * 0.138;
    const y = Math.cos(angle) * 0.138;
    if (hour % 3 === 0) {
      parts.nest({ x, y, z: 0.039, rz: -angle }, () => {
        parts.add("ink", buildSheet(0.01, 0.032, 0.003), { y: -0.016 });
      });
    } else {
      parts.add("ink", buildCylinder(0.0055, 0.0055, 0.003, 8), {
        x,
        y,
        z: 0.039,
        rx: Math.PI / 2,
      });
    }
  }
  parts.add("brass", buildSphere(0.012, 12, 8), { z: 0.046 });
  return parts.merge();
});

/** Builds a clock hand `length` long and `width` wide, pointing up (+y) from the origin. */
const readHandGeometry = memoizeByKey((size: string) => {
  const [length = 0.1, width = 0.01] = size.split("x").map(Number);
  const shape = new Shape();
  shape.moveTo(-width / 2, -0.02);
  shape.lineTo(width / 2, -0.02);
  shape.lineTo(width * 0.35, length * 0.7);
  shape.lineTo(width * 0.9, length * 0.78);
  shape.lineTo(0, length);
  shape.lineTo(-width * 0.9, length * 0.78);
  shape.lineTo(-width * 0.35, length * 0.7);
  shape.lineTo(-width / 2, -0.02);
  return buildExtrusion(shape, 0.002, 0.001, 1);
});

/**
 * Builds the sunburst wall clock, hung on a wall: its back is at z = 0, its
 * centre at y = 0. It is 0.66 across its rays and 0.05 deep. Its hands show
 * the local time when it is built; they do not move.
 */
export function buildWallClock(): Object3D {
  const object = new Group();
  object.name = "wall-clock";
  addMeshes(object, readClockGeometry());
  const now = new Date();
  const minutes = now.getMinutes() + now.getSeconds() / 60;
  const hours = (now.getHours() % 12) + minutes / 60;
  const hands: ReadonlyArray<readonly [string, number, number]> = [
    ["0.095x0.014", (hours / 12) * Math.PI * 2, 0.041],
    ["0.14x0.011", (minutes / 60) * Math.PI * 2, 0.043],
  ];
  // The hands never move, so both are merged into one mesh of this clock's own.
  const handGeometry = mergeGeometries(
    hands.map(([size, angle, z]) =>
      readHandGeometry(size).clone().rotateZ(-angle).translate(0, 0, z),
    ),
  );
  if (handGeometry === null) throw new Error("The props kit could not build a clock's hands.");
  const handMesh = new Mesh(handGeometry, paintSurface(CLOCK_SURFACES.ink));
  handMesh.name = "hands";
  handMesh.receiveShadow = true;
  object.add(handMesh);
  return object;
}

// ---------------------------------------------------------------------------
// The "Now serving" sign.

const SIGN_SURFACES = {
  // Enamel, in satin: a clear coat would lay a white sheen across the lettering.
  enamel: { token: "room-inlay-2", finish: "satin", shadow: true },
  brass: { token: "brass", finish: "brass", shadow: false },
} as const satisfies Record<string, Surface>;

const SIGN_WIDTH = 0.9;
const SIGN_DEPTH = 0.04;
/** The size of the sign's lettered panel, and the canvas it is drawn on. */
const PANEL_WIDTH = 0.74;
const PANEL_HEIGHT = 0.3;
const CANVAS_WIDTH = 1024;
const CANVAS_HEIGHT = Math.round((CANVAS_WIDTH * PANEL_HEIGHT) / PANEL_WIDTH);

const readSignGeometry = memoize(() => {
  const parts = new PartList(SIGN_SURFACES);
  // A stepped Deco silhouette, higher in the middle.
  const outline = new Shape();
  const half = SIGN_WIDTH / 2;
  outline.moveTo(-half, 0);
  outline.lineTo(half, 0);
  outline.lineTo(half, 0.3);
  outline.lineTo(half - 0.1, 0.3);
  outline.lineTo(half - 0.1, 0.35);
  outline.lineTo(0.2, 0.35);
  outline.lineTo(0.2, 0.4);
  outline.lineTo(-0.2, 0.4);
  outline.lineTo(-0.2, 0.35);
  outline.lineTo(-half + 0.1, 0.35);
  outline.lineTo(-half + 0.1, 0.3);
  outline.lineTo(-half, 0.3);
  outline.lineTo(-half, 0);
  // The bevel grows the outline by 0.006 on every side, so it is raised to sit on y = 0.
  parts.add("enamel", buildExtrusion(outline, SIGN_DEPTH - 0.012, 0.006, 1), {
    y: 0.006,
    z: 0.006,
  });
  // A brass rule along the bottom, a short one on the top step, and a brass stud in each upper corner.
  parts.add("brass", buildBlock(SIGN_WIDTH + 0.02, 0.016, SIGN_DEPTH + 0.012, 0.006, 1), {
    z: (SIGN_DEPTH + 0.012) / 2,
  });
  parts.add("brass", buildBlock(0.36, 0.008, 0.008, 0.003, 1), { y: 0.376, z: SIGN_DEPTH + 0.002 });
  for (const side of [-1, 1]) {
    parts.add("brass", buildBlock(0.012, 0.012, 0.008, 0.004, 1), {
      x: side * (half - 0.035),
      y: 0.265,
      z: SIGN_DEPTH + 0.002,
    });
  }
  return parts.merge();
});

/** Draws the sign's lettering for `count` colleagues waiting onto `canvas`, in the theme's colours. */
function drawSign(canvas: HTMLCanvasElement, count: number): void {
  const context = canvas.getContext("2d");
  if (context === null) return;
  const brass = readColor("brass").getStyle();
  const waiting = count > 0;
  const numeral = waiting
    ? readColor("you").getStyle()
    : readColor("room-paper", { dl: -0.25 }).getStyle();
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.textAlign = "center";
  context.textBaseline = "alphabetic";
  context.fillStyle = brass;
  context.font = '640 64px "Bricolage Grotesque", sans-serif';
  context.letterSpacing = "10px";
  context.fillText("NOW SERVING", canvas.width / 2, 96);
  // Two thin rules either side of the numeral, level with its middle.
  context.fillRect(150, 299, 230, 5);
  context.fillRect(canvas.width - 380, 299, 230, 5);
  context.letterSpacing = "0px";
  context.fillStyle = numeral;
  context.font = '210px Limelight, "Bricolage Grotesque", serif';
  context.fillText(String(Math.min(99, Math.max(0, count))), canvas.width / 2, 372);
}

/** The "Now serving" sign over the user's desk. */
export interface NowServingHandle {
  readonly object: Object3D;
  /** Shows how many colleagues wait in the queue. */
  setNumber(count: number): void;
}

/**
 * Builds the "Now serving" sign, hung on a wall: its back is at z = 0, its
 * bottom at y = 0. It is 0.92 wide, 0.4 tall at its stepped middle, and 0.05
 * deep. The count shows in marigold while anyone waits, and in quiet paper
 * when no one does.
 *
 * The words are in the UI face and the numeral in Limelight. The sign draws
 * at once with whatever font is ready and draws again when Limelight has
 * loaded; frames are drawn on demand, so the caller should request a frame
 * after `document.fonts.ready`.
 */
export function buildNowServing(): NowServingHandle {
  const object = new Group();
  object.name = "now-serving";
  addMeshes(object, readSignGeometry());
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  const geometry = new PlaneGeometry(PANEL_WIDTH, PANEL_HEIGHT);
  const material = new MeshStandardMaterial({
    map: texture,
    transparent: true,
    roughness: 0.85,
    metalness: 0,
  });
  const panel = new Mesh(geometry, material);
  panel.position.set(0, 0.165, SIGN_DEPTH + 0.002);
  object.add(panel);
  let count = 0;
  const redraw = () => {
    drawSign(canvas, count);
    texture.needsUpdate = true;
  };
  redraw();
  void document.fonts.load("64px Limelight").then(redraw);
  const unsubscribe = subscribePalette(redraw);
  // The director disposes the geometry of every mesh when it tears the office
  // down. The panel's texture, material and repaint belong to this sign
  // alone, so they go with its geometry.
  geometry.addEventListener("dispose", () => {
    unsubscribe();
    texture.dispose();
    material.dispose();
  });
  return {
    object,
    setNumber(next) {
      count = next;
      redraw();
    },
  };
}
