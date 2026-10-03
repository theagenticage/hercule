/**
 * A colleague's face in 3D: the Bureau book's eyes, brows and
 * mouths for each of the eight poses, the blush, the moustache, glasses and
 * monocle, and the pose's badge, raised off the egg like enamel and ink.
 *
 * Every drawing comes from the 2D face (`faces/face-parts.tsx`): the same
 * points, in the same face units, mapped onto the egg. A face is one skinned
 * geometry with each layer's colour painted into its vertices, so the whole
 * face, with the brass of a watch or monocle, is one mesh and one draw call.
 * The eyes follow their own bones, so a blink squeezes them; everything else
 * follows the head, or the torso for a suited colleague's badge and watch.
 */
import {
  BufferGeometry,
  LatheGeometry,
  Matrix4,
  Shape,
  TorusGeometry,
  Vector2,
  Vector3,
} from "three";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
import type { Accessory } from "../../../faces/look";
import type { Pose } from "@hercule/client-core";
import { mapFacePoint, measureEggRadius, placeOnEgg, type Anatomy, type Egg } from "./anatomy";
import {
  BONE,
  PartList,
  buildDome,
  buildPlate,
  buildRoundedRectangle,
  buildMonocleChain,
  buildStroke,
  buildWatchCase,
  buildWatchDial,
  paintLayers,
  readChest,
  traceQuadratic,
  wrapOntoEgg,
} from "./parts";
import { readColor } from "../../engine/palette";

/** The colours of a face, each painted into the vertices of its parts. */
type FaceLayer = "ink" | "paper" | "badge" | "blush" | "brass";

/** The face's layers, in vertex order. */
const FACE_LAYERS: ReadonlyArray<FaceLayer> = ["ink", "paper", "badge", "blush", "brass"];

/** The y of the eyes' centres in the 2D face's units. */
const EYE_Y = 26.6;

/** The x of each eye's centre in the 2D face's units: the left eye (+x) is on the image's right. */
const EYE_X = { left: 29, right: 19 } as const;

/** A point of the 2D face: x across, y down, in the face's units. */
type FacePoint = readonly [number, number];

/**
 * Returns the centre of an eye on the egg's surface, in the head's space:
 * where its bone sits.
 */
export function readEyeCentre(egg: Egg, side: "left" | "right"): Vector3 {
  const flat = mapFacePoint(egg, EYE_X[side], EYE_Y, new Vector3());
  return placeOnEgg(egg, flat.x, flat.y, 0, new Vector3(), new Vector3());
}

/** Returns true when a pose's eyes are open, so they blink. */
export function hasOpenEyes(pose: Pose): boolean {
  return pose === "working" || pose === "waiting" || pose === "idle" || pose === "failed";
}

/**
 * Returns the token a pose's badge is enamelled in, or null for a pose
 * without a badge. The paused and away badges are pale, as the book's
 * outlined badges are.
 */
function readBadgeToken(pose: Pose): "ok" | "fail" | "room-paper" | null {
  switch (pose) {
    case "done":
      return "ok";
    case "failed":
      return "fail";
    case "paused":
    case "away":
      return "room-paper";
    default:
      return null;
  }
}

/** The parts of a face, before they are merged: layers, bones and the egg they sit on. */
interface FaceBuild {
  readonly list: PartList<FaceLayer>;
  readonly egg: Egg;
  readonly eyes: { readonly left: Vector3; readonly right: Vector3 };
}

/** Converts points of the 2D face to the egg's face plane, in metres. */
function mapFacePoints(egg: Egg, points: ReadonlyArray<FacePoint>): Vector3[] {
  return points.map(([x, y]) => mapFacePoint(egg, x, y, new Vector3()));
}

/** Returns the points of a 2D quadratic curve from `start` through the pull of `control` to `end`. */
function traceFaceQuadratic(start: FacePoint, control: FacePoint, end: FacePoint): FacePoint[] {
  return traceQuadratic(
    new Vector3(start[0], start[1], 0),
    new Vector3(control[0], control[1], 0),
    new Vector3(end[0], end[1], 0),
    8,
  ).map((point) => [point.x, point.y] as const);
}

/**
 * Moves a geometry built in the head's space onto an eye bone: the eye's
 * parts follow that bone, whose origin is the eye's centre.
 */
function moveOntoEye(face: FaceBuild, geometry: BufferGeometry, side: "left" | "right"): number {
  const centre = face.eyes[side];
  geometry.translate(-centre.x, -centre.y, -centre.z);
  return side === "left" ? BONE.eyeL : BONE.eyeR;
}

/**
 * Adds an ink line through points of the 2D face, `width` face units wide,
 * standing a little proud of the egg. Lines on an eye follow that eye's bone.
 */
function addLine(
  face: FaceBuild,
  layer: FaceLayer,
  points: ReadonlyArray<FacePoint>,
  width: number,
  options: { readonly eye?: "left" | "right"; readonly lift?: number } = {},
): void {
  const radius = (width / 2) * face.egg.unit;
  const geometry = buildStroke(mapFacePoints(face.egg, points), radius);
  wrapOntoEgg(geometry, face.egg, options.lift ?? radius * 0.2);
  const bone = options.eye === undefined ? BONE.head : moveOntoEye(face, geometry, options.eye);
  face.list.add(layer, geometry, bone);
}

/** Adds a raised ellipse of ink: an open eye, a dot, the waiting pose's round mouth. */
function addDot(
  face: FaceBuild,
  layer: FaceLayer,
  centre: FacePoint,
  rx: number,
  ry: number,
  options: {
    readonly eye?: "left" | "right";
    readonly height?: number;
    readonly lift?: number;
  } = {},
): void {
  const { egg } = face;
  // Small dots need fewer segments to look round; the budget is per rig.
  // A flat dot, like a blushing cheek, needs only a few rows from its rim to its middle.
  const segments = rx >= 1.8 ? 16 : rx >= 1 ? 10 : 8;
  const height = options.height ?? 0.8;
  const geometry = buildDome(
    rx * egg.unitAcross,
    ry * egg.unit,
    height * egg.unit,
    segments,
    height < 0.4 ? 2 : Math.round(segments / 2),
  );
  const flat = mapFacePoint(egg, centre[0], centre[1], new Vector3());
  geometry.translate(flat.x, flat.y, 0);
  wrapOntoEgg(geometry, egg, options.lift ?? 0);
  const bone = options.eye === undefined ? BONE.head : moveOntoEye(face, geometry, options.eye);
  face.list.add(layer, geometry, bone);
}

/** Adds one eye in `pose`, as the book draws it, with its white glint when it is open. */
function addEye(face: FaceBuild, pose: Pose, side: "left" | "right"): void {
  const x = EYE_X[side];
  const eye = { eye: side } as const;
  const addOpenEye = (dy: number, ry: number) => {
    addDot(face, "ink", [x, EYE_Y + dy], 2, ry, { ...eye, height: 1.1 });
    // The glint sits on the eye's dome, up and to the image's right.
    addDot(face, "paper", [x + 0.7, EYE_Y + dy - 0.9], 0.62, 0.62, {
      ...eye,
      height: 0.3,
      lift: 0.82 * face.egg.unit,
    });
  };
  switch (pose) {
    case "working":
      return addOpenEye(1, 2.2);
    case "waiting":
      return addOpenEye(-0.5, 2.75);
    case "idle":
    case "failed":
      return addOpenEye(0, 2.55);
    case "paused":
      return addLine(
        face,
        "ink",
        [
          [x - 2.2, EYE_Y + 0.2],
          [x + 2.2, EYE_Y + 0.2],
        ],
        1.5,
        eye,
      );
    case "asleep":
      return addLine(
        face,
        "ink",
        traceFaceQuadratic([x - 2.3, EYE_Y], [x, EYE_Y + 2], [x + 2.3, EYE_Y]),
        1.5,
        eye,
      );
    case "done":
      return addLine(
        face,
        "ink",
        traceFaceQuadratic([x - 2.3, EYE_Y + 1], [x, EYE_Y - 1.8], [x + 2.3, EYE_Y + 1]),
        1.5,
        eye,
      );
    case "away":
      return addDot(face, "ink", [x - 1, EYE_Y + 0.3], 1.5, 1.5, { ...eye, height: 0.8 });
  }
}

/** Adds the brows of the poses the book draws with brows. */
function addBrows(face: FaceBuild, pose: Pose): void {
  switch (pose) {
    case "waiting":
      addLine(face, "ink", traceFaceQuadratic([16.9, 21.6], [19, 20.2], [21.1, 21.6]), 1.25);
      addLine(face, "ink", traceFaceQuadratic([26.9, 21.6], [29, 20.2], [31.1, 21.6]), 1.25);
      return;
    case "working":
      addLine(
        face,
        "ink",
        [
          [17.2, 22.3],
          [20.8, 22.8],
        ],
        1.25,
      );
      addLine(
        face,
        "ink",
        [
          [30.8, 22.3],
          [27.2, 22.8],
        ],
        1.25,
      );
      return;
    case "failed":
      addLine(
        face,
        "ink",
        [
          [16.8, 22.8],
          [21, 21.3],
        ],
        1.25,
      );
      addLine(
        face,
        "ink",
        [
          [31.2, 22.8],
          [27, 21.3],
        ],
        1.25,
      );
      return;
    default:
      return;
  }
}

/**
 * Adds the mouth of `pose`. Under a moustache the mouth sits lower, and only
 * the waiting, done and failed mouths still show, as in the book.
 */
function addMouth(face: FaceBuild, pose: Pose, wearsTache: boolean): void {
  const y = wearsTache ? 34.4 : 32.6;
  switch (pose) {
    case "waiting":
      return addDot(face, "ink", [24, y + 0.2], 1.5, 1.7, { height: 0.5 });
    case "done":
      return addLine(
        face,
        "ink",
        traceFaceQuadratic([21, y - 1.2], [24, y + 2], [27, y - 1.2]),
        1.45,
      );
    case "failed":
      return addLine(
        face,
        "ink",
        [
          ...traceFaceQuadratic([21.4, y + 0.6], [22.7, y - 0.7], [24, y + 0.6]),
          ...traceFaceQuadratic([24, y + 0.6], [25.3, y + 1.9], [26.6, y + 0.6]).slice(1),
        ],
        1.45,
      );
  }
  if (wearsTache) return;
  switch (pose) {
    case "working":
    case "paused":
      return addLine(
        face,
        "ink",
        [
          [22.6, y],
          [25.4, y],
        ],
        1.45,
      );
    case "asleep":
      return addLine(face, "ink", traceFaceQuadratic([23, y], [24, y + 0.8], [25, y]), 1.45);
    case "away":
      for (const x of [22.2, 24.1, 26]) addDot(face, "ink", [x, y], 0.72, 0.72, { height: 0.5 });
      return;
    case "idle":
      return addLine(
        face,
        "ink",
        traceFaceQuadratic([21.6, y - 1.2], [24, y + 1.1], [26.4, y - 1.2]),
        1.45,
      );
  }
}

/** The book's moustache: two full wings that thin out and curl up at the ends. */
const TACHE_PATH =
  "M24 30.9c-1.5-1.3-4.2-1.5-5.8-.1-.9.8-2 .8-2.6-.3 0 1.9 1.6 3 3.5 2.6 1.9-.4 3.4-1 4.9-1.3 " +
  "1.5.3 3 .9 4.9 1.3 1.9.4 3.5-.7 3.5-2.6-.6 1.1-1.7 1.1-2.6.3-1.6-1.4-4.3-1.2-5.8.1z";

let tacheOutlines: ReadonlyArray<ReadonlyArray<Vector2>> | null = null;

/**
 * Returns the moustache's outlines in the 2D face's units, traced from
 * `TACHE_PATH` the first time a moustache is built.
 */
function readTacheOutlines(): ReadonlyArray<ReadonlyArray<Vector2>> {
  if (tacheOutlines === null) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><path d="${TACHE_PATH}"/></svg>`;
    tacheOutlines = new SVGLoader()
      .parse(svg)
      .paths.flatMap((path) => path.toShapes())
      .map((shape) => shape.getPoints(6));
  }
  return tacheOutlines;
}

/** Adds the moustache: the book's outline as a thin slab, with its two curls. */
function addTache(face: FaceBuild): void {
  const { egg } = face;
  for (const points of readTacheOutlines()) {
    const outline = points.map(
      (point) => new Vector2((point.x - 24) * egg.unitAcross, (42.4 - point.y) * egg.unit),
    );
    const slab = buildPlate(new Shape(outline), 0.9 * egg.unit, 6);
    wrapOntoEgg(slab, egg, 0.55 * egg.unit);
    face.list.add("ink", slab, BONE.head);
  }
  addLine(face, "ink", traceCubic([15.8, 30.9], [14.9, 30.6], [14.5, 29.7], [14.9, 28.9]), 0.9);
  addLine(face, "ink", traceCubic([32.2, 30.9], [33.1, 30.6], [33.5, 29.7], [33.1, 28.9]), 0.9);
}

/** Returns the points of a 2D cubic curve. */
function traceCubic(p0: FacePoint, p1: FacePoint, p2: FacePoint, p3: FacePoint): FacePoint[] {
  const points: FacePoint[] = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    points.push([
      a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
      a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
    ]);
  }
  return points;
}

/** Adds a ring of ink around an eye, standing off the face: a glasses rim or a monocle. */
function addRim(face: FaceBuild, x: number, radius: number, width: number): void {
  const { egg } = face;
  const rim = new TorusGeometry(radius * egg.unitAcross, (width / 2) * egg.unit, 5, 22);
  rim.deleteAttribute("uv");
  const flat = mapFacePoint(egg, x, EYE_Y, new Vector3());
  rim.translate(flat.x, flat.y, 0);
  face.list.add("ink", wrapOntoEgg(rim, egg, 1.5 * egg.unit), BONE.head);
}

/** Adds round glasses: two rims, a bridge, and arms that run back over the sides of the head. */
function addGlasses(face: FaceBuild): void {
  const { egg } = face;
  addRim(face, EYE_X.right, 4, 1.15);
  addRim(face, EYE_X.left, 4, 1.15);
  addLine(
    face,
    "ink",
    [
      [23, 26.4],
      [25, 26.4],
    ],
    1.0,
    { lift: 1.5 * egg.unit },
  );
  // The arms: from each rim's outer edge back along the head, just off its surface.
  const height = (42.4 - EYE_Y) * egg.unit;
  for (const side of [-1, 1]) {
    const points: Vector3[] = [];
    for (let i = 0; i <= 6; i++) {
      const angle = side * (0.75 + (i / 6) * 0.95);
      points.push(placeAroundEgg(egg, angle, height + i * 0.0015, 1.2 * egg.unit));
    }
    face.list.add("ink", buildStroke(points, 0.5 * egg.unit), BONE.head);
  }
}

/** Returns the point at `angle` around the egg (0 is the front, +x is positive) and `height` up it, `lift` off its surface. */
function placeAroundEgg(egg: Egg, angle: number, height: number, lift: number): Vector3 {
  const radius = measureEggRadius(egg, height);
  const normal = new Vector3(Math.sin(angle), 0, Math.cos(angle) / egg.depth).normalize();
  return new Vector3(
    Math.sin(angle) * radius,
    height,
    Math.cos(angle) * radius * egg.depth,
  ).addScaledVector(normal, lift);
}

/** Adds a monocle's rim around the left eye; its brass chain is part of the body. */
function addMonocle(face: FaceBuild): void {
  addRim(face, EYE_X.left, 4.2, 1.2);
}

/** Adds the plaster the failed pose wears on its right cheek, with its pad. */
function addPlaster(face: FaceBuild): void {
  const { egg } = face;
  const centre = mapFacePoint(egg, 14.6, 32.4, new Vector3());
  // In the book the plaster tilts 30 degrees, its inner end higher.
  const turn = new Matrix4().makeRotationZ(Math.PI / 6);
  const strip = buildPlate(
    buildRoundedRectangle(10 * egg.unitAcross, 4.6 * egg.unit, 2.3 * egg.unit),
    0.3 * egg.unit,
    4,
  );
  const pad = buildPlate(
    buildRoundedRectangle(3 * egg.unitAcross, 3.4 * egg.unit, 0.7 * egg.unit),
    0.3 * egg.unit,
    3,
  );
  pad.translate(0, 0, 0.3 * egg.unit);
  for (const part of [strip, pad]) {
    part.applyMatrix4(turn);
    part.translate(centre.x, centre.y, 0);
    face.list.add("paper", wrapOntoEgg(part, egg, 0.3 * egg.unit), BONE.head);
  }
}

/** Where a badge is pinned: the egg, the bone, its centre in the egg's face plane, and its radius. */
interface BadgePlace {
  readonly egg: Egg;
  readonly bone: number;
  readonly centre: Vector3;
  readonly radius: number;
}

/**
 * Returns where a pose's badge is pinned. A bean wears it low on its left
 * (+x), where the book draws it, or on its right when a pocket watch hangs
 * there. A suited colleague wears it on the left of the chest.
 */
function readBadgePlace(anatomy: Anatomy, wearsWatch: boolean): BadgePlace {
  if (anatomy.jacket === null) {
    const { egg } = anatomy;
    return {
      egg,
      bone: BONE.head,
      centre: mapFacePoint(egg, wearsWatch ? 13.6 : 34.4, 37.2, new Vector3()),
      radius: 3 * egg.unit,
    };
  }
  const jacket = anatomy.jacket;
  return {
    egg: jacket,
    bone: BONE.torso,
    centre: new Vector3(0.066, jacket.height * 0.66, 0),
    radius: 0.032,
  };
}

/**
 * Adds a pose's badge: an enamel pin with a flat top, and the book's symbol
 * on it, a check, an X, two bars or a crossed-out arc.
 */
function addBadge(face: FaceBuild, anatomy: Anatomy, pose: Pose, wearsWatch: boolean): void {
  if (readBadgeToken(pose) === null) return;
  const { egg, bone, centre, radius } = readBadgePlace(anatomy, wearsWatch);
  const height = radius * 0.32;
  const pin = new LatheGeometry(
    [
      new Vector2(0.0001, 0),
      new Vector2(radius * 0.96, 0),
      new Vector2(radius, height * 0.45),
      new Vector2(radius * 0.93, height * 0.88),
      new Vector2(radius * 0.78, height),
      new Vector2(0.0001, height),
    ],
    20,
  );
  pin.deleteAttribute("uv");
  pin.rotateX(Math.PI / 2);
  pin.translate(centre.x, centre.y, 0);
  face.list.add("badge", wrapOntoEgg(pin, egg, 0), bone);
  // The symbol, in the book's badge units: the badge there has a radius of 5.6.
  const scale = radius / 5.6;
  const addSymbol = (layer: FaceLayer, points: ReadonlyArray<FacePoint>, width: number) => {
    const line = buildStroke(
      points.map(([x, y]) => new Vector3(centre.x + x * scale, centre.y - y * scale, 0)),
      (width / 2) * scale,
    );
    face.list.add(layer, wrapOntoEgg(line, egg, height), bone);
  };
  switch (pose) {
    case "done":
      addSymbol(
        "paper",
        [
          [-2.4, 0.2],
          [-0.8, 1.8],
          [2.4, -1.6],
        ],
        1.7,
      );
      return;
    case "failed":
      addSymbol(
        "paper",
        [
          [-1.7, -1.7],
          [1.7, 1.7],
        ],
        1.7,
      );
      addSymbol(
        "paper",
        [
          [1.7, -1.7],
          [-1.7, 1.7],
        ],
        1.7,
      );
      return;
    case "paused":
      addSymbol(
        "ink",
        [
          [-1.2, -1.8],
          [-1.2, 1.8],
        ],
        1.5,
      );
      addSymbol(
        "ink",
        [
          [1.2, -1.8],
          [1.2, 1.8],
        ],
        1.5,
      );
      return;
    case "away":
      addSymbol(
        "ink",
        [
          [-2.4, 1.8],
          [2.4, -3],
        ],
        1.3,
      );
      addSymbol("ink", traceFaceQuadratic([-2.2, -1.8], [0.2, -4.2], [2.6, -1.8]), 1.3);
      return;
    default:
      return;
  }
}

/** Adds the two blushing cheeks. */
function addBlush(face: FaceBuild): void {
  for (const x of [15, 33]) {
    addDot(face, "blush", [x, 31.4], 2.6, 1.6, { height: 0.18, lift: 0.05 * face.egg.unit });
  }
}

const faces = new Map<string, BufferGeometry>();

/**
 * Returns the face of a colleague in `pose` as one skinned geometry painted
 * in vertex colours, for a gloss finish. It is built once per look and pose
 * and then shared, whatever the colleague's hue.
 */
export function readFaceGeometry(
  anatomy: Anatomy,
  pose: Pose,
  accessories: ReadonlyArray<Accessory>,
): BufferGeometry {
  const wears = (accessory: Accessory) => accessories.includes(accessory);
  const key = [
    anatomy.style,
    anatomy.shape,
    pose,
    ...(["tache", "glasses", "monocle", "watch"] as const).filter(wears),
  ].join("|");
  const known = faces.get(key);
  if (known !== undefined) return known;
  const { egg } = anatomy;
  const face: FaceBuild = {
    list: new PartList<FaceLayer>(),
    egg,
    eyes: { left: readEyeCentre(egg, "left"), right: readEyeCentre(egg, "right") },
  };
  addEye(face, pose, "left");
  addEye(face, pose, "right");
  addBrows(face, pose);
  addMouth(face, pose, wears("tache"));
  addBlush(face);
  if (wears("tache")) addTache(face);
  if (wears("glasses")) addGlasses(face);
  if (wears("monocle")) addMonocle(face);
  if (wears("monocle")) face.list.add("brass", buildMonocleChain(egg), BONE.head);
  if (wears("watch")) {
    const { bone } = readChest(anatomy);
    face.list.add("paper", buildWatchDial(anatomy), bone);
    for (const part of buildWatchCase(anatomy)) face.list.add("brass", part, bone);
  }
  if (pose === "failed") addPlaster(face);
  addBadge(face, anatomy, pose, wears("watch"));
  const badge = readBadgeToken(pose) ?? "room-paper";
  const geometry = paintLayers(face.list.mergeLayers(FACE_LAYERS), (layer) => {
    switch (layer) {
      case "ink":
        return readColor("face-ink");
      case "paper":
        return readColor("room-paper");
      case "badge":
        return readColor(badge);
      case "blush":
        return readColor("blush");
      case "brass":
        return readColor("brass");
    }
  });
  faces.set(key, geometry);
  return geometry;
}
