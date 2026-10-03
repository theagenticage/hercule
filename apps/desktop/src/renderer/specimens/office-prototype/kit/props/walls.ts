/**
 * PROTOTYPE - what hangs on the office's walls: the Case Room's cork board
 * of Proposals, the sunburst clock and the "Now serving" sign over the
 * user's desk. Each one's back is at z = 0, against the wall.
 */
import {
  CanvasTexture,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Shape,
  Vector3,
  type BufferGeometry,
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
  buildMarker,
  buildRing,
  buildSheet,
  buildSphere,
  createRandom,
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

const CARD_PAPER: Surface = { token: "room-paper", finish: "paper", shadow: false };
const CARD_PIN: Surface = { token: "brass", finish: "brass", shadow: false };
const CARD_INK: Surface = { token: "muted", finish: "matte", shadow: false };
const CARD_BURNING: Surface = { token: "fail", finish: "matte", shadow: false };
/** The red thread between cards: the book's oklch(0.55 0.15 25), a darker, quieter red than `fail`. */
const THREAD: Surface = {
  token: "fail",
  finish: "matte",
  shift: { dl: -0.07, dc: -0.04 },
  shadow: false,
};

/** The most cards a board shows; past that, the board is full. */
const BOARD_CAPACITY = 24;
/** The bottom and top of the cork, in the board's space. */
const CORK_BOTTOM = 0.81;
const CORK_TOP = 1.99;

/**
 * Builds a card's geometry in three groups, for an instanced mesh with three
 * materials: the paper, the pin (and, on a burning card, its band), and the
 * handwriting. The card hangs from its pin at the origin, facing +z.
 */
function buildCardGeometry(burning: boolean): BufferGeometry {
  const paper = buildSheet(0.15, 0.112, 0.003).translate(0, -0.1, 0.0015);
  const marks = [buildSphere(0.0085, 8, 6).translate(0, 0, 0.006)];
  if (burning) marks.push(buildSheet(0.15, 0.02, 0.0035).translate(0, -0.042, 0.0018));
  const pin = mergeGeometries(marks.map((part) => part.toNonIndexed()));
  const lines = [0, 1, 2].map((line) =>
    buildSheet(line === 2 ? 0.06 : 0.1, 0.0045, 0.0034).translate(
      -0.015 + (line === 2 ? -0.02 : 0),
      -0.064 - line * 0.015,
      0.0015,
    ),
  );
  const ink = mergeGeometries(lines);
  if (pin === null || ink === null) throw new Error("The props kit could not build a case card.");
  const merged = mergeGeometries([paper.toNonIndexed(), pin, ink.toNonIndexed()], true);
  if (merged === null) throw new Error("The props kit could not build a case card.");
  return merged;
}

const readCardGeometry = memoize(() => buildCardGeometry(false));
const readBurningCardGeometry = memoize(() => buildCardGeometry(true));
const readThreadGeometry = memoize(() => new CylinderGeometry(0.0022, 0.0022, 1, 4, 1, true));

/** Where a card hangs on a board: its pin, and how far it is turned. */
interface CardSlot {
  readonly pin: Vector3;
  readonly turn: number;
}

/** A thread between two cards' pins, by their slot numbers. */
interface ThreadSlot {
  readonly from: number;
  readonly to: number;
}

/**
 * Lays out where a board `width` wide pins its cards, in the order they are
 * pinned, and which cards a thread joins. The layout is the same every time
 * for the same width.
 */
const planBoard = memoizeByKey((width: number) => {
  const random = createRandom(Math.round(width * 100) + 11);
  const columns = Math.max(1, Math.floor((width - 0.22) / 0.19));
  const rows = 5;
  const pitchX = (width - 0.22) / columns;
  const all: CardSlot[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      all.push({
        pin: new Vector3(
          -width / 2 + 0.11 + (column + 0.5) * pitchX + (random() - 0.5) * 0.05,
          CORK_TOP - 0.06 - row * 0.225 + (random() - 0.5) * 0.04,
          0.058,
        ),
        turn: (random() - 0.5) * 0.16,
      });
    }
  }
  for (let index = all.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [all[index], all[other]] = [all[other]!, all[index]!];
  }
  const slots = all.slice(0, BOARD_CAPACITY);
  const threads: ThreadSlot[] = [];
  slots.forEach((slot, index) => {
    if (index === 0 || random() > 0.5) return;
    let nearest = -1;
    let nearestDistance = Infinity;
    for (let other = 0; other < index; other++) {
      const distance = slots[other]!.pin.distanceTo(slot.pin);
      if (distance < nearestDistance && distance > 0.15) {
        nearest = other;
        nearestDistance = distance;
      }
    }
    if (nearest >= 0 && nearestDistance < 0.75) threads.push({ from: nearest, to: index });
  });
  return { slots, threads };
});

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

/** The cork board of Proposals: how many cards it shows, and how many of them burn. */
export interface CaseBoardHandle {
  readonly object: Object3D;
  /** Where Triage stands to pin a card, in the board's own space, facing the board. */
  readonly pinMarker: Object3D;
  setCards(total: number, burning: number): void;
}

/**
 * Builds the Case Room's board, `width` wide, mounted on a wall: its back is
 * at z = 0. The board stands from y = 0.74 to 2.08 (its frame), its cork from
 * 0.81 to 1.99, and it is 0.09 deep. It is `width` + 0.04 wide at its rails.
 *
 * `setCards(total, burning)` pins `total` cards, up to 24, in paper with a
 * brass pin; `burning` of them carry a band and a pin in `fail`. Red thread
 * joins some of the pinned cards. The board starts empty.
 */
export function buildCaseBoard(width: number): CaseBoardHandle {
  const object = new Group();
  object.name = "case-board";
  addMeshes(object, readBoardGeometry(width));
  const { slots, threads } = planBoard(width);
  const cards = new InstancedMesh(
    readCardGeometry(),
    [paintSurface(CARD_PAPER), paintSurface(CARD_PIN), paintSurface(CARD_INK)],
    BOARD_CAPACITY,
  );
  const burningCards = new InstancedMesh(
    readBurningCardGeometry(),
    [paintSurface(CARD_PAPER), paintSurface(CARD_BURNING), paintSurface(CARD_INK)],
    BOARD_CAPACITY,
  );
  const threadMesh = new InstancedMesh(readThreadGeometry(), paintSurface(THREAD), BOARD_CAPACITY);
  for (const mesh of [cards, burningCards, threadMesh]) {
    mesh.count = 0;
    mesh.receiveShadow = true;
    object.add(mesh);
  }
  const matrix = new Matrix4();
  const rotation = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const unit = new Vector3(1, 1, 1);
  const placeCard = (mesh: InstancedMesh, instance: number, slot: CardSlot) => {
    rotation.setFromAxisAngle(new Vector3(0, 0, 1), slot.turn);
    mesh.setMatrixAt(instance, matrix.compose(slot.pin, rotation, unit));
  };
  const pinMarker = buildMarker(0, 0.7, Math.PI);
  object.add(pinMarker);
  return {
    object,
    pinMarker,
    setCards(total, burning) {
      const shown = Math.max(0, Math.min(BOARD_CAPACITY, Math.floor(total)));
      const burn = Math.max(0, Math.min(shown, Math.floor(burning)));
      slots.slice(0, shown).forEach((slot, index) => {
        if (index < burn) placeCard(burningCards, index, slot);
        else placeCard(cards, index - burn, slot);
      });
      burningCards.count = burn;
      cards.count = shown - burn;
      let threadCount = 0;
      for (const thread of threads) {
        if (thread.to >= shown) continue;
        const from = slots[thread.from]!.pin.clone().setZ(0.064);
        const to = slots[thread.to]!.pin.clone().setZ(0.064);
        const direction = to.clone().sub(from);
        const length = direction.length();
        rotation.setFromUnitVectors(up, direction.normalize());
        threadMesh.setMatrixAt(
          threadCount++,
          matrix.compose(from.add(to).multiplyScalar(0.5), rotation, new Vector3(1, length, 1)),
        );
      }
      threadMesh.count = threadCount;
      for (const mesh of [cards, burningCards, threadMesh]) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
      }
    },
  };
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
  const deco = (size: number) => `${size}px Limelight, "Bricolage Grotesque", serif`;
  context.textAlign = "center";
  context.textBaseline = "alphabetic";
  context.fillStyle = brass;
  context.font = deco(64);
  context.letterSpacing = "10px";
  context.fillText("NOW SERVING", canvas.width / 2, 96);
  // Two thin rules either side of the numeral, level with its middle.
  context.fillRect(150, 299, 230, 5);
  context.fillRect(canvas.width - 380, 299, 230, 5);
  context.letterSpacing = "0px";
  context.fillStyle = numeral;
  context.font = deco(210);
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
 * The lettering is in Limelight. The sign draws at once with whatever font is
 * ready and draws again when Limelight has loaded; frames are drawn on demand,
 * so the caller should request a frame after `document.fonts.ready`.
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
  const panel = new Mesh(
    new PlaneGeometry(PANEL_WIDTH, PANEL_HEIGHT),
    new MeshStandardMaterial({ map: texture, transparent: true, roughness: 0.85, metalness: 0 }),
  );
  panel.position.set(0, 0.165, SIGN_DEPTH + 0.002);
  object.add(panel);
  let count = 0;
  const redraw = () => {
    drawSign(canvas, count);
    texture.needsUpdate = true;
  };
  redraw();
  void document.fonts.load("64px Limelight").then(redraw);
  subscribePalette(redraw);
  return {
    object,
    setNumber(next) {
      count = next;
      redraw();
    },
  };
}
