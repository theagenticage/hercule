/**
 * The tools every prop is built with: rounded shapes, a list
 * that collects a prop's parts and merges them into as few meshes as it can,
 * and the markers seats are found by.
 *
 * A prop's geometry is built once, the first time the prop is built, and
 * every instance shares it. Draw calls cost more than triangles: every mesh
 * is drawn again for the shadows and for the ambient occlusion. So a prop's
 * surfaces are merged by finish rather than by colour: all its lacquered
 * parts are one mesh, all its brass another, and each part's colour is
 * painted into its vertices. Only a surface that changes at runtime, such as
 * a lamp's shade that lights up, keeps a mesh of its own.
 */
import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  Euler,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
  type ExtrudeGeometryOptions,
  type Shape,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries, toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  paint,
  paintVertexColors,
  readColor,
  readToken,
  subscribePalette,
  writeOklch,
  type Finish,
  type Shift,
  type Token,
} from "../../engine/palette";

/** Where a part sits in its prop: a position, a rotation in radians, and a scale. */
export interface Placement {
  readonly x?: number;
  readonly y?: number;
  readonly z?: number;
  /** Rotations, applied in the order z, x, then y (yaw last). */
  readonly rx?: number;
  readonly ry?: number;
  readonly rz?: number;
  readonly sx?: number;
  readonly sy?: number;
  readonly sz?: number;
}

/** Builds the matrix that moves a part from its own space into its prop's space. */
function buildPlacementMatrix(placement: Placement): Matrix4 {
  const rotation = new Quaternion().setFromEuler(
    new Euler(placement.rx ?? 0, placement.ry ?? 0, placement.rz ?? 0, "YXZ"),
  );
  return new Matrix4().compose(
    new Vector3(placement.x ?? 0, placement.y ?? 0, placement.z ?? 0),
    rotation,
    new Vector3(placement.sx ?? 1, placement.sy ?? 1, placement.sz ?? 1),
  );
}

/**
 * Converts a geometry to the one layout every merged part shares: no index,
 * and only positions and normals. No prop material has a texture, so texture
 * coordinates would only cost memory. Returns a new geometry.
 */
function normalizeGeometry(geometry: BufferGeometry): BufferGeometry {
  const flat = geometry.index === null ? geometry.clone() : geometry.toNonIndexed();
  for (const name of Object.keys(flat.attributes)) {
    if (name !== "position" && name !== "normal") flat.deleteAttribute(name);
  }
  if (flat.getAttribute("normal") === undefined) flat.computeVertexNormals();
  return flat;
}

/** How a surface is painted, and whether it casts a shadow. */
export interface Surface {
  readonly token: Token;
  readonly finish: Finish;
  readonly shift?: Shift;
  /**
   * Whether the surface casts a shadow. Small details do not, unless they
   * share a finish with a surface that does. A detail that casts no shadow
   * needs a mesh of its own, which is drawn twice (for the frame and for the
   * ambient occlusion) to save the one draw of its shadow. So such a detail
   * casts a shadow and shares the other surface's mesh.
   */
  readonly shadow: boolean;
  /**
   * Whether the surface's material changes at runtime, such as a lamp's shade
   * that lights up. Such a surface keeps a mesh of its own; every other
   * surface shares one mesh with the prop's other surfaces of the same finish.
   */
  readonly changesAtRuntime?: boolean;
}

/** Returns the shared palette material that paints `surface`. */
export function paintSurface(surface: Surface): ReturnType<typeof paint> {
  return paint(surface.token, surface.finish, surface.shift ?? {});
}

/** The surfaces of a prop that share a finish and whether they cast a shadow, merged into one geometry. */
interface SurfaceBatch {
  readonly finish: Finish;
  readonly shadow: boolean;
  /** Every part of the batch's surfaces, with each surface's colour painted into its vertices. */
  readonly geometry: BufferGeometry;
}

/** A surface that changes at runtime, merged into a geometry of its own. */
interface SeparateSurface {
  readonly surface: Surface;
  readonly geometry: BufferGeometry;
}

/**
 * A prop's merged geometry, which every instance of the prop shares:
 * - one geometry per batch of surfaces with the same finish and shadow;
 * - one geometry per surface that changes at runtime, by the surface's name.
 */
export interface MergedProp<S extends string> {
  readonly batches: ReadonlyArray<SurfaceBatch>;
  readonly separate: ReadonlyMap<S, SeparateSurface>;
}

/**
 * The part of a `PartList` a builder of shared parts needs: a chair or a lamp
 * adds its parts to any list that has its surfaces, among others.
 */
export interface PartSink<S extends string> {
  add(surface: S, geometry: BufferGeometry, placement?: Placement): void;
  nest(placement: Placement, build: () => void): void;
}

/**
 * Collects a prop's parts by surface and merges them into the prop's shared
 * geometry. `nest` places a group of parts together, such as a chair beside
 * a desk.
 */
export class PartList<S extends string> implements PartSink<S> {
  private readonly surfaces: Readonly<Record<S, Surface>>;
  private readonly parts = new Map<S, BufferGeometry[]>();
  private readonly stack: Matrix4[] = [new Matrix4()];

  /** Starts an empty list of parts painted with `surfaces`. */
  constructor(surfaces: Readonly<Record<S, Surface>>) {
    this.surfaces = surfaces;
  }

  /** Adds a part on `surface`, moved by `placement` and by every `nest` around this call. */
  add(surface: S, geometry: BufferGeometry, placement: Placement = {}): void {
    const matrix = this.currentMatrix().clone().multiply(buildPlacementMatrix(placement));
    const part = normalizeGeometry(geometry).applyMatrix4(matrix);
    geometry.dispose();
    const list = this.parts.get(surface);
    if (list === undefined) this.parts.set(surface, [part]);
    else list.push(part);
  }

  /** Runs `build`, placing every part it adds by `placement` as well. */
  nest(placement: Placement, build: () => void): void {
    this.stack.push(this.currentMatrix().clone().multiply(buildPlacementMatrix(placement)));
    build();
    this.stack.pop();
  }

  /**
   * Merges the parts into one geometry per batch of surfaces with the same
   * finish and shadow, and one per surface that changes at runtime. Returns
   * the merged prop; the list is spent after it. Fails if three.js cannot
   * merge the parts.
   */
  merge(): MergedProp<S> {
    const separate = new Map<S, SeparateSurface>();
    const batches = new Map<string, { finish: Finish; shadow: boolean; members: BatchMember[] }>();
    for (const [name, parts] of this.parts) {
      const surface = this.surfaces[name];
      if (surface.changesAtRuntime === true) {
        separate.set(name, { surface, geometry: mergeParts(parts) });
        continue;
      }
      const key = `${surface.finish}|${String(surface.shadow)}`;
      const batch = batches.get(key);
      if (batch === undefined) {
        batches.set(key, {
          finish: surface.finish,
          shadow: surface.shadow,
          members: [{ surface, parts }],
        });
      } else {
        batch.members.push({ surface, parts });
      }
    }
    this.parts.clear();
    return {
      batches: [...batches.values()].map(({ finish, shadow, members }) => ({
        finish,
        shadow,
        geometry: buildBatchGeometry(members),
      })),
      separate,
    };
  }

  private currentMatrix(): Matrix4 {
    return this.stack[this.stack.length - 1]!;
  }
}

/** A surface in a batch, with its parts. */
interface BatchMember {
  readonly surface: Surface;
  readonly parts: readonly BufferGeometry[];
}

/** Merges `parts` into one geometry and disposes them. Fails if three.js cannot merge them. */
function mergeParts(parts: readonly BufferGeometry[]): BufferGeometry {
  const geometry = mergeGeometries([...parts]);
  if (geometry === null) throw new Error("The props kit could not merge a prop's parts.");
  geometry.computeBoundingSphere();
  for (const part of parts) part.dispose();
  return geometry;
}

/** The vertices one surface owns in a batch's geometry. */
interface VertexRange {
  readonly surface: Surface;
  readonly start: number;
  readonly count: number;
}

/**
 * Merges the parts of a batch's surfaces into one geometry, and paints each
 * surface's colour into the vertices it owns. The colours are painted again
 * whenever the palette changes, once for every instance, because instances
 * share the geometry. Returns the geometry.
 */
function buildBatchGeometry(members: readonly BatchMember[]): BufferGeometry {
  const ranges: VertexRange[] = [];
  let start = 0;
  for (const { surface, parts } of members) {
    const count = parts.reduce((total, part) => total + part.getAttribute("position").count, 0);
    ranges.push({ surface, start, count });
    start += count;
  }
  const geometry = mergeParts(members.flatMap((member) => member.parts));
  geometry.setAttribute("color", new Float32BufferAttribute(new Float32Array(start * 3), 3));
  const repaint = () => writeSurfaceColors(geometry, ranges);
  repaint();
  subscribePalette(repaint);
  return geometry;
}

/**
 * Writes each surface's colour, in the current theme, into the vertices it
 * owns. The colours are linear, as three.js expects of vertex colours, and
 * the same as the palette would give the surface's own material.
 */
function writeSurfaceColors(geometry: BufferGeometry, ranges: readonly VertexRange[]): void {
  const colors = geometry.getAttribute("color");
  for (const { surface, start, count } of ranges) {
    const color = readColor(surface.token, surface.shift ?? {});
    for (let vertex = start; vertex < start + count; vertex++) {
      colors.setXYZ(vertex, color.r, color.g, color.b);
    }
  }
  colors.needsUpdate = true;
}

/**
 * Adds an instance of a merged prop to `parent`: one mesh per batch and one
 * per surface that changes at runtime, each sharing the merged geometry.
 * Returns the meshes of the surfaces that change at runtime, by name.
 */
export function addMeshes<S extends string>(parent: Object3D, merged: MergedProp<S>): Map<S, Mesh> {
  for (const { finish, shadow, geometry } of merged.batches) {
    const mesh = new Mesh(geometry, paintVertexColors(finish));
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    mesh.name = finish;
    parent.add(mesh);
  }
  const meshes = new Map<S, Mesh>();
  for (const [name, { surface, geometry }] of merged.separate) {
    const mesh = new Mesh(geometry, paintSurface(surface));
    mesh.castShadow = surface.shadow;
    mesh.receiveShadow = true;
    mesh.name = name;
    parent.add(mesh);
    meshes.set(name, mesh);
  }
  return meshes;
}

/** Builds a group named `name` holding an instance of a merged prop. Returns the group. */
export function buildPropGroup<S extends string>(name: string, merged: MergedProp<S>): Group {
  const group = new Group();
  group.name = name;
  addMeshes(group, merged);
  return group;
}

/** Returns a function that builds a value the first time it is called, and the same value after. */
export function memoize<T>(build: () => T): () => T {
  let value: T | undefined;
  let built = false;
  return () => {
    if (!built) {
      value = build();
      built = true;
    }
    return value as T;
  };
}

/** Returns a function that builds a value once per key, and the same value for that key after. */
export function memoizeByKey<K, T>(build: (key: K) => T): (key: K) => T {
  const values = new Map<K, T>();
  return (key) => {
    const known = values.get(key);
    if (known !== undefined) return known;
    const value = build(key);
    values.set(key, value);
    return value;
  };
}

/** Returns a marker at (x, z) on the floor, facing `facing` (yaw; 0 faces +z). */
export function buildMarker(x: number, z: number, facing: number): Object3D {
  const object = new Object3D();
  object.position.set(x, 0, z);
  object.rotation.y = facing;
  object.name = "marker";
  return object;
}

// ---------------------------------------------------------------------------
// Shapes. Each returns a fresh geometry with its base at y = 0, centred on x and z,
// so a placement's `y` is the height the shape stands on.

/** Builds a box with rounded edges. `segments` 1 gives a soft bevel, 2 or more a round edge. */
export function buildBlock(
  width: number,
  height: number,
  depth: number,
  radius: number,
  segments = 2,
): BufferGeometry {
  const geometry = new RoundedBoxGeometry(width, height, depth, segments, radius);
  return geometry.translate(0, height / 2, 0);
}

/** Builds a plain box, for flat things too thin to need a rounded edge, such as a sheet of paper. */
export function buildSheet(width: number, height: number, depth: number): BufferGeometry {
  return new BoxGeometry(width, height, depth).translate(0, height / 2, 0);
}

/** Builds an upright cylinder or cone, closed at both ends. */
export function buildCylinder(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  segments = 16,
): BufferGeometry {
  return new CylinderGeometry(radiusTop, radiusBottom, height, segments).translate(
    0,
    height / 2,
    0,
  );
}

/**
 * Builds a turned shape from a profile of [radius, height] points, from the
 * bottom up. A profile that starts and ends at radius 0 is closed.
 */
export function buildLathe(
  profile: ReadonlyArray<readonly [number, number]>,
  segments = 24,
): BufferGeometry {
  return new LatheGeometry(
    profile.map(([radius, height]) => new Vector2(radius, height)),
    segments,
  );
}

/** Builds a sphere, or a slice of one from the top down to `thetaLength`, centred at the origin. */
export function buildSphere(
  radius: number,
  widthSegments = 16,
  heightSegments = 10,
  thetaLength = Math.PI,
): BufferGeometry {
  return new SphereGeometry(radius, widthSegments, heightSegments, 0, Math.PI * 2, 0, thetaLength);
}

/** Builds a ring in the x-y plane, centred at the origin. */
export function buildRing(
  radius: number,
  tube: number,
  arc = Math.PI * 2,
  radialSegments = 8,
  tubularSegments = 32,
): BufferGeometry {
  return new TorusGeometry(radius, tube, radialSegments, tubularSegments, arc);
}

/**
 * Builds a 2D shape drawn in the x-y plane, extruded along +z by `depth`, with
 * a soft bevel. `curveSegments` sets how finely the shape's curves are drawn.
 * Its normals are smoothed across every angle under 50 degrees, so curves and
 * bevels look round rather than faceted.
 */
export function buildExtrusion(
  shape: Shape,
  depth: number,
  bevel: number,
  curveSegments = 12,
): BufferGeometry {
  const options: ExtrudeGeometryOptions = {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments,
  };
  return toCreasedNormals(new ExtrudeGeometry(shape, options), (50 / 180) * Math.PI);
}

/**
 * Builds a thin rod from `from` to `to`, a cylinder of `radius`. For
 * strings, rails and stems that run at an angle.
 */
export function buildRod(from: Vector3, to: Vector3, radius: number, segments = 6): BufferGeometry {
  const length = from.distanceTo(to);
  const geometry = new CylinderGeometry(radius, radius, length, segments, 1, true);
  const direction = to.clone().sub(from).normalize();
  const rotation = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction);
  const middle = from.clone().add(to).multiplyScalar(0.5);
  return geometry.applyMatrix4(new Matrix4().compose(middle, rotation, new Vector3(1, 1, 1)));
}

// ---------------------------------------------------------------------------
// Lamplight. The warm light of a lit lamp, read from the theme's sunlight
// token at a fixed high lightness, so every theme's lamps glow the same warm white.

/** Writes the colour of lamplight in the current theme into `target`, at `lightness` in OKLCH. */
export function writeLamplight(target: Color, lightness = 0.93): Color {
  const sun = readToken("room-sun");
  return writeOklch(target, { l: lightness, c: Math.min(0.1, sun.c + 0.03), h: sun.h });
}

/** Builds the soft round alpha mask a lamp's pool of light is drawn with. */
const buildPoolMask = memoize(() => {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("The props kit could not create a 2D canvas.");
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, "rgb(255,255,255)");
  gradient.addColorStop(0.45, "rgb(150,150,150)");
  gradient.addColorStop(1, "rgb(0,0,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  return new CanvasTexture(canvas);
});

/**
 * Returns the shared material of a lamp's pool of light on a surface: lamplight
 * that fades out from the middle. It is not a palette material because it
 * needs the fading mask, so it repaints itself when the palette changes.
 */
export const readPoolMaterial = memoize(() => {
  const material = new MeshBasicMaterial({
    alphaMap: buildPoolMask(),
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
  });
  material.name = "lamp-pool";
  const repaint = () => writeLamplight(material.color, 0.95);
  repaint();
  subscribePalette(repaint);
  return material;
});

/**
 * Returns a seeded random number generator: each call returns the next number
 * in [0, 1). The same seed always gives the same numbers, so a bookshelf's
 * books stand the same way every time it is built.
 */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
