/**
 * PROTOTYPE - the pneumatic tubes that carry events to Triage: a glass tube
 * along a polyline with rounded bends and brass collars, and paper capsules
 * that ride through it.
 */
import {
  BufferGeometry,
  CurvePath,
  CylinderGeometry,
  Group,
  LineCurve3,
  Mesh,
  Object3D,
  QuadraticBezierCurve3,
  Quaternion,
  TubeGeometry,
  Vector3,
} from "three";
import { paint } from "../engine/palette";
import type { Frame } from "../engine/stage";
import { buildMergedMesh, mergeParts } from "./architecture-shared";

/** The pneumatic tubes that carry events to Triage. */
export interface TubeHandle {
  readonly object: Object3D;
  /** Sends a capsule from the first point to the last. Several may ride at once. */
  send(): void;
  /** Advances the capsules. Returns true while one moves. */
  update(frame: Frame): boolean;
  /** How long one capsule takes from the first point to the last: about 1 second per 3 metres. */
  readonly rideSeconds: number;
}

/** How a tube is built. */
export interface TubeOptions {
  /**
   * Stands the tube on slim posts down to y = 0: one under each bend that is
   * clear of the ground, and more along each level run so no two are more
   * than `POST_SPACING` apart. Default false, for a tube that a wall or a
   * ceiling carries.
   */
  readonly posts?: boolean;
}

/** The glass tube's radius. */
const TUBE_RADIUS = 0.042;
/** The radius of a bend, where the polyline turns. */
const BEND_RADIUS = 0.18;
/** The longest gap between two brass collars. */
const COLLAR_SPACING = 0.9;
/** The longest gap between two posts. */
const POST_SPACING = 4;
const UP = new Vector3(0, 1, 0);

/**
 * Builds a tube along `points`, which are in world space: the returned object
 * sits at the origin, so the points stay where they are. The tube runs
 * straight between the points and turns at each one in a bend of radius 0.18,
 * less where a run is too short for it. A capsule takes `rideSeconds` from end
 * to end, easing in and out.
 */
export function buildTubes(points: ReadonlyArray<Vector3>, options: TubeOptions = {}): TubeHandle {
  const object = new Group();
  const corners = points.filter(
    (point, index) => index === 0 || point.distanceTo(points[index - 1]!) > 1e-3,
  );
  if (corners.length < 2) return { object, send() {}, update: () => false, rideSeconds: 0 };

  const path = buildTubePath(corners);
  const glass: BufferGeometry[] = [];
  const collars: BufferGeometry[] = [];
  for (const curve of path.curves) {
    if (curve instanceof LineCurve3) {
      const length = curve.v1.distanceTo(curve.v2);
      if (length < 1e-4) continue;
      glass.push(
        placeAlong(
          new CylinderGeometry(TUBE_RADIUS, TUBE_RADIUS, length, 14, 1, true),
          curve.v1,
          curve.v2,
        ),
      );
      const count = Math.max(1, Math.ceil(length / COLLAR_SPACING));
      for (let index = 0; index <= count; index++) {
        const at = curve.v1.clone().lerp(curve.v2, index / count);
        collars.push(buildCollar(at, curve.v2.clone().sub(curve.v1)));
      }
    } else {
      glass.push(new TubeGeometry(curve, 10, TUBE_RADIUS, 14, false));
    }
  }
  const tube = buildMergedMesh(paint("brass", "glass"), glass, {
    cast: false,
    receive: false,
  });
  if (tube !== null) object.add(tube);

  const iron: BufferGeometry[] = [];
  if (options.posts === true) {
    for (const foot of placePosts(corners)) {
      const height = foot.y - TUBE_RADIUS - 0.012;
      if (height < 0.2) continue;
      iron.push(
        new CylinderGeometry(0.018, 0.024, height, 10).translate(foot.x, height / 2, foot.z),
        new CylinderGeometry(0.06, 0.07, 0.03, 12).translate(foot.x, 0.015, foot.z),
      );
      collars.push(
        new CylinderGeometry(0.03, 0.03, 0.04, 10).translate(foot.x, height - 0.02, foot.z),
      );
    }
  }
  const brass = buildMergedMesh(paint("brass", "brass"), collars, { cast: false });
  if (brass !== null) object.add(brass);
  const posts = buildMergedMesh(paint("room-inlay-2", "satin", { dl: -0.04 }), iron);
  if (posts !== null) object.add(posts);

  const length = path.getLength();
  const rideSeconds = length / 3 + 0.3;
  const capsuleBody = new CylinderGeometry(0.03, 0.03, 0.1, 12);
  const capsuleCaps = mergeParts([
    new CylinderGeometry(0.034, 0.034, 0.02, 12).translate(0, 0.06, 0),
    new CylinderGeometry(0.034, 0.034, 0.02, 12).translate(0, -0.06, 0),
  ])!;
  const riding: Array<{ readonly capsule: Object3D; elapsed: number }> = [];
  const waiting: Object3D[] = [];
  const tangent = new Vector3();
  const turn = new Quaternion();

  return {
    object,
    rideSeconds,
    send() {
      let capsule = waiting.pop();
      if (capsule === undefined) {
        capsule = new Group();
        capsule.add(new Mesh(capsuleBody, paint("room-paper", "paper")));
        capsule.add(new Mesh(capsuleCaps, paint("brass", "brass")));
        object.add(capsule);
      }
      capsule.visible = true;
      riding.push({ capsule, elapsed: 0 });
    },
    update(frame) {
      for (let index = riding.length - 1; index >= 0; index--) {
        const ride = riding[index]!;
        ride.elapsed += frame.dt;
        const progress = Math.min(1, ride.elapsed / rideSeconds);
        const along = 0.5 - 0.5 * Math.cos(progress * Math.PI);
        path.getPointAt(along, ride.capsule.position);
        path.getTangentAt(along, tangent);
        ride.capsule.quaternion.copy(turn.setFromUnitVectors(UP, tangent.normalize()));
        if (progress === 1) {
          ride.capsule.visible = false;
          waiting.push(ride.capsule);
          riding.splice(index, 1);
        }
      }
      return riding.length > 0;
    },
  };
}

/**
 * Returns the tube's centre line: straight runs between the corners, and a
 * quadratic bend at each inner corner, whose radius shrinks to fit the runs
 * on either side.
 */
function buildTubePath(corners: ReadonlyArray<Vector3>): CurvePath<Vector3> {
  const path = new CurvePath<Vector3>();
  let start = corners[0]!.clone();
  for (let index = 1; index < corners.length; index++) {
    const corner = corners[index]!;
    const next = corners[index + 1];
    if (next === undefined) {
      path.add(new LineCurve3(start, corner.clone()));
      break;
    }
    const before = corner.clone().sub(corners[index - 1]!);
    const after = next.clone().sub(corner);
    const radius = Math.min(BEND_RADIUS, before.length() * 0.45, after.length() * 0.45);
    before.normalize();
    after.normalize();
    if (before.dot(after) > 0.999) continue;
    const entry = corner.clone().addScaledVector(before, -radius);
    const exit = corner.clone().addScaledVector(after, radius);
    path.add(new LineCurve3(start, entry));
    path.add(new QuadraticBezierCurve3(entry, corner.clone(), exit));
    start = exit;
  }
  return path;
}

/** Returns a cylinder, built along y, turned and moved to run from `from` to `to`. */
function placeAlong(geometry: BufferGeometry, from: Vector3, to: Vector3): BufferGeometry {
  const direction = to.clone().sub(from).normalize();
  const middle = from.clone().add(to).multiplyScalar(0.5);
  geometry.applyQuaternion(new Quaternion().setFromUnitVectors(UP, direction));
  return geometry.translate(middle.x, middle.y, middle.z);
}

/** Returns a brass collar round the tube at `at`, square to `direction`. */
function buildCollar(at: Vector3, direction: Vector3): BufferGeometry {
  const half = direction.clone().normalize().multiplyScalar(0.012);
  return placeAlong(
    new CylinderGeometry(TUBE_RADIUS + 0.006, TUBE_RADIUS + 0.006, 0.024, 14),
    at.clone().sub(half),
    at.clone().add(half),
  );
}

/**
 * Returns where posts stand under a tube along `corners`: under each corner
 * that is clear of the ground and not on a run that climbs or falls, and
 * along each level run so no two posts are more than `POST_SPACING` apart.
 * Each point is on the tube's centre line.
 */
function placePosts(corners: ReadonlyArray<Vector3>): Vector3[] {
  const feet: Vector3[] = [];
  const addFoot = (point: Vector3) => {
    if (point.y < 0.3) return;
    if (feet.some((foot) => Math.hypot(foot.x - point.x, foot.z - point.z) < 0.6)) return;
    feet.push(point.clone());
  };
  for (let index = 0; index < corners.length - 1; index++) {
    const from = corners[index]!;
    const to = corners[index + 1]!;
    const run = to.clone().sub(from);
    const level = Math.abs(run.y) < 0.3 * run.length();
    if (!level) continue;
    const count = Math.max(1, Math.ceil(run.length() / POST_SPACING));
    // Posts at the run's ends sit a bend's radius in, under the straight tube.
    const inset = Math.min(BEND_RADIUS + 0.1, run.length() * 0.3) / run.length();
    for (let step = 0; step <= count; step++) {
      const share = inset + ((1 - 2 * inset) * step) / count;
      addFoot(from.clone().lerp(to, share));
    }
  }
  return feet;
}
