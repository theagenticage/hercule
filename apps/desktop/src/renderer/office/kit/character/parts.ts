/**
 * The shapes a colleague is built from: its body, limbs, shoes,
 * hats, accessories and the things it holds.
 *
 * A colleague's moving parts share one skeleton. Its whole body, in every
 * colour, is merged into one skinned geometry in which each part follows
 * exactly one bone, and each part's colour is painted into its vertices, so
 * the body is one draw call. Only a hat gets a second mesh, for its satin
 * finish. Each part is built in its bone's own space, and the skeleton's
 * inverse bind matrices are identities.
 *
 * Geometry is built once per look and shared by every rig with that look;
 * a rig owns only its bones.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  CapsuleGeometry,
  CatmullRomCurve3,
  CylinderGeometry,
  ExtrudeGeometry,
  LatheGeometry,
  Matrix4,
  Quaternion,
  RingGeometry,
  Shape,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  Euler,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Accessory, Hue } from "../../../faces/look";
import { registerCache } from "../../engine/caches";
import { readColor, readHue, subscribePalette, writeOklch } from "../../engine/palette";
import type { Headwear } from "../../world/types";
import { mapFacePoint, measureEggRadius, placeOnEgg, type Anatomy, type Egg } from "./anatomy";

/** The index of each bone in a rig's skeleton. Left is the colleague's own left, +x. */
export const BONE = {
  pelvis: 0,
  torso: 1,
  head: 2,
  shoulderL: 3,
  elbowL: 4,
  handL: 5,
  shoulderR: 6,
  elbowR: 7,
  handR: 8,
  hipL: 9,
  kneeL: 10,
  footL: 11,
  hipR: 12,
  kneeR: 13,
  footR: 14,
  eyeL: 15,
  eyeR: 16,
} as const;

/** The parent of each bone, by index; -1 is the rig's root. */
export const BONE_PARENTS: ReadonlyArray<number> = [
  -1, 0, 1, 1, 3, 4, 1, 6, 7, -1, 9, 10, -1, 12, 13, 2, 2,
];

/**
 * The colours a colleague's body is painted in:
 * - `body`, `shade` and `tint`: the tones of the colleague's hue;
 * - `trim`: shoes, buttons and the bowtie, in the hat colour;
 * - `hat`: the hat, also in the hat colour, but in a mesh of its own, so it
 *   can have a satin finish instead of the body's vinyl;
 * - `shadow`: the shade a hat casts on the head just below its edge, in the
 *   hue's dark ink tone at the edge, fading into the body colour below.
 */
export type Surface = "body" | "shade" | "tint" | "trim" | "hat" | "shadow";

/** The surfaces merged into a colleague's body mesh, in vertex order. */
const BODY_SURFACES: ReadonlyArray<Surface> = ["body", "shade", "tint", "trim", "shadow"];

/**
 * A list of rigid parts, sorted into layers, merged into skinned geometry:
 * one geometry per layer, or one geometry with a group per layer.
 */
export class PartList<Layer extends string> {
  private readonly parts = new Map<Layer, BufferGeometry[]>();

  /**
   * Adds `geometry` to `layer`, following `bone`, after applying `matrix`
   * if one is given. The geometry is copied, so the caller may dispose it.
   * A geometry may carry a `coverage` attribute (see `paintLayers`); without
   * one, every vertex is fully covered.
   */
  add(layer: Layer, geometry: BufferGeometry, bone: number, matrix?: Matrix4): void {
    const flat = geometry.index === null ? geometry.clone() : geometry.toNonIndexed();
    if (matrix !== undefined) flat.applyMatrix4(matrix);
    const part = new BufferGeometry();
    part.setAttribute("position", flat.getAttribute("position"));
    part.setAttribute("normal", flat.getAttribute("normal"));
    const count = part.getAttribute("position").count;
    part.setAttribute(
      "coverage",
      flat.getAttribute("coverage") ?? new BufferAttribute(new Float32Array(count).fill(1), 1),
    );
    const skinIndex = new Uint16Array(count * 4);
    const skinWeight = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      skinIndex[i * 4] = bone;
      skinWeight[i * 4] = 1;
    }
    part.setAttribute("skinIndex", new BufferAttribute(skinIndex, 4));
    part.setAttribute("skinWeight", new BufferAttribute(skinWeight, 4));
    let list = this.parts.get(layer);
    if (list === undefined) {
      list = [];
      this.parts.set(layer, list);
    }
    list.push(part);
  }

  /** Checks whether any part has been added to `layer`. */
  has(layer: Layer): boolean {
    return this.parts.has(layer);
  }

  /**
   * Merges the parts of `layers` into one geometry, in the order of `layers`,
   * for a mesh that carries its colours in its vertices (see `paintLayers`).
   * Returns the geometry and the vertices each layer owns. Fails when none of
   * `layers` has a part.
   */
  mergeLayers(layers: ReadonlyArray<Layer>): LayeredGeometry<Layer> {
    const all: BufferGeometry[] = [];
    const ranges: Array<LayerRange<Layer>> = [];
    let start = 0;
    for (const layer of layers) {
      const list = this.parts.get(layer) ?? [];
      const count = list.reduce((sum, part) => sum + part.getAttribute("position").count, 0);
      all.push(...list);
      if (count > 0) ranges.push({ layer, start, count });
      start += count;
    }
    return { geometry: mergeParts(all), ranges };
  }
}

/** The vertices of a merged geometry that one layer owns. */
interface LayerRange<Layer extends string> {
  readonly layer: Layer;
  readonly start: number;
  readonly count: number;
}

/** A merged geometry and the vertices each of its layers owns, before it is painted. */
interface LayeredGeometry<Layer extends string> {
  readonly geometry: BufferGeometry;
  readonly ranges: ReadonlyArray<LayerRange<Layer>>;
}

/**
 * Returns a geometry that shares `layered`'s positions, normals and skin
 * weights, and paints each layer's vertices in the colour `readLayerColor`
 * returns for it. The colours are repainted after every theme change.
 *
 * A vertex's `coverage` is how much of its layer's colour it gets: at 1 it
 * is painted in that colour, below 1 it is painted that fraction of the way
 * from the colour of `layerBeneath` to it. This is how a colour fades out
 * over the surface it lies on.
 *
 * A mesh drawn in vertex colours with one shared material costs one draw
 * call, where a material per colour would cost one per colour, and every
 * draw is repeated for the shadows and the ambient occlusion.
 */
export function paintLayers<Layer extends string>(
  layered: LayeredGeometry<Layer>,
  readLayerColor: (layer: Layer) => Color,
  layerBeneath?: Layer,
): BufferGeometry {
  const source = layered.geometry;
  const geometry = new BufferGeometry();
  for (const name of ["position", "normal", "skinIndex", "skinWeight"]) {
    geometry.setAttribute(name, source.getAttribute(name));
  }
  geometry.boundingSphere = source.boundingSphere;
  const colors = new Float32BufferAttribute(
    new Float32Array(source.getAttribute("position").count * 3),
    3,
  );
  geometry.setAttribute("color", colors);
  const coverage = source.getAttribute("coverage");
  const mixed = new Color();
  const repaint = (): void => {
    const beneath = layerBeneath === undefined ? null : readLayerColor(layerBeneath);
    for (const { layer, start, count } of layered.ranges) {
      const color = readLayerColor(layer);
      for (let vertex = start; vertex < start + count; vertex++) {
        const covered = coverage.getX(vertex);
        if (beneath === null || covered >= 1) colors.setXYZ(vertex, color.r, color.g, color.b);
        else {
          mixed.copy(beneath).lerp(color, covered);
          colors.setXYZ(vertex, mixed.r, mixed.g, mixed.b);
        }
      }
    }
    colors.needsUpdate = true;
  };
  repaint();
  subscribePalette(repaint);
  return geometry;
}

/** Merges skinned parts into one geometry and disposes the parts. */
function mergeParts(parts: ReadonlyArray<BufferGeometry>): BufferGeometry {
  const geometry = mergeGeometries([...parts], false);
  if (geometry === null) throw new Error("A colleague's parts could not be merged.");
  geometry.computeBoundingSphere();
  for (const part of parts) part.dispose();
  return geometry;
}

/** Returns a transform: a translation, an XYZ rotation and a scale. */
function composeMatrix(
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = sx,
  sz = sx,
): Matrix4 {
  return new Matrix4().compose(
    new Vector3(x, y, z),
    new Quaternion().setFromEuler(new Euler(rx, ry, rz)),
    new Vector3(sx, sy, sz),
  );
}

const UP = new Vector3(0, 1, 0);
const wrapPoint = new Vector3();
const wrapNormal = new Vector3();
const tangentX = new Vector3();
const tangentY = new Vector3();

const corners = [new Vector3(), new Vector3(), new Vector3()];
const cornerNormals = [new Vector3(), new Vector3(), new Vector3()];

/**
 * Splits every triangle of a non-indexed geometry whose longest edge is over
 * `maxEdge` in two across that edge, until none is. A flat part wrapped onto
 * the egg then bends with the surface; a long triangle would cut through it.
 * Keeps only the position and normal attributes. Indexed geometry is left
 * alone: its triangles are small already.
 */
function splitLongTriangles(geometry: BufferGeometry, maxEdge: number): void {
  if (geometry.index !== null) return;
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const positions: number[] = [];
  const normals: number[] = [];
  let split = false;
  const visit = (p: Vector3[], n: Vector3[], depth: number): void => {
    const lengths = [p[0]!.distanceTo(p[1]!), p[1]!.distanceTo(p[2]!), p[2]!.distanceTo(p[0]!)];
    const longest = lengths.indexOf(Math.max(...lengths));
    if (lengths[longest]! <= maxEdge || depth >= 6) {
      for (let k = 0; k < 3; k++) {
        positions.push(p[k]!.x, p[k]!.y, p[k]!.z);
        normals.push(n[k]!.x, n[k]!.y, n[k]!.z);
      }
      return;
    }
    split = true;
    // Corners a and b end the longest edge; c is opposite it. Each half keeps the winding.
    const a = longest;
    const b = (longest + 1) % 3;
    const c = (longest + 2) % 3;
    const middle = p[a]!.clone().lerp(p[b]!, 0.5);
    const middleNormal = n[a]!.clone().add(n[b]!).normalize();
    const first = [p[a]!, middle, p[c]!];
    const second = [middle, p[b]!, p[c]!];
    visit(first, [n[a]!, middleNormal, n[c]!], depth + 1);
    visit(second, [middleNormal, n[b]!, n[c]!], depth + 1);
  };
  for (let i = 0; i < position.count; i += 3) {
    for (let k = 0; k < 3; k++) {
      corners[k]!.fromBufferAttribute(position, i + k);
      cornerNormals[k]!.fromBufferAttribute(normal, i + k);
    }
    visit(
      corners.map((corner) => corner.clone()),
      cornerNormals.map((corner) => corner.clone()),
      0,
    );
  }
  if (!split) return;
  for (const name of Object.keys(geometry.attributes)) geometry.deleteAttribute(name);
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("normal", new BufferAttribute(new Float32Array(normals), 3));
  geometry.clearGroups();
}

/**
 * Bends a flat geometry onto the front of `egg`. The geometry is built in
 * the egg's face plane: x across, y up from the egg's bottom and z out of the
 * face. Each vertex moves onto the surface, `lift` plus its own z out along
 * the normal, and its normal turns with the surface. Long triangles are
 * split first, so the part follows the curve. Returns the geometry.
 */
export function wrapOntoEgg(geometry: BufferGeometry, egg: Egg, lift: number): BufferGeometry {
  splitLongTriangles(geometry, 1.4 * egg.unit);
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  for (let i = 0; i < position.count; i++) {
    placeOnEgg(
      egg,
      position.getX(i),
      position.getY(i),
      lift + position.getZ(i),
      wrapPoint,
      wrapNormal,
    );
    position.setXYZ(i, wrapPoint.x, wrapPoint.y, wrapPoint.z);
    tangentX.crossVectors(UP, wrapNormal).normalize();
    tangentY.crossVectors(wrapNormal, tangentX);
    const nx = normal.getX(i);
    const ny = normal.getY(i);
    const nz = normal.getZ(i);
    normal.setXYZ(
      i,
      tangentX.x * nx + tangentY.x * ny + wrapNormal.x * nz,
      tangentX.y * nx + tangentY.y * ny + wrapNormal.y * nz,
      tangentX.z * nx + tangentY.z * ny + wrapNormal.z * nz,
    );
  }
  position.needsUpdate = true;
  normal.needsUpdate = true;
  return geometry;
}

/** Builds a lathed egg, its seam at the back, `segments` around. */
function buildEggGeometry(egg: Egg, segments: number): BufferGeometry {
  const points = egg.outline.map(([radius, height]) => new Vector2(radius, height));
  const geometry = new LatheGeometry(points, segments, Math.PI);
  geometry.scale(1, 1, egg.depth);
  return geometry;
}

/** How many segments a shell has around the egg. */
const SHELL_SEGMENTS = 24;

/**
 * Builds a shell that hugs the egg from a lower edge up to the top, `offset`
 * metres off its surface: a hat's crown or a band. `readEdgeHeight` returns the
 * height of the lower edge at an angle around the egg (0 is the front), and
 * `top` is the fraction of the way from the edge to the egg's top where the
 * shell ends. With `flare`, the lower edge turns out into a small brim.
 */
function buildShell(
  egg: Egg,
  readEdgeHeight: (angle: number) => number,
  offset: number,
  options: { readonly from?: number; readonly top?: number; readonly flare?: number },
): BufferGeometry {
  const segments = SHELL_SEGMENTS;
  const from = options.from ?? 0;
  const top = options.top ?? 1;
  const flare = options.flare ?? 0;
  const rows = [from, from + (top - from) * 0.25, from + (top - from) * 0.5];
  rows.push(from + (top - from) * 0.72, from + (top - from) * 0.88, top);
  const rings: number[] = flare > 0 ? [-1, ...rows] : rows;
  const positions: number[] = [];
  const normals: number[] = [];
  const point = new Vector3();
  const normal = new Vector3();
  for (const row of rings) {
    for (let s = 0; s <= segments; s++) {
      const angle = Math.PI + (s / segments) * Math.PI * 2;
      const low = readEdgeHeight(angle);
      const fraction = row < 0 ? 0 : row;
      const height = Math.min(low + (egg.height - low) * fraction, egg.height - 1e-4);
      let radius = measureEggRadius(egg, height);
      const slope =
        (measureEggRadius(egg, height + 0.004) - measureEggRadius(egg, height - 0.004)) / 0.008;
      normal.set(Math.sin(angle), -slope, Math.cos(angle) / egg.depth).normalize();
      radius = Math.max(radius, 1e-4);
      point.set(Math.sin(angle) * radius, height, egg.depth * Math.cos(angle) * radius);
      point.addScaledVector(normal, offset);
      if (row < 0) {
        // The brim: out and a little down from the edge.
        point.x += Math.sin(angle) * flare;
        point.z += Math.cos(angle) * flare * egg.depth;
        point.y -= flare * 0.45;
        normal.set(Math.sin(angle) * 0.4, -1, Math.cos(angle) * 0.4).normalize();
      }
      if (fraction >= top && top >= 1) normal.set(0, 1, 0);
      positions.push(point.x, point.y, point.z);
      normals.push(normal.x, normal.y, normal.z);
    }
  }
  const index: number[] = [];
  for (let r = 0; r < rings.length - 1; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s;
      const b = a + segments + 1;
      index.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("normal", new BufferAttribute(new Float32Array(normals), 3));
  geometry.setIndex(index);
  return geometry;
}

/** Builds a limb segment: a capsule hanging down its bone's -y from the joint, `length` long. */
function buildLimb(radius: number, length: number): BufferGeometry {
  const geometry = new CapsuleGeometry(radius, length, 3, 9);
  geometry.translate(0, -length / 2, 0);
  return geometry;
}

/**
 * Builds a mitten: a soft ball with a thumb, hanging below the wrist. The
 * thumb points along the hand's -z, the side the elbow bends toward, and
 * the palm faces the left hand's +x (the right hand's -x).
 */
function buildMitten(radius: number): BufferGeometry {
  const palm = new SphereGeometry(radius, 11, 8);
  palm.scale(0.8, 1, 0.92);
  palm.translate(0, -radius * 0.72, 0);
  const thumb = new SphereGeometry(radius * 0.42, 7, 5);
  thumb.translate(0, -radius * 0.45, -radius * 0.7);
  const merged = mergeGeometries([palm.toNonIndexed(), thumb.toNonIndexed()], false);
  palm.dispose();
  thumb.dispose();
  if (merged === null) throw new Error("The mitten could not be merged.");
  return merged;
}

/** Builds a shoe whose ankle is at the origin: a rounded toe-cap, flat underneath. */
function buildShoe(anatomy: Anatomy): BufferGeometry {
  const suited = anatomy.style === "suited";
  const radius = suited ? 0.04 : 0.042;
  const length = suited ? 0.085 : 0.05;
  const geometry = new CapsuleGeometry(radius, length, 3, 10);
  geometry.rotateX(Math.PI / 2);
  geometry.scale(1, suited ? 0.78 : 0.88, 1);
  geometry.translate(0, -anatomy.ankle + radius * 0.6, suited ? 0.03 : 0.022);
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  for (let i = 0; i < position.count; i++) {
    if (position.getY(i) < -anatomy.ankle) {
      position.setY(i, -anatomy.ankle);
      normal.setXYZ(i, 0, -1, 0);
    }
  }
  return geometry;
}

/** Builds a tube along `points`, rounded at both ends. */
export function buildStroke(points: ReadonlyArray<Vector3>, radius: number): BufferGeometry {
  const curve = new CatmullRomCurve3([...points]);
  const length = curve.getLength();
  const sections = Math.min(12, Math.max(2, Math.round(length / (radius * 2.4))));
  const tube = new TubeGeometry(curve, sections, radius, 6);
  const caps = [points[0]!, points[points.length - 1]!].map((end) => {
    const cap = new SphereGeometry(radius, 6, 4);
    cap.translate(end.x, end.y, end.z);
    return cap.toNonIndexed();
  });
  const merged = mergeGeometries([tube.toNonIndexed(), ...caps], false);
  tube.dispose();
  if (merged === null) throw new Error("A stroke could not be merged.");
  merged.deleteAttribute("uv");
  return merged;
}

/** Returns the points of a quadratic curve from `start` through the pull of `control` to `end`. */
export function traceQuadratic(
  start: Vector3,
  control: Vector3,
  end: Vector3,
  steps = 8,
): Vector3[] {
  const points: Vector3[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    points.push(
      new Vector3()
        .addScaledVector(start, u * u)
        .addScaledVector(control, 2 * u * t)
        .addScaledVector(end, t * t),
    );
  }
  return points;
}

/**
 * Builds half an ellipsoid bulging out along +z: an eye, a button, a dot.
 * It is `segments` around and `rows` from its rim to its tip.
 */
export function buildDome(
  rx: number,
  ry: number,
  rz: number,
  segments = 12,
  rows = Math.max(3, Math.round(segments / 2)),
): BufferGeometry {
  const geometry = new SphereGeometry(1, segments, rows, 0, Math.PI * 2, 0, Math.PI / 2);
  geometry.rotateX(Math.PI / 2);
  geometry.scale(rx, ry, rz);
  geometry.deleteAttribute("uv");
  return geometry;
}

/** Builds a flat shape `depth` thick, from the front at z = 0 back into -z, with every normal facing +z. */
export function buildPlate(shape: Shape, depth: number, curveSegments = 6): BufferGeometry {
  const geometry = new ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments });
  geometry.translate(0, 0, -depth);
  geometry.deleteAttribute("uv");
  const normal = geometry.getAttribute("normal");
  for (let i = 0; i < normal.count; i++) normal.setXYZ(i, 0, 0, 1);
  return geometry;
}

/** Builds a rounded rectangle shape centred on the origin. */
export function buildRoundedRectangle(width: number, height: number, radius: number): Shape {
  const shape = new Shape();
  const w = width / 2;
  const h = height / 2;
  const r = Math.min(radius, w, h);
  shape.moveTo(-w + r, -h);
  shape.lineTo(w - r, -h);
  shape.quadraticCurveTo(w, -h, w, -h + r);
  shape.lineTo(w, h - r);
  shape.quadraticCurveTo(w, h, w - r, h);
  shape.lineTo(-w + r, h);
  shape.quadraticCurveTo(-w, h, -w, h - r);
  shape.lineTo(-w, -h + r);
  shape.quadraticCurveTo(-w, -h, -w + r, -h);
  return shape;
}

// ---------------------------------------------------------------------------
// Hats. Each sits on the egg on the head bone, relative to the egg's top, as
// the book draws its hats relative to the top of the body. A hat must read as
// an object worn on the head, not as paint on it: its brim has a thickness
// the light can catch, and the head is shaded just below its edge.

/**
 * Adds the shade a hat casts on the head: a band in the `shadow` surface,
 * darkest just under the hat and fading into the body colour 2.8 units
 * below it, so it reads as shade rather than as a painted stripe.
 * `readEdgeHeight` returns the height of the hat's lowest point at an angle
 * around the egg (0 is the front).
 */
function addHatShadow(
  list: PartList<Surface>,
  egg: Egg,
  readEdgeHeight: (angle: number) => number,
): void {
  const width = 2.8 * egg.unit;
  const readShadeBottom = (angle: number) => readEdgeHeight(angle) - width;
  // The band reaches a little up under the hat, so no head shows between the two.
  const top = (width * 1.3) / (egg.height - readShadeBottom(0));
  const shell = buildShell(egg, readShadeBottom, 0.003, { top });
  const position = shell.getAttribute("position");
  const coverage = new Float32Array(position.count);
  for (let vertex = 0; vertex < position.count; vertex++) {
    const angle = Math.atan2(position.getX(vertex), position.getZ(vertex) / egg.depth);
    const reach = Math.min(
      1,
      Math.max(0, (position.getY(vertex) - readShadeBottom(angle)) / width),
    );
    // Squared, so the shade gathers under the brim and thins out slowly readShadeBottom it.
    coverage[vertex] = 0.85 * reach * reach;
  }
  shell.setAttribute("coverage", new BufferAttribute(coverage, 1));
  list.add("shadow", shell, BONE.head);
}

/**
 * Adds a homburg: a creased crown with a band in the wearer's shade, sitting
 * on a brim that is a solid disc clearly wider than the head, curled up at
 * the sides and rolled at its edge.
 */
function addHomburg(list: PartList<Surface>, egg: Egg): void {
  const { unit, unitAcross } = egg;
  const brimHeight = egg.height - 4.6 * unit;
  const crownRadius = Math.max(7.6 * unitAcross, measureEggRadius(egg, brimHeight) * 1.03);
  const crownHeight = 8.6 * unit;
  const crown = new LatheGeometry(
    [
      new Vector2(crownRadius, -0.004),
      new Vector2(crownRadius * 0.985, crownHeight * 0.5),
      new Vector2(crownRadius * 0.95, crownHeight * 0.84),
      new Vector2(crownRadius * 0.84, crownHeight * 0.97),
      new Vector2(crownRadius * 0.55, crownHeight * 1.01),
      new Vector2(0.0005, crownHeight * 0.98),
    ],
    22,
    Math.PI,
  );
  // The crease along the crown from front to back.
  const position = crown.getAttribute("position");
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i);
    if (y > crownHeight * 0.6) {
      const reach = Math.min(1, (y - crownHeight * 0.6) / (crownHeight * 0.4));
      const across = position.getX(i) / (crownRadius * 0.38);
      position.setY(i, y - crownHeight * 0.16 * reach * Math.exp(-across * across));
    }
  }
  crown.computeVertexNormals();
  const band = new LatheGeometry(
    [
      new Vector2(crownRadius * 0.99, 0.05 * crownHeight),
      new Vector2(crownRadius * 1.03, 0.07 * crownHeight),
      new Vector2(crownRadius * 1.035, 0.3 * crownHeight),
      new Vector2(crownRadius * 0.99, 0.33 * crownHeight),
    ],
    22,
    Math.PI,
  );
  // The brim reaches well past the crown: a narrower one reads, from above,
  // as a thin ring drawn around the head.
  const brimRadius = crownRadius * 1.38;
  // A felt brim about a centimetre thick, rolled at its edge into a lip a
  // little thicker than the brim, flush with its underside.
  const thickness = Math.max(0.011, unit);
  const lipRadius = thickness * 0.8;
  const brim = new LatheGeometry(
    [
      new Vector2(crownRadius * 0.92, -thickness / 2),
      new Vector2(brimRadius - lipRadius, -thickness / 2),
      new Vector2(brimRadius - lipRadius, thickness / 2),
      new Vector2(crownRadius * 0.92, thickness / 2),
    ],
    30,
    Math.PI,
  );
  const lip = new TorusGeometry(brimRadius - lipRadius, lipRadius, 8, 48);
  lip.rotateX(Math.PI / 2);
  lip.translate(0, lipRadius - thickness / 2, 0);
  // The brim curls up at the sides, more the further out it reaches.
  for (const part of [brim, lip]) {
    const position = part.getAttribute("position");
    for (let i = 0; i < position.count; i++) {
      const across = position.getX(i) / brimRadius;
      position.setY(i, position.getY(i) + 2.4 * unit * across * across * across * across);
    }
    part.computeVertexNormals();
  }
  const tipForward = 0.06;
  const tipSideways = 0.07;
  const place = composeMatrix(0, brimHeight, 0, -tipForward, 0, tipSideways, 1, 1, 1).multiply(
    new Matrix4().makeScale(1, 1, egg.depth * 1.04),
  );
  list.add("hat", crown, BONE.head, place);
  list.add("shade", band, BONE.head, place);
  list.add("hat", brim, BONE.head, place);
  list.add("hat", lip, BONE.head, place);
  // The brim's underside where it meets the head, tipped as the hat is tipped.
  const headRadius = measureEggRadius(egg, brimHeight);
  addHatShadow(
    list,
    egg,
    (angle) =>
      brimHeight -
      thickness / 2 +
      headRadius * (tipSideways * Math.sin(angle) + tipForward * egg.depth * Math.cos(angle)),
  );
}

/** Adds a cloche: a bell pulled down to just above the brows, a band in the wearer's shade and a rosette. */
function addCloche(list: PartList<Surface>, egg: Egg): void {
  const { unit, unitAcross } = egg;
  // The brows are at the same face height on every shape, and the highest,
  // the waiting pose's raised brows, reach up to 19.6 on the face's 48-unit
  // grid. The edge sits high enough that the brim, including its lip and as
  // seen from the office's raised camera, ends clear above them; any lower
  // and a pose's brows show half hidden under the brim.
  const front = (42.4 - 17.4) * unit;
  const drop = 4.5 * unit;
  const readEdgeHeight = (angle: number) => front - drop * (0.5 - 0.5 * Math.cos(angle));
  const offset = Math.max(0.01, 0.55 * unit);
  const flare = 1.6 * unit;
  const bell = buildShell(egg, readEdgeHeight, offset, { flare });
  list.add("hat", bell, BONE.head);
  // A rolled lip along the brim's outer edge gives the brim its thickness.
  // It rides half its radius above that edge, so the brim drops no lower
  // over the brows than it did without it. The bell's first ring of vertices
  // is the edge; the ring's last vertex repeats its first.
  const rim = bell.getAttribute("position");
  const lipRadius = 0.6 * unit;
  const lip: Vector3[] = [];
  for (let s = 0; s < SHELL_SEGMENTS; s++) {
    lip.push(new Vector3().fromBufferAttribute(rim, s).setY(rim.getY(s) + lipRadius / 2));
  }
  const roll = new TubeGeometry(new CatmullRomCurve3(lip, true), 48, lipRadius, 6, true);
  list.add("hat", roll, BONE.head);
  addHatShadow(list, egg, (angle) => readEdgeHeight(angle) - flare * 0.45 - lipRadius / 2);
  list.add(
    "shade",
    buildShell(egg, readEdgeHeight, offset + 0.003, { from: 0.1, top: 0.26 }),
    BONE.head,
  );
  // The rosette on the colleague's left, over the band.
  const point = new Vector3();
  const normal = new Vector3();
  placeOnEgg(egg, 8.4 * unitAcross, front + 2.6 * unit, offset + 0.004, point, normal);
  const turn = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), normal);
  const rosette = buildDome(2.5 * unitAcross, 2.5 * unitAcross, 1.2 * unitAcross, 12);
  const button = buildDome(1 * unitAcross, 1 * unitAcross, 0.9 * unitAcross, 8);
  const at = new Matrix4().compose(point, turn, new Vector3(1, 1, 1));
  list.add("shade", rosette, BONE.head, at);
  list.add("hat", button, BONE.head, at.clone().multiply(composeMatrix(0, 0, 0.9 * unitAcross)));
}

/** Adds a beret: a soft disc tipped over one side, with its little stalk. */
function addBeret(list: PartList<Surface>, egg: Egg): void {
  const { unit, unitAcross } = egg;
  const radius = 12.2 * unitAcross;
  const disc = new SphereGeometry(1, 24, 10);
  disc.scale(radius, 3.6 * unit, radius * egg.depth * 1.02);
  const place = composeMatrix(-1.4 * unitAcross, egg.height - 2.1 * unit, -0.01, -0.08, 0, 0.16);
  list.add("hat", disc, BONE.head, place);
  const stalk = new CapsuleGeometry(0.75 * unit, 1.6 * unit, 2, 6);
  stalk.translate(0, 3.6 * unit + 0.8 * unit, 0);
  list.add(
    "hat",
    stalk,
    BONE.head,
    place.clone().multiply(composeMatrix(-0.8 * unitAcross, 0, 0, 0, 0, 0.2)),
  );
}

/**
 * Returns the egg's outline from `fromHeight` up to the top, pushed `offset`
 * metres out along the outline's normal, as [radius, height] points.
 */
function traceOutline(egg: Egg, fromHeight: number, offset: number): Array<[number, number]> {
  const points: Array<[number, number]> = [[measureEggRadius(egg, fromHeight), fromHeight]];
  for (const [radius, height] of egg.outline)
    if (height > fromHeight) points.push([radius, height]);
  return points.map(([radius, height], i) => {
    const [r0, h0] = points[Math.max(0, i - 1)]!;
    const [r1, h1] = points[Math.min(points.length - 1, i + 1)]!;
    // The outward normal of an outline walked upward is its tangent turned clockwise.
    const length = Math.hypot(r1 - r0, h1 - h0);
    return [radius + ((h1 - h0) / length) * offset, height - ((r1 - r0) / length) * offset];
  });
}

/** Adds a switchboard headset: a band over the head, one earcup on the right and a mouthpiece on a boom. */
function addHeadset(list: PartList<Surface>, egg: Egg): void {
  const { unit, unitAcross } = egg;
  const earHeight = (42.4 - 27.6) * unit;
  const side = traceOutline(egg, earHeight, 0.8 * unit);
  // The band runs from the right ear (-x), over the top, to the left ear (+x).
  const band = [
    ...side.map(([radius, height]) => new Vector3(-radius, height, 0)),
    ...side
      .slice(0, -1)
      .reverse()
      .map(([radius, height]) => new Vector3(radius, height, 0)),
  ];
  list.add("hat", buildStroke(band, 0.95 * unit), BONE.head);
  const earRadius = measureEggRadius(egg, earHeight);
  const cup = new CapsuleGeometry(2.6 * unitAcross, 3.4 * unit, 3, 12);
  list.add(
    "hat",
    cup,
    BONE.head,
    composeMatrix(-earRadius - 0.4 * unit, earHeight, 0, 0, 0, 0, 0.5, 1, 1),
  );
  const pad = new SphereGeometry(1.5 * unitAcross, 10, 6);
  list.add(
    "hat",
    pad,
    BONE.head,
    composeMatrix(earRadius + 0.2 * unit, earHeight, 0, 0, 0, 0, 0.45, 1, 1),
  );
  // The boom: from under the earcup, round the cheek, to the mouthpiece by the mouth.
  const normal = new Vector3();
  const start = new Vector3(-earRadius - 0.6 * unit, earHeight - 3.6 * unit, 0.6 * unit);
  const middle = placeOnEgg(
    egg,
    -12.8 * unitAcross,
    (42.4 - 34.2) * unit,
    1.4 * unit,
    new Vector3(),
    normal,
  );
  const mouth = placeOnEgg(
    egg,
    -6.8 * unitAcross,
    (42.4 - 36.6) * unit,
    1.6 * unit,
    new Vector3(),
    normal,
  );
  list.add("hat", buildStroke([start, middle, mouth], 0.7 * unit), BONE.head);
  const mic = new SphereGeometry(1.7 * unitAcross, 10, 8);
  mic.translate(mouth.x, mouth.y, mouth.z);
  list.add("hat", mic, BONE.head);
}

// ---------------------------------------------------------------------------
// Accessories below the face: on a bean's body, on a suited colleague's chest.

/** Where the accessories below the face sit: on a bean's body, on a suited colleague's suit. */
interface Chest {
  /** The egg they sit on. */
  readonly egg: Egg;
  /** The bone they follow. */
  readonly bone: number;
  /** The bowtie's knot, in the egg's face plane. */
  readonly knot: Vector3;
  /** Where the watch chain starts, in the egg's face plane; the watch hangs to its left (+x). */
  readonly fob: Vector3;
  /** Metres per unit of the 2D face's drawings of these accessories. */
  readonly unit: number;
}

/** Returns where the accessories below the face sit, for `anatomy`. */
export function readChest(anatomy: Anatomy): Chest {
  if (anatomy.jacket === null) {
    return {
      egg: anatomy.egg,
      bone: BONE.head,
      knot: mapFacePoint(anatomy.egg, 24, 37.8, new Vector3()),
      fob: mapFacePoint(anatomy.egg, 24.4, 37.6, new Vector3()),
      unit: anatomy.egg.unit,
    };
  }
  return {
    egg: anatomy.jacket,
    bone: BONE.torso,
    knot: new Vector3(0, anatomy.jacket.height - 0.04, 0),
    fob: new Vector3(0, anatomy.jacket.height * 0.5, 0),
    unit: 0.0085,
  };
}

/** Adds a bowtie at the chest's knot: two rounded wings and a knot. */
function addBowtie(list: PartList<Surface>, anatomy: Anatomy): void {
  const chest = readChest(anatomy);
  // On a bean the knot sits low, where the egg turns under, so a book-sized
  // bowtie would wrap round half the body; it is drawn smaller there.
  const u = chest.unit * (anatomy.jacket === null ? 0.62 : 1);
  const wing = new Shape();
  wing.moveTo(0, 0);
  wing.lineTo(-5 * u, 2.7 * u);
  wing.quadraticCurveTo(-6.6 * u, 3.3 * u, -6.6 * u, 1.8 * u);
  wing.lineTo(-6.6 * u, -1.8 * u);
  wing.quadraticCurveTo(-6.6 * u, -3.3 * u, -5 * u, -2.7 * u);
  wing.lineTo(0, 0);
  const left = buildPlate(wing, 1.6 * u, 4);
  const right = left.clone();
  right.scale(-1, 1, 1);
  // Mirroring turns the faces inside out; swap each triangle's winding back.
  flipWinding(right);
  for (const part of [left, right]) {
    part.translate(chest.knot.x, chest.knot.y, 1.4 * u);
    list.add("trim", wrapOntoEgg(part, chest.egg, 0.002), chest.bone);
  }
  const knot = buildDome(1.8 * u, 1.7 * u, 1.5 * u, 10);
  knot.translate(chest.knot.x, chest.knot.y, 1.2 * u);
  list.add("trim", wrapOntoEgg(knot, chest.egg, 0.002), chest.bone);
}

/** Reverses the winding of every triangle of a non-indexed geometry. */
function flipWinding(geometry: BufferGeometry): void {
  for (const name of ["position", "normal"]) {
    const attribute = geometry.getAttribute(name);
    for (let i = 0; i < attribute.count; i += 3) {
      const x = attribute.getX(i + 1);
      const y = attribute.getY(i + 1);
      const z = attribute.getZ(i + 1);
      attribute.setXYZ(i + 1, attribute.getX(i + 2), attribute.getY(i + 2), attribute.getZ(i + 2));
      attribute.setXYZ(i + 2, x, y, z);
    }
  }
}

/**
 * Builds a pocket watch's brass case, and the chain that runs to it from the
 * fob, in the chest bone's space (`readChest(anatomy).bone`). Returns the case
 * and the chain.
 */
export function buildWatchCase(anatomy: Anatomy): BufferGeometry[] {
  const { egg, fob, unit: u } = readChest(anatomy);
  const watchCase = new CylinderGeometry(2.7 * u, 2.7 * u, 1 * u, 18);
  watchCase.rotateX(Math.PI / 2);
  watchCase.deleteAttribute("uv");
  watchCase.translate(fob.x + 9 * u, fob.y - 0.2 * u, 0.5 * u);
  const chain = traceQuadratic(
    new Vector3(fob.x, fob.y, 0),
    new Vector3(fob.x + 3.4 * u, fob.y - 2.6 * u, 0),
    new Vector3(fob.x + 6.6 * u, fob.y - 0.2 * u, 0),
    8,
  );
  return [wrapOntoEgg(watchCase, egg, 0.001), wrapOntoEgg(buildStroke(chain, 0.5 * u), egg, 0.001)];
}

/** Builds the cream dial of a pocket watch, in the chest bone's space. */
export function buildWatchDial(anatomy: Anatomy): BufferGeometry {
  const { egg, fob, unit: u } = readChest(anatomy);
  const dial = new CylinderGeometry(1.8 * u, 1.8 * u, 0.4 * u, 16);
  dial.rotateX(Math.PI / 2);
  dial.deleteAttribute("uv");
  dial.translate(fob.x + 9 * u, fob.y - 0.2 * u, 1.05 * u);
  return wrapOntoEgg(dial, egg, 0.001);
}

/** Builds the monocle's brass chain, from the rim down the cheek, in the head's space. */
export function buildMonocleChain(egg: Egg): BufferGeometry {
  const start = new Vector3();
  const middle = new Vector3();
  const end = new Vector3();
  mapFacePoint(egg, 32.4, 29.2, start);
  mapFacePoint(egg, 34.4, 33.6, middle);
  mapFacePoint(egg, 33, 38, end);
  const chain = buildStroke(traceQuadratic(start, middle, end, 8), 0.42 * egg.unit);
  return wrapOntoEgg(chain, egg, 0.002);
}

// ---------------------------------------------------------------------------
// The suit.

/** Adds a suited colleague's jacket, waistcoat front and buttons. */
function addSuit(list: PartList<Surface>, anatomy: Anatomy): void {
  const jacket = anatomy.jacket!;
  list.add("shade", buildEggGeometry(jacket, 16), BONE.torso);
  // The waistcoat: a V from the collar down to the belly, in the hue's tint.
  const columns = 8;
  const rows = 10;
  const low = jacket.height * 0.3;
  const high = jacket.height * 0.985;
  const positions: number[] = [];
  const normals: number[] = [];
  const point = new Vector3();
  const normal = new Vector3();
  for (let r = 0; r <= rows; r++) {
    const t = r / rows;
    const height = low + (high - low) * t;
    const radius = measureEggRadius(jacket, height);
    const reach = radius * (0.1 + 0.55 * t * t);
    for (let c = 0; c <= columns; c++) {
      const across = (c / columns) * 2 - 1;
      placeOnEgg(jacket, across * reach, height, 0.004, point, normal);
      positions.push(point.x, point.y, point.z);
      normals.push(normal.x, normal.y, normal.z);
    }
  }
  const index: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const a = r * (columns + 1) + c;
      const b = a + columns + 1;
      index.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const front = new BufferGeometry();
  front.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  front.setAttribute("normal", new BufferAttribute(new Float32Array(normals), 3));
  front.setIndex(index);
  list.add("tint", front, BONE.torso);
  for (const t of [0.18, 0.38, 0.58]) {
    const height = low + (high - low) * t;
    const button = buildDome(0.009, 0.009, 0.006, 8);
    button.translate(0, height, 0);
    list.add("trim", wrapOntoEgg(button, jacket, 0.004), BONE.torso);
  }
  // The shirt cuffs at the wrists.
  for (const bone of [BONE.elbowL, BONE.elbowR]) {
    const cuff = new CylinderGeometry(
      anatomy.armRadius * 1.04,
      anatomy.armRadius * 1.06,
      0.024,
      12,
      1,
      true,
    );
    cuff.translate(0, -anatomy.forearm + 0.006, 0);
    list.add("tint", cuff, bone);
  }
}

// ---------------------------------------------------------------------------
// The whole look.

/** What decides a colleague's shared geometry: everything in its look but its hue. */
export interface Build {
  readonly anatomy: Anatomy;
  readonly accessories: ReadonlyArray<Accessory>;
  readonly headwear: Headwear | null;
}

/** Returns the key two rigs with the same shared geometry have in common. */
function readBuildKey(build: Build): string {
  const { anatomy, accessories, headwear } = build;
  return `${anatomy.style}|${anatomy.shape}|${[...accessories].sort().join(",")}|${headwear ?? ""}`;
}

/** A colleague's body, without its face, as the geometry of its two meshes. */
interface BodyGeometry {
  /** Everything but the hat, for the vinyl body mesh. */
  readonly body: BufferGeometry;
  /** The hat, for a satin mesh of its own, or null without a hat. */
  readonly hat: BufferGeometry | null;
}

/** A body before it is painted in a hue. */
interface LayeredBody {
  readonly body: LayeredGeometry<Surface>;
  readonly hat: LayeredGeometry<Surface> | null;
}

const layeredBodies = new Map<string, LayeredBody>();
const paintedBodies = new Map<string, BodyGeometry>();
// The palette forgets the painted bodies' repaints when the Office closes, at
// the same time as these maps are emptied.
registerCache(() => {
  layeredBodies.clear();
  paintedBodies.clear();
});

/**
 * Returns the body of a look, built once per look and then shared, painted
 * once per look and hue. Every painting shares the look's positions,
 * normals and skin weights; only the colours are its own.
 */
export function readBodyGeometry(build: Build, hue: Hue): BodyGeometry {
  const key = `${readBuildKey(build)}|${hue}`;
  const known = paintedBodies.get(key);
  if (known !== undefined) return known;
  const layered = readLayeredBody(build);
  const readSurfaceColor = (surface: Surface): Color =>
    surface === "hat" || surface === "trim"
      ? readColor("hat")
      : writeOklch(new Color(), readHue(hue, surface === "shadow" ? "ink" : surface));
  const painted: BodyGeometry = {
    body: paintLayers(layered.body, readSurfaceColor, "body"),
    hat: layered.hat === null ? null : paintLayers(layered.hat, readSurfaceColor),
  };
  paintedBodies.set(key, painted);
  return painted;
}

/** Returns the unpainted body of a look, built once per look and then shared. */
function readLayeredBody(build: Build): LayeredBody {
  const key = readBuildKey(build);
  const known = layeredBodies.get(key);
  if (known !== undefined) return known;
  const { anatomy, accessories, headwear } = build;
  const list = new PartList<Surface>();
  const suited = anatomy.style === "suited";
  list.add("body", buildEggGeometry(anatomy.egg, suited ? 16 : 22), BONE.head);
  if (suited) addSuit(list, anatomy);
  list.add("shade", buildLimb(anatomy.armRadius, anatomy.upperArm), BONE.shoulderL);
  list.add("shade", buildLimb(anatomy.armRadius, anatomy.upperArm), BONE.shoulderR);
  list.add("shade", buildLimb(anatomy.armRadius * 0.97, anatomy.forearm), BONE.elbowL);
  list.add("shade", buildLimb(anatomy.armRadius * 0.97, anatomy.forearm), BONE.elbowR);
  const hand = suited ? "body" : "shade";
  list.add(hand, buildMitten(anatomy.handRadius), BONE.handL);
  list.add(hand, buildMitten(anatomy.handRadius), BONE.handR);
  list.add("shade", buildLimb(anatomy.legRadius, anatomy.thigh), BONE.hipL);
  list.add("shade", buildLimb(anatomy.legRadius, anatomy.thigh), BONE.hipR);
  list.add("shade", buildLimb(anatomy.legRadius * 0.96, anatomy.shin), BONE.kneeL);
  list.add("shade", buildLimb(anatomy.legRadius * 0.96, anatomy.shin), BONE.kneeR);
  list.add("trim", buildShoe(anatomy), BONE.footL);
  list.add("trim", buildShoe(anatomy), BONE.footR);
  if (accessories.includes("homburg")) addHomburg(list, anatomy.egg);
  else if (headwear === "cloche") addCloche(list, anatomy.egg);
  else if (headwear === "beret") addBeret(list, anatomy.egg);
  else if (headwear === "headset") addHeadset(list, anatomy.egg);
  if (accessories.includes("bowtie")) addBowtie(list, anatomy);
  const layered: LayeredBody = {
    body: list.mergeLayers(BODY_SURFACES),
    hat: list.has("hat") ? list.mergeLayers(["hat"]) : null,
  };
  layeredBodies.set(key, layered);
  return layered;
}

/** Returns the height of the top of the hat above the egg's top, or 0 without one. */
export function measureHatHeight(build: Build): number {
  const { egg } = build.anatomy;
  if (build.accessories.includes("homburg")) return 4.2 * egg.unit;
  switch (build.headwear) {
    case "cloche":
      return 0.8 * egg.unit;
    case "beret":
      return 2.6 * egg.unit;
    case "headset":
      return 1.6 * egg.unit;
    case null:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Things a colleague holds, and the selection ring. Each is its own small
// mesh, shown only while it is in use.

/** Builds a teacup with its handle, its base at the origin. */
export function buildCup(): BufferGeometry {
  const body = new LatheGeometry(
    [
      new Vector2(0.0001, 0),
      new Vector2(0.018, 0),
      new Vector2(0.024, 0.006),
      new Vector2(0.03, 0.03),
      new Vector2(0.033, 0.045),
      new Vector2(0.03, 0.046),
      new Vector2(0.027, 0.032),
      new Vector2(0.0001, 0.03),
    ],
    16,
  );
  const handle = new TorusGeometry(0.012, 0.0035, 5, 10, Math.PI * 1.3);
  handle.rotateZ(-Math.PI * 0.65);
  handle.translate(0.034, 0.026, 0);
  const merged = mergeGeometries([body.toNonIndexed(), handle.toNonIndexed()], false);
  if (merged === null) throw new Error("The cup could not be merged.");
  merged.deleteAttribute("uv");
  return merged;
}

/** Builds a saucer, its base at the origin. */
export function buildSaucer(): BufferGeometry {
  const geometry = new LatheGeometry(
    [
      new Vector2(0.0001, 0),
      new Vector2(0.03, 0),
      new Vector2(0.05, 0.008),
      new Vector2(0.056, 0.014),
      new Vector2(0.052, 0.014),
      new Vector2(0.03, 0.006),
      new Vector2(0.0001, 0.006),
    ],
    18,
  );
  geometry.deleteAttribute("uv");
  return geometry;
}

/** Builds a folded newspaper, held upright and facing -z (towards its reader), centred on the origin. */
export function buildNewspaper(width: number, height: number): BufferGeometry {
  const half = width / 2;
  const pages: BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const page = buildPlate(buildRoundedRectangle(half, height, 0.004), 0.004, 2);
    page.translate((side * half) / 2, 0, 0);
    page.rotateY(side * 0.22);
    page.translate(0, 0, -Math.sin(0.22) * half * 0.5);
    pages.push(page);
  }
  const merged = mergeGeometries(pages, false);
  if (merged === null) throw new Error("The newspaper could not be merged.");
  merged.computeVertexNormals();
  return merged;
}

/** Builds a magnifying glass's brass rim and handle, the lens centre at the origin, facing +z. */
export function buildLoupe(): BufferGeometry {
  const rim = new TorusGeometry(0.042, 0.0065, 5, 18);
  const handle = new CapsuleGeometry(0.0085, 0.07, 2, 8);
  handle.translate(0, -0.042 - 0.045, 0);
  const collar = new CylinderGeometry(0.011, 0.011, 0.014, 10);
  collar.translate(0, -0.05, 0);
  const merged = mergeGeometries(
    [rim.toNonIndexed(), handle.toNonIndexed(), collar.toNonIndexed()],
    false,
  );
  if (merged === null) throw new Error("The loupe could not be merged.");
  merged.deleteAttribute("uv");
  return merged;
}

/** Builds the loupe's lens: a thin disc filling the rim. */
export function buildLens(): BufferGeometry {
  const lens = new CylinderGeometry(0.038, 0.038, 0.004, 18);
  lens.rotateX(Math.PI / 2);
  lens.deleteAttribute("uv");
  return lens;
}

/** Builds the flat ring on the floor that marks a selected colleague, in the floor's plane. */
export function buildSelectionRing(radius: number): BufferGeometry {
  const ring = new RingGeometry(radius - 0.035, radius, 56, 1);
  ring.rotateX(-Math.PI / 2);
  ring.deleteAttribute("uv");
  return ring;
}

/** Builds the letter Z as a flat plate, its middle at the origin, `size` tall, facing +z. */
export function buildLetterZ(size: number): BufferGeometry {
  const s = size;
  const t = s * 0.2;
  const shape = new Shape();
  shape.moveTo(-0.42 * s, 0.5 * s);
  shape.lineTo(0.42 * s, 0.5 * s);
  shape.lineTo(0.42 * s, 0.5 * s - t);
  shape.lineTo(-0.16 * s, -0.5 * s + t);
  shape.lineTo(0.44 * s, -0.5 * s + t);
  shape.lineTo(0.44 * s, -0.5 * s);
  shape.lineTo(-0.44 * s, -0.5 * s);
  shape.lineTo(-0.44 * s, -0.5 * s + t);
  shape.lineTo(0.14 * s, 0.5 * s - t);
  shape.lineTo(-0.42 * s, 0.5 * s - t);
  shape.lineTo(-0.42 * s, 0.5 * s);
  const geometry = new ExtrudeGeometry(shape, {
    depth: s * 0.1,
    bevelEnabled: true,
    bevelThickness: s * 0.04,
    bevelSize: s * 0.04,
    bevelSegments: 2,
  });
  geometry.translate(0, 0, -s * 0.05);
  geometry.deleteAttribute("uv");
  geometry.computeVertexNormals();
  return geometry;
}
