/**
 * Finds the colleague under the pointer, generously.
 *
 * A colleague is small on screen from afar, so the picker does not cast a
 * ray against the body's triangles. It projects each colleague's feet and
 * head onto the screen and measures how far the pointer is from the line
 * between them:
 * - a pointer on the body hits, and the colleague nearest the camera wins;
 * - otherwise a pointer within `SLACK_PIXELS` of a body hits, and the closest
 *   body on screen wins.
 *
 * A colleague hidden behind a wall cannot be picked: the pointer picks what
 * the user sees.
 *
 * A name tag sits over its colleague and is part of it: a pointer over a tag
 * picks the tag's colleague first. The tags let pointer events through to
 * the canvas, so the director's hover and click handlers see them; the
 * overlay tells the picker where its tags are with `registerTagHitTest`.
 */
import { Vector3, type PerspectiveCamera } from "three";
import { isHiddenByWall, isShown } from "./camera-rig";
import type { ColleagueRig } from "./contracts";

/** The key under which a rig's root object stores its colleague's id. */
const COLLEAGUE_ID = "colleagueId";

export interface Picker {
  /** Returns the id of the colleague drawn at a point of the canvas, or null. */
  pick(clientX: number, clientY: number): string | null;
}

/** How far outside a body, in CSS pixels, the pointer still picks it. */
const SLACK_PIXELS = 14;
/** Half a body's width, in metres, as the picker measures it on screen. */
const BODY_RADIUS = 0.26;

/** A function that returns the colleague whose name tag lies under a point of the page, or null. */
type TagHitTest = (clientX: number, clientY: number) => string | null;

/** The tag hit test of the overlay drawn over each set of rigs. */
const tagHitTests = new WeakMap<ReadonlyMap<string, ColleagueRig>, TagHitTest>();

/**
 * Registers how to find a name tag under the pointer for the overlay drawn
 * over `rigs`, or removes it with null. A picker over the same `rigs` map
 * asks the test before it looks at the bodies.
 */
export function registerTagHitTest(
  rigs: ReadonlyMap<string, ColleagueRig>,
  test: TagHitTest | null,
): void {
  if (test === null) tagHitTests.delete(rigs);
  else tagHitTests.set(rigs, test);
}

const crown = new Vector3();
const middle = new Vector3();

/**
 * Returns true when walls hide a colleague from the camera: both the top of
 * the head and the middle of the body. A colleague seen through a doorway,
 * or with only the head showing over a wall, is not hidden.
 */
export function isColleagueHidden(camera: PerspectiveCamera, rig: ColleagueRig): boolean {
  rig.object.getWorldPosition(crown);
  middle.copy(crown);
  crown.y += rig.headHeight;
  middle.y += rig.headHeight / 2;
  return isHiddenByWall(camera, crown) && isHiddenByWall(camera, middle);
}

/** Returns the distance from a point to the segment between two points, all on screen. */
function measureDistanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Creates a picker for the colleagues in `rigs`, drawn on `canvas` by
 * `camera`. Marks each rig's root with its colleague's id under
 * `COLLEAGUE_ID`, for code that finds a colleague from a raycast hit.
 */
export function createPicker(
  canvas: HTMLCanvasElement,
  camera: PerspectiveCamera,
  rigs: ReadonlyMap<string, ColleagueRig>,
): Picker {
  for (const [id, rig] of rigs) rig.object.userData[COLLEAGUE_ID] = id;
  const feet = new Vector3();
  const head = new Vector3();
  return {
    pick(clientX, clientY) {
      const fromTag = tagHitTests.get(rigs)?.(clientX, clientY) ?? null;
      if (fromTag !== null) return fromTag;
      const box = canvas.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return null;
      camera.updateMatrixWorld();
      const pixelsPerUnit = box.height / (2 * Math.tan((camera.fov * Math.PI) / 360));
      let bodyId: string | null = null;
      let bodyDepth = Infinity;
      let nearId: string | null = null;
      let nearGap = Infinity;
      for (const [id, rig] of rigs) {
        if (!isShown(rig.object)) continue;
        rig.object.getWorldPosition(feet);
        const depth = feet.distanceTo(camera.position);
        head.copy(feet);
        head.y += rig.headHeight;
        feet.y += 0.04;
        feet.project(camera);
        head.project(camera);
        if (feet.z >= 1 || head.z >= 1) continue;
        const gap = measureDistanceToSegment(
          clientX - box.left,
          clientY - box.top,
          ((feet.x + 1) / 2) * box.width,
          ((1 - feet.y) / 2) * box.height,
          ((head.x + 1) / 2) * box.width,
          ((1 - head.y) / 2) * box.height,
        );
        const radius = (BODY_RADIUS * pixelsPerUnit) / depth;
        const isBodyHit = gap <= radius && depth < bodyDepth;
        const isNearHit = !isBodyHit && gap - radius <= SLACK_PIXELS && gap - radius < nearGap;
        if (!isBodyHit && !isNearHit) continue;
        if (isColleagueHidden(camera, rig)) continue;
        if (isBodyHit) {
          bodyDepth = depth;
          bodyId = id;
        } else {
          nearGap = gap - radius;
          nearId = id;
        }
      }
      return bodyId ?? nearId;
    },
  };
}
