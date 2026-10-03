/**
 * How the user looks around the office, and which walls drop so
 * the user can see into the rooms.
 *
 * The camera is a target on the floor, a distance, an azimuth and an
 * elevation. Each of the six numbers (the target's x, y, z and the other
 * three) has a goal and moves toward it on a critically damped spring, so
 * every input glides and nothing overshoots. A flight (`flyTo`) drives the
 * numbers along an eased curve instead, and hands its speed back to the
 * springs when the user interrupts it.
 *
 * Input, a Mac trackpad first and a mouse second:
 * - two-finger scroll pans, pinch zooms toward the pointer, a mouse wheel zooms;
 * - left-drag grabs the floor, right-drag or Option-drag orbits;
 * - double-click on the floor glides there.
 *
 * The Office's keys turn the camera, zoom it and find the followed colleague
 * again through `turn`, `zoomStep` and `resumeFollow`: see `office-keys.ts`.
 *
 * While the user asks the system to reduce motion, the camera jumps wherever
 * it would glide or fly, and a wall drops or rises at once.
 */
import {
  Box3,
  Mesh,
  PerspectiveCamera,
  Ray,
  Raycaster,
  Vector2,
  Vector3,
  type Intersection,
  type Object3D,
} from "three";
import { CUTAWAY, type CameraView, type Cutaway } from "./contracts";
import type { Frame } from "./stage";
import { prefersReducedMotion } from "./stillness";
import { readOffice } from "../office-store";

interface CameraRig {
  /** Advances any flight or damping. Returns true while the camera moves. */
  update(frame: Frame): boolean;
  /** Flies to a view. */
  flyTo(view: CameraView): void;
  /** Keeps a moving point in view, or stops following with null. */
  follow(target: (() => Vector3) | null): void;
  /** Limits panning to the office's box. */
  setBounds(bounds: Box3): void;
  /** Turns the camera around the point it looks at by `degrees`: a positive turn is clockwise from above. */
  turn(degrees: number): void;
  /** Zooms one step toward the middle of the view, or one step away from it. */
  zoomStep(direction: "in" | "out"): void;
  /**
   * Follows the colleague the camera followed before the user moved it away,
   * again. Does nothing when the camera follows no one.
   */
  resumeFollow(): void;
  /**
   * Finds every wall under `root` that can be cut away (a `Cutaway` in its
   * `userData`), so the camera can lower the walls between it and what the
   * user looks at. Called after every rebuild of the office.
   */
  trackWalls(root: Object3D): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Tuning.

/** The closest the user can zoom, in metres from the target. */
const MIN_DISTANCE = 3;
/** How far past the overview the user can zoom out, as a factor of its distance. */
const MAX_DISTANCE_FACTOR = 1.3;
/** The distance one zoom step in multiplies the camera's distance by. A step out divides by it. */
const KEY_ZOOM_STEP = 0.78;
/** The lowest and highest elevation an orbit reaches, in degrees. */
const MIN_ELEVATION = 18;
const MAX_ELEVATION = 72;
/** How far a press may travel, in CSS pixels, and still count as a click. The director uses the same. */
const DRAG_SLOP = 5;
/** Below this distance only the walls in front of the target drop; above it every interior wall does. */
const CLOSE_UP_DISTANCE = 16;
/** The time a wall takes to drop to the dado rail or rise again, in seconds. */
const WALL_SECONDS = 0.25;
/**
 * How far the camera must be on a wall's outward side, in metres, before the
 * wall drops, and how far on its inner side before it rises again. The gap
 * keeps a wall seen edge-on from flickering during an orbit.
 */
const WALL_DEADBAND = 0.4;

/**
 * The springs' stiffness: the angular frequency of a critically damped
 * spring, per second. A spring covers about 95% of its way in 4.7 / omega
 * seconds, so 11 settles in about 0.4 s.
 */
const OMEGA_GLIDE = 11;
/** Stiffer while the user grabs the floor, so the floor stays under the pointer. */
const OMEGA_GRAB = 32;
/** Stiffer while the user orbits, so the turn follows the hand. */
const OMEGA_ORBIT = 20;
/** Softer while following a walking colleague, so the camera does not jerk with each step. */
const OMEGA_FOLLOW = 5;

/** A wheel event this long after the previous one starts a new gesture, which is classified again. */
const WHEEL_GESTURE_GAP_MS = 260;

// ---------------------------------------------------------------------------
// Placing the camera.

/** A camera view the rig changes in place, for the overlay to read. */
interface LiveView {
  target: Vector3;
  distance: number;
  azimuth: number;
  elevation: number;
}

/** The last view `placeCamera` set on each camera, so a rig can start from it. */
const placedViews = new WeakMap<PerspectiveCamera, CameraView>();
/** The view each camera shows now, as its rig last placed it. */
const liveViews = new WeakMap<PerspectiveCamera, LiveView>();
/** The cameras whose rig moved them in its last update. */
const movingCameras = new WeakSet<PerspectiveCamera>();

const convertToRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Moves `camera` to look at `target` from a distance and two angles in degrees. */
function aimCamera(
  camera: PerspectiveCamera,
  target: Vector3,
  distance: number,
  azimuth: number,
  elevation: number,
): void {
  const a = convertToRadians(azimuth);
  const e = convertToRadians(elevation);
  camera.position.set(
    target.x + distance * Math.cos(e) * Math.sin(a),
    target.y + distance * Math.sin(e),
    target.z + distance * Math.cos(e) * Math.cos(a),
  );
  camera.lookAt(target);
}

/** Places the camera at a view at once. A rig on the same camera starts its next move from there. */
export function placeCamera(camera: PerspectiveCamera, view: CameraView): void {
  aimCamera(camera, view.target, view.distance, view.azimuth, view.elevation);
  placedViews.set(camera, view);
  const live = liveViews.get(camera);
  if (live === undefined) {
    liveViews.set(camera, {
      target: view.target.clone(),
      distance: view.distance,
      azimuth: view.azimuth,
      elevation: view.elevation,
    });
  } else {
    live.target.copy(view.target);
    live.distance = view.distance;
    live.azimuth = view.azimuth;
    live.elevation = view.elevation;
  }
}

/**
 * Returns the view `camera` shows now, as its rig or `placeCamera` last set
 * it, or null when neither has touched the camera. The returned object
 * changes in place as the camera moves.
 */
export function readCameraView(camera: PerspectiveCamera): CameraView | null {
  return liveViews.get(camera) ?? null;
}

/**
 * Returns true while `camera`'s rig moves it: in a flight, gliding, or
 * following a colleague. Returns false for a camera at rest or with no rig.
 */
export function isCameraMoving(camera: PerspectiveCamera): boolean {
  return movingCameras.has(camera);
}

// ---------------------------------------------------------------------------
// Springs.

/** One number of the camera, moving toward its goal. */
interface Spring {
  value: number;
  velocity: number;
  goal: number;
  /** Below this offset and a tenth of it per second, the spring snaps to its goal and rests. */
  readonly epsilon: number;
}

const createSpring = (value: number, epsilon: number): Spring => ({
  value,
  velocity: 0,
  goal: value,
  epsilon,
});

/**
 * Advances a critically damped spring by `dt` seconds with the exact
 * solution, which stays stable at any frame rate. Returns true while the
 * spring still moves; a spring close enough to its goal snaps there.
 */
function stepSpring(spring: Spring, omega: number, dt: number): boolean {
  const offset = spring.value - spring.goal;
  if (Math.abs(offset) < spring.epsilon && Math.abs(spring.velocity) < spring.epsilon * 10) {
    spring.value = spring.goal;
    spring.velocity = 0;
    return false;
  }
  const decay = Math.exp(-omega * dt);
  const slope = spring.velocity + omega * offset;
  spring.value = spring.goal + (offset + slope * dt) * decay;
  spring.velocity = (slope - omega * (offset + slope * dt)) * decay;
  return true;
}

/**
 * Stops a spring's flight-driven motion gracefully: moves its goal to where
 * its current speed would carry it, so it slows to a stop instead of
 * stopping dead or bouncing back.
 */
function coastSpring(spring: Spring, omega: number): void {
  spring.goal = spring.value + spring.velocity / omega;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** Eases a fraction in and out: slow at both ends, fastest in the middle. */
const easeInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/** Returns the turn from one azimuth to another the short way round, in degrees. */
const measureShortestTurn = (from: number, to: number): number => {
  const turn = ((((to - from) % 360) + 540) % 360) - 180;
  return turn === -180 ? 180 : turn;
};

// ---------------------------------------------------------------------------
// Walls.

/** A wall the camera can lower, with what the camera needs to decide. */
interface TrackedWall {
  readonly object: Object3D;
  readonly cutaway: Cutaway;
  /** The wall's centre in world space. */
  readonly centre: Vector3;
  /** The wall's outward normal in world space, flattened onto the floor. */
  readonly normal: Vector3;
  /** The two ends of the wall's middle line seen from above, as world x and z. */
  readonly ends: readonly [number, number, number, number];
  /** The cut the wall moves toward: 0 standing, 1 down to the dado rail. */
  goal: number;
  /** How far the wall has moved toward a cut, before easing, from 0 to 1. */
  progress: number;
  /** The amount last passed to `setCut`. */
  shown: number;
}

/** The walls each camera's rig tracks, for `isHiddenByWall`. */
const trackedWalls = new WeakMap<PerspectiveCamera, ReadonlyArray<TrackedWall>>();

/** Builds the record of a wall the camera can lower, from its object in an up-to-date scene. */
function buildTrackedWall(object: Object3D, cutaway: Cutaway): TrackedWall {
  const box = new Box3().setFromObject(object);
  const centre = box.getCenter(new Vector3());
  const size = box.getSize(new Vector3());
  // The wall runs along its local x; its length is the box's extent along that line.
  const along = new Vector3(1, 0, 0).transformDirection(object.matrixWorld).setY(0).normalize();
  const half = (Math.abs(along.x) * size.x + Math.abs(along.z) * size.z) / 2;
  return {
    object,
    cutaway,
    centre,
    normal: object.getWorldDirection(new Vector3()).setY(0).normalize(),
    ends: [
      centre.x - along.x * half,
      centre.z - along.z * half,
      centre.x + along.x * half,
      centre.z + along.z * half,
    ],
    goal: 0,
    progress: 0,
    shown: 0,
  };
}

/** Returns true when an object and every one of its ancestors is visible. */
export function isShown(object: Object3D): boolean {
  for (let node: Object3D | null = object; node !== null; node = node.parent) {
    if (!node.visible) return false;
  }
  return true;
}

const sightRay = new Raycaster();
const sightHits: Intersection[] = [];
const sightDirection = new Vector3();

/** Returns true when `sightRay` meets a shown mesh of `object` or of its descendants. */
function isOnSightRay(object: Object3D): boolean {
  if (!object.visible) return false;
  if (object instanceof Mesh) {
    object.raycast(sightRay, sightHits);
    const hit = sightHits.length > 0;
    // A hit holds the mesh it hit, and through it the whole office, so the
    // list is emptied at once rather than kept until the next ray.
    sightHits.length = 0;
    if (hit) return true;
  }
  return object.children.some(isOnSightRay);
}

/**
 * Returns true when a wall the camera's rig tracks hides `point` from
 * `camera`: the straight line between them passes through the wall. The line
 * passes through a doorway, over a wall lowered to the dado rail, and through
 * a wall that is not shown, such as one on a storey the built office hides.
 * Returns false for a camera without a rig.
 *
 * The test uses each wall's world matrices as of the last drawn frame, so
 * while a wall drops it lags by one frame; the tags fade, which hides that.
 */
export function isHiddenByWall(camera: PerspectiveCamera, point: Vector3): boolean {
  const walls = trackedWalls.get(camera);
  if (walls === undefined) return false;
  const eye = camera.position;
  const rx = point.x - eye.x;
  const rz = point.z - eye.z;
  let isAimed = false;
  for (const wall of walls) {
    // A wall lowered all the way stands below every head.
    if (wall.shown > 0.99) continue;
    // A cheap test first, seen from above: does the line cross the wall's middle line?
    const [ax, az, bx, bz] = wall.ends;
    const sx = bx - ax;
    const sz = bz - az;
    const across = rx * sz - rz * sx;
    if (Math.abs(across) < 1e-9) continue;
    const qx = ax - eye.x;
    const qz = az - eye.z;
    // t runs along the line, from the eye at 0 to the point at 1; u runs along the wall.
    const t = (qx * sz - qz * sx) / across;
    const u = (qx * rz - qz * rx) / across;
    if (t <= 0 || t >= 1 || u < 0 || u > 1 || !isShown(wall.object)) continue;
    // Then the exact test against the wall's meshes, which knows its doorways and its height.
    if (!isAimed) {
      sightRay.set(eye, sightDirection.subVectors(point, eye).normalize());
      sightRay.far = eye.distanceTo(point);
      isAimed = true;
    }
    if (isOnSightRay(wall.object)) return true;
  }
  return false;
}

/** A flight from one view to another. */
interface Flight {
  readonly from: {
    readonly target: Vector3;
    readonly distance: number;
    readonly azimuth: number;
    readonly elevation: number;
  };
  readonly to: CameraView;
  /** The azimuth turn, the short way round. */
  readonly turn: number;
  readonly duration: number;
  /** How much the distance swells in the middle of a long flight, as a fraction. */
  readonly rise: number;
  elapsed: number;
}

/** What the user's pointer is doing. */
interface Drag {
  readonly kind: "pan" | "orbit";
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  lastX: number;
  lastY: number;
  /** True once the pointer has travelled past the slop, so the press is a drag and not a click. */
  active: boolean;
  /** The floor point the user grabbed, for a pan. */
  readonly grabbed: Vector3;
  /** The last few pointer positions with their times, to throw the floor on release. */
  readonly trail: Array<{ readonly x: number; readonly y: number; readonly time: number }>;
}

/**
 * Returns true when a wheel event comes from a mouse wheel rather than a
 * trackpad. A trackpad sends pixel deltas, small at the start of a gesture
 * and often with some sideways motion; a mouse wheel sends lines, or whole
 * notches of 120 in `wheelDeltaY` (Chromium) or multiples of 4.000244 (Safari
 * and Firefox on macOS).
 */
function isMouseWheel(event: WheelEvent): boolean {
  if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return true;
  if (event.deltaX !== 0 || event.deltaY === 0) return false;
  const notch = (event as WheelEvent & { readonly wheelDeltaY?: number }).wheelDeltaY ?? 0;
  if (notch !== 0 && Math.abs(notch) >= 120 && notch % 120 === 0) return true;
  return event.deltaY % 4.000244140625 === 0;
}

/** Returns a wheel event's vertical delta in CSS pixels, whatever unit it came in. */
function readWheelPixels(event: WheelEvent): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 33;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * 600;
  return event.deltaY;
}

/**
 * Creates the camera rig: listens to the pointer, the wheel and the keys on
 * `element` (the canvas), and moves `camera`. `requestRender` asks the stage
 * for a frame after an input; the rig's `update` keeps frames coming while
 * anything moves, and stops asking once everything rests.
 */
export function createCameraRig(
  camera: PerspectiveCamera,
  element: HTMLElement,
  requestRender: () => void,
): CameraRig {
  const targetX = createSpring(0, 0.0005);
  const targetY = createSpring(0, 0.0005);
  const targetZ = createSpring(0, 0.0005);
  const distance = createSpring(20, 0.001);
  const azimuth = createSpring(45, 0.004);
  const elevation = createSpring(40, 0.004);
  const springs = [targetX, targetY, targetZ, distance, azimuth, elevation];

  const live: LiveView = liveViews.get(camera) ?? {
    target: new Vector3(),
    distance: distance.value,
    azimuth: azimuth.value,
    elevation: elevation.value,
  };
  liveViews.set(camera, live);

  let adoptedView: CameraView | null = null;
  let flight: Flight | null = null;
  let followed: (() => Vector3) | null = null;
  /** The follow a pan interrupted, which F resumes. */
  let pausedFollow: (() => Vector3) | null = null;
  let drag: Drag | null = null;
  let bounds: Box3 | null = null;
  let maxDistance = Infinity;
  /** The overview's distance as far as the rig can tell: the box's fit, or the farthest flight. */
  let farthestView = 0;
  let wheelKind: "mouse" | "trackpad" = "trackpad";
  let lastWheelAt = -Infinity;

  let walls: TrackedWall[] = [];
  const animatingWalls = new Set<TrackedWall>();
  /** Set when the walls must be decided again even though the camera has not moved. */
  let wallsStale = false;
  /** Set after `trackWalls`, so the first decision places the walls without animating them. */
  let snapWalls = false;
  const decidedFrom = new Vector3(Infinity, 0, 0);
  const decidedTarget = new Vector3();

  const goalCamera = new PerspectiveCamera();
  const ray = new Ray();
  const pointer = new Vector2();
  const scratch = new Vector3();
  const scratch2 = new Vector3();
  const target = new Vector3();
  const hit = new Vector3();

  // -------------------------------------------------------------------------
  // State.

  /** Takes over a view that `placeCamera` set since the rig last looked, so the next move starts there. */
  const adoptPlacedView = (): void => {
    const placed = placedViews.get(camera);
    if (placed === undefined || placed === adoptedView) return;
    adoptedView = placed;
    flight = null;
    const values = [
      placed.target.x,
      placed.target.y,
      placed.target.z,
      placed.distance,
      placed.azimuth,
      placed.elevation,
    ];
    springs.forEach((spring, index) => {
      spring.value = spring.goal = values[index]!;
      spring.velocity = 0;
    });
    applyState();
  };

  /** Moves the camera to the springs' current values, and records the view for the overlay. */
  const applyState = (): void => {
    target.set(targetX.value, targetY.value, targetZ.value);
    aimCamera(camera, target, distance.value, azimuth.value, elevation.value);
    live.target.copy(target);
    live.distance = distance.value;
    live.azimuth = azimuth.value;
    live.elevation = elevation.value;
  };

  /** Points the scratch camera at the goals, where the camera will come to rest. */
  const aimGoalCamera = (): void => {
    goalCamera.fov = camera.fov;
    goalCamera.aspect = camera.aspect;
    goalCamera.near = camera.near;
    goalCamera.far = camera.far;
    goalCamera.updateProjectionMatrix();
    scratch.set(targetX.goal, targetY.goal, targetZ.goal);
    aimCamera(goalCamera, scratch, distance.goal, azimuth.goal, elevation.goal);
    goalCamera.updateMatrixWorld();
  };

  /**
   * Returns, in `out`, the point of the target's floor plane under a point of
   * the canvas, as the camera will see it once it rests. A ray close to the
   * horizon is tipped down a little, so a point near the top of the canvas
   * does not throw the floor to the far distance.
   */
  const findFloorPoint = (
    rect: DOMRect,
    clientX: number,
    clientY: number,
    out: Vector3,
  ): Vector3 => {
    aimGoalCamera();
    pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    ray.origin.copy(goalCamera.position);
    ray.direction.set(pointer.x, pointer.y, 0.5).unproject(goalCamera).sub(ray.origin).normalize();
    const minDrop = 0.12;
    if (ray.direction.y > -minDrop) {
      const across = Math.hypot(ray.direction.x, ray.direction.z);
      const scale = Math.sqrt(1 - minDrop * minDrop) / across;
      ray.direction.set(ray.direction.x * scale, -minDrop, ray.direction.z * scale);
    }
    const along = (targetY.goal - ray.origin.y) / ray.direction.y;
    return out.copy(ray.origin).addScaledVector(ray.direction, along);
  };

  /** Keeps the target's goal inside the office's box. */
  const clampTargetGoal = (): void => {
    if (bounds === null) return;
    targetX.goal = clamp(targetX.goal, bounds.min.x, bounds.max.x);
    targetZ.goal = clamp(targetZ.goal, bounds.min.z, bounds.max.z);
  };

  /** Recomputes the farthest the user may zoom out from the box and the farthest flight seen. */
  const updateMaxDistance = (): void => {
    if (bounds === null) return;
    const size = bounds.getSize(scratch);
    const radius = Math.hypot(size.x, size.y, size.z) / 2;
    const fit = (0.8 * radius) / Math.tan(convertToRadians(camera.fov / 2));
    maxDistance = MAX_DISTANCE_FACTOR * Math.max(fit, farthestView, MIN_DISTANCE);
  };

  /** Ends a flight where it is now, letting the springs carry its speed to a gentle stop. */
  const interrupt = (): void => {
    if (flight === null) return;
    flight = null;
    for (const spring of springs) coastSpring(spring, OMEGA_GLIDE);
  };

  /** Stops following, as a pan does, and remembers the follow so F can resume it. */
  const pauseFollow = (): void => {
    if (followed === null) return;
    pausedFollow = followed;
    followed = null;
  };

  /** Zooms by `factor` (above 1 moves away), keeping the floor point under a canvas point where it is. */
  const zoomAt = (rect: DOMRect, clientX: number, clientY: number, factor: number): void => {
    // While following, the zoom centres on the colleague, so the follow and the zoom agree.
    const x = followed === null ? clientX : rect.left + rect.width / 2;
    const y = followed === null ? clientY : rect.top + rect.height / 2;
    const before = findFloorPoint(rect, x, y, scratch2).clone();
    const goal = distance.goal * factor;
    distance.goal =
      factor < 1
        ? Math.max(goal, Math.min(MIN_DISTANCE, distance.goal))
        : Math.min(goal, Math.max(maxDistance, distance.goal));
    if (followed !== null) return;
    const after = findFloorPoint(rect, x, y, scratch2);
    targetX.goal += before.x - after.x;
    targetZ.goal += before.z - after.z;
    clampTargetGoal();
  };

  /** Pans so the floor moves by a canvas offset, measured at the canvas's centre. */
  const panByPixels = (rect: DOMRect, dx: number, dy: number): void => {
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const from = findFloorPoint(rect, cx, cy, scratch2).clone();
    const to = findFloorPoint(rect, cx + dx, cy + dy, scratch2);
    targetX.goal += to.x - from.x;
    targetZ.goal += to.z - from.z;
    clampTargetGoal();
  };

  /**
   * Turns the goal azimuth by `degrees`, and tilts the goal elevation within
   * its limits. A built office's view may sit outside the limits (the tower's
   * overview looks up from a low angle); a tilt from there never moves
   * further out, and never jumps.
   */
  const orbitBy = (degrees: number, tilt: number): void => {
    azimuth.goal += degrees;
    elevation.goal = clamp(
      elevation.goal + tilt,
      Math.min(MIN_ELEVATION, elevation.goal),
      Math.max(MAX_ELEVATION, elevation.goal),
    );
  };

  // -------------------------------------------------------------------------
  // Input.

  const onWheel = (event: WheelEvent): void => {
    // Without this, Chromium zooms the whole page on a pinch.
    event.preventDefault();
    interrupt();
    if (event.timeStamp - lastWheelAt > WHEEL_GESTURE_GAP_MS) {
      wheelKind = isMouseWheel(event) ? "mouse" : "trackpad";
    }
    lastWheelAt = event.timeStamp;
    const rect = element.getBoundingClientRect();
    if (event.ctrlKey) {
      // A pinch: Chromium sends it as a wheel event with ctrlKey held.
      zoomAt(rect, event.clientX, event.clientY, Math.exp(clamp(event.deltaY, -50, 50) * 0.011));
    } else if (wheelKind === "mouse") {
      zoomAt(
        rect,
        event.clientX,
        event.clientY,
        Math.exp(clamp(readWheelPixels(event), -240, 240) * 0.0016),
      );
    } else {
      pauseFollow();
      panByPixels(rect, event.deltaX, event.deltaY);
    }
    requestRender();
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (drag !== null) return;
    const kind =
      event.button === 2 || (event.button === 0 && event.altKey)
        ? "orbit"
        : event.button === 0
          ? "pan"
          : null;
    if (kind === null) return;
    drag = {
      kind,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      active: false,
      grabbed: new Vector3(),
      trail: [],
    };
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    const rect = element.getBoundingClientRect();
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) <= DRAG_SLOP) return;
      drag.active = true;
      interrupt();
      try {
        element.setPointerCapture(event.pointerId);
      } catch {
        // A synthetic event, as the lab's scripts send, has no live pointer to capture.
      }
      if (drag.kind === "pan") {
        pauseFollow();
        findFloorPoint(rect, event.clientX, event.clientY, drag.grabbed);
      }
    } else if (drag.kind === "pan") {
      findFloorPoint(rect, event.clientX, event.clientY, scratch2);
      targetX.goal += drag.grabbed.x - scratch2.x;
      targetZ.goal += drag.grabbed.z - scratch2.z;
      clampTargetGoal();
    } else {
      orbitBy(-(event.clientX - drag.lastX) * 0.32, (event.clientY - drag.lastY) * 0.22);
    }
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    drag.trail.push({ x: event.clientX, y: event.clientY, time: event.timeStamp });
    if (drag.trail.length > 6) drag.trail.shift();
    requestRender();
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    const ended = drag;
    drag = null;
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    if (!ended.active || ended.kind !== "pan") return;
    // A quick release throws the floor a little further, as a map does.
    const first = ended.trail.find((sample) => event.timeStamp - sample.time < 80);
    if (first === undefined || event.timeStamp - first.time < 8) return;
    const seconds = (event.timeStamp - first.time) / 1000;
    const vx = (event.clientX - first.x) / seconds;
    const vy = (event.clientY - first.y) / seconds;
    if (Math.hypot(vx, vy) < 250) return;
    panByPixels(element.getBoundingClientRect(), -vx * 0.11, -vy * 0.11);
    requestRender();
  };

  const onDoubleClick = (event: MouseEvent): void => {
    // A double-click on a colleague is the director's: it selects.
    if (readOffice().hoveredId !== null) return;
    const point = findFloorPoint(
      element.getBoundingClientRect(),
      event.clientX,
      event.clientY,
      hit,
    );
    // A double-click beside the office glides to the office's nearest edge, not into the void.
    if (bounds !== null) {
      point.x = clamp(point.x, bounds.min.x, bounds.max.x);
      point.z = clamp(point.z, bounds.min.z, bounds.max.z);
    }
    pauseFollow();
    flyTo({
      target: new Vector3(point.x, targetY.goal, point.z),
      distance: Math.max(MIN_DISTANCE, distance.goal * 0.72),
      azimuth: azimuth.goal,
      elevation: elevation.goal,
    });
  };

  const onContextMenu = (event: Event): void => event.preventDefault();

  element.addEventListener("wheel", onWheel, { passive: false });
  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", onPointerUp);
  element.addEventListener("pointercancel", onPointerUp);
  element.addEventListener("dblclick", onDoubleClick);
  element.addEventListener("contextmenu", onContextMenu);

  /** Moves every spring to its goal at once. */
  function settleSprings(): void {
    for (const spring of springs) {
      spring.value = spring.goal;
      spring.velocity = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Flights.

  function flyTo(view: CameraView): void {
    adoptPlacedView();
    farthestView = Math.max(farthestView, view.distance);
    updateMaxDistance();
    if (flight !== null && flight.to === view) return;
    const turn = measureShortestTurn(azimuth.value, view.azimuth);
    const from = {
      target: new Vector3(targetX.value, targetY.value, targetZ.value),
      distance: distance.value,
      azimuth: azimuth.value,
      elevation: elevation.value,
    };
    const longest = Math.max(from.distance, view.distance);
    const travel =
      Math.hypot(view.target.x - from.target.x, view.target.z - from.target.z) / longest;
    const zoom = Math.abs(Math.log(view.distance / from.distance));
    const effort =
      travel +
      zoom +
      Math.abs(turn) / 120 +
      Math.abs(view.elevation - from.elevation) / 60 +
      Math.abs(view.target.y - from.target.y) / longest;
    const jump = prefersReducedMotion();
    if (effort < 0.002 || jump) {
      // Already there, or asked to jump: nothing to animate.
      flight = null;
      targetX.goal = view.target.x;
      targetY.goal = view.target.y;
      targetZ.goal = view.target.z;
      distance.goal = view.distance;
      azimuth.goal = azimuth.value + turn;
      elevation.goal = view.elevation;
      if (jump) settleSprings();
      if (effort > 0) requestRender();
      return;
    }
    flight = {
      from,
      to: view,
      turn,
      duration: 0.7 + 0.4 * Math.min(1, effort / 1.6),
      rise: clamp((travel - 0.45) * 0.3, 0, 0.22),
      elapsed: 0,
    };
    requestRender();
  }

  /** Advances the flight by `dt` and drives the springs' values along it. */
  const stepFlight = (current: Flight, dt: number): void => {
    current.elapsed += dt;
    const t = Math.min(1, current.elapsed / current.duration);
    const eased = easeInOut(t);
    const { from, to } = current;
    // A followed colleague may walk during the flight, so the flight lands where it is now.
    let endX = to.target.x;
    let endZ = to.target.z;
    if (followed !== null) {
      const point = followed();
      endX = point.x;
      endZ = point.z;
    }
    const values = [
      from.target.x + (endX - from.target.x) * eased,
      from.target.y + (to.target.y - from.target.y) * eased,
      from.target.z + (endZ - from.target.z) * eased,
      Math.exp(Math.log(from.distance) + Math.log(to.distance / from.distance) * eased) *
        (1 + current.rise * Math.sin(Math.PI * eased)),
      from.azimuth + current.turn * eased,
      from.elevation + (to.elevation - from.elevation) * eased,
    ];
    springs.forEach((spring, index) => {
      const value = values[index]!;
      spring.velocity = t < 1 && dt > 0 ? (value - spring.value) / dt : 0;
      spring.value = spring.goal = value;
    });
    if (t >= 1) flight = null;
  };

  // -------------------------------------------------------------------------
  // Walls.

  /**
   * Decides each wall's cut from where the camera is and what it looks at.
   *
   * - From afar, every interior wall drops: an interior wall hides a room
   *   from either side, so the user sees into every room. An exterior wall
   *   drops when its outward side faces the camera, so the far walls stand
   *   as a backdrop.
   * - Close up, or while following, a wall drops when the camera and the
   *   target are on opposite sides of it. The walls in front of the room the
   *   user looks at drop, and the walls behind it stand with what hangs on
   *   them.
   *
   * A wall already cut needs a clear margin to rise again, so a wall seen
   * edge-on does not flicker during an orbit.
   *
   * Under Reduce motion a wall takes its new height at once instead of
   * moving there over a quarter of a second.
   */
  const decideWalls = (): void => {
    const eye = camera.position;
    const close = followed !== null || distance.value < CLOSE_UP_DISTANCE;
    const snap = snapWalls || prefersReducedMotion();
    for (const wall of walls) {
      const band = wall.goal > 0.5 ? -WALL_DEADBAND : WALL_DEADBAND;
      const eyeSide =
        (eye.x - wall.centre.x) * wall.normal.x + (eye.z - wall.centre.z) * wall.normal.z;
      let cut: boolean;
      if (close) {
        const targetSide =
          (target.x - wall.centre.x) * wall.normal.x + (target.z - wall.centre.z) * wall.normal.z;
        cut =
          (eyeSide > band && targetSide < -band / 2) || (eyeSide < -band && targetSide > band / 2);
      } else {
        cut = !wall.cutaway.exterior || eyeSide > band;
      }
      const goal = cut ? 1 : 0;
      if (snap) {
        wall.goal = wall.progress = goal;
        setWallCut(wall, goal);
        animatingWalls.delete(wall);
      } else if (goal !== wall.goal) {
        wall.goal = goal;
        animatingWalls.add(wall);
      }
    }
    snapWalls = false;
  };

  /** Calls the wall's `setCut` when the amount differs from the last one passed. */
  const setWallCut = (wall: TrackedWall, amount: number): void => {
    if (amount === wall.shown) return;
    wall.shown = amount;
    wall.cutaway.setCut(amount);
  };

  /** Moves every animating wall toward its goal. Returns true while one still moves. */
  const animateWalls = (dt: number): boolean => {
    for (const wall of animatingWalls) {
      const step = dt / WALL_SECONDS;
      wall.progress =
        wall.goal > wall.progress
          ? Math.min(wall.goal, wall.progress + step)
          : Math.max(wall.goal, wall.progress - step);
      const p = wall.progress;
      setWallCut(wall, p * p * (3 - 2 * p));
      if (p === wall.goal) animatingWalls.delete(wall);
    }
    return animatingWalls.size > 0;
  };

  // -------------------------------------------------------------------------
  // The rig.

  return {
    update(frame) {
      adoptPlacedView();
      let moving = false;
      if (flight !== null) {
        stepFlight(flight, frame.dt);
        moving = true;
      } else {
        if (prefersReducedMotion()) settleSprings();
        if (followed !== null) {
          const point = followed();
          targetX.goal = point.x;
          targetZ.goal = point.z;
        }
        const grabbing = drag !== null && drag.active && drag.kind === "pan";
        const orbiting = drag !== null && drag.active && drag.kind === "orbit";
        const targetOmega = grabbing ? OMEGA_GRAB : followed !== null ? OMEGA_FOLLOW : OMEGA_GLIDE;
        const angleOmega = orbiting ? OMEGA_ORBIT : OMEGA_GLIDE;
        moving = stepSpring(targetX, targetOmega, frame.dt) || moving;
        moving = stepSpring(targetY, targetOmega, frame.dt) || moving;
        moving = stepSpring(targetZ, targetOmega, frame.dt) || moving;
        moving = stepSpring(distance, OMEGA_GLIDE, frame.dt) || moving;
        moving = stepSpring(azimuth, angleOmega, frame.dt) || moving;
        moving = stepSpring(elevation, angleOmega, frame.dt) || moving;
      }
      applyState();
      if (moving) movingCameras.add(camera);
      else movingCameras.delete(camera);
      if (
        walls.length > 0 &&
        (wallsStale ||
          decidedFrom.distanceToSquared(camera.position) > 1e-6 ||
          decidedTarget.distanceToSquared(target) > 1e-6)
      ) {
        decidedFrom.copy(camera.position);
        decidedTarget.copy(target);
        wallsStale = false;
        decideWalls();
      }
      return animateWalls(frame.dt) || moving;
    },
    flyTo,
    follow(next) {
      followed = next;
      pausedFollow = null;
      wallsStale = true;
      if (next !== null) requestRender();
    },
    setBounds(next) {
      bounds = next.clone();
      farthestView = 0;
      updateMaxDistance();
    },
    turn(degrees) {
      interrupt();
      orbitBy(degrees, 0);
      requestRender();
    },
    zoomStep(direction) {
      const rect = element.getBoundingClientRect();
      interrupt();
      zoomAt(
        rect,
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
        direction === "in" ? KEY_ZOOM_STEP : 1 / KEY_ZOOM_STEP,
      );
      requestRender();
    },
    resumeFollow() {
      if (pausedFollow === null) return;
      interrupt();
      followed = pausedFollow;
      pausedFollow = null;
      requestRender();
    },
    trackWalls(root) {
      root.updateWorldMatrix(true, true);
      walls = [];
      animatingWalls.clear();
      root.traverse((object) => {
        const cutaway = object.userData[CUTAWAY] as Cutaway | undefined;
        if (cutaway !== undefined) walls.push(buildTrackedWall(object, cutaway));
      });
      trackedWalls.set(camera, walls);
      wallsStale = true;
      snapWalls = true;
      requestRender();
    },
    dispose() {
      trackedWalls.delete(camera);
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", onPointerUp);
      element.removeEventListener("pointercancel", onPointerUp);
      element.removeEventListener("dblclick", onDoubleClick);
      element.removeEventListener("contextmenu", onContextMenu);
    },
  };
}
