/**
 * The still building: the part of the office that holds still
 * (walls, floors, furniture), watched so the stage can draw what never
 * changes once and keep it.
 *
 * The building mostly holds still, but not entirely: a wall drops to the dado
 * rail, a desk lamp is lit by swapping its shade's material, a note appears on
 * a desk. Nothing tells the stage about these changes, so the watch compares
 * every object of the building with what it was at the last check, each
 * frame. That costs well under a tenth of a millisecond for the whole Bureau,
 * and it keeps working for furniture added later that nobody marks.
 *
 * The watch also takes over the objects' local matrices: three.js recomputes
 * every object's matrix each frame by default, and the building's thousands
 * of objects never move. Each object's matrix is recomputed only when the
 * watch sees it moved, turned or scaled.
 */
import type { Material, Mesh, Object3D } from "three";

/** What the watch recorded of one object at the last check. */
interface Recorded {
  readonly object: Object3D;
  visible: boolean;
  material: Material | Material[] | null;
  childCount: number;
  /** Position, rotation as a quaternion, and scale. */
  readonly transform: Float64Array;
}

/** Copies an object's position, quaternion and scale into `into`. Returns true when any differed. */
function recordTransform(object: Object3D, into: Float64Array): boolean {
  const { position: p, quaternion: q, scale: s } = object;
  // Written out rather than looped over an array, so the check allocates nothing each frame.
  const changed =
    into[0] !== p.x ||
    into[1] !== p.y ||
    into[2] !== p.z ||
    into[3] !== q.x ||
    into[4] !== q.y ||
    into[5] !== q.z ||
    into[6] !== q.w ||
    into[7] !== s.x ||
    into[8] !== s.y ||
    into[9] !== s.z;
  if (changed) {
    into[0] = p.x;
    into[1] = p.y;
    into[2] = p.z;
    into[3] = q.x;
    into[4] = q.y;
    into[5] = q.z;
    into[6] = q.w;
    into[7] = s.x;
    into[8] = s.y;
    into[9] = s.z;
  }
  return changed;
}

/** Watches the still building under one root for anything that changes. */
export class StillBuilding {
  private recorded: Recorded[] = [];
  private readonly root: Object3D;

  constructor(root: Object3D) {
    this.root = root;
    this.collect();
  }

  /**
   * Checks every object of the building against the last check, and
   * recomputes the matrix of each object that moved. Returns true when
   * anything was shown or hidden, moved, turned, scaled, repainted with
   * another material, or gained or lost a part.
   */
  detectChange(): boolean {
    let changed = false;
    let grown = false;
    for (const entry of this.recorded) {
      const { object } = entry;
      if (recordTransform(object, entry.transform)) {
        object.updateMatrix();
        changed = true;
      }
      if (object.visible !== entry.visible) {
        entry.visible = object.visible;
        changed = true;
      }
      const material = (object as Mesh).material ?? null;
      if (material !== entry.material) {
        entry.material = material;
        changed = true;
      }
      if (object.children.length !== entry.childCount) grown = true;
    }
    if (grown) {
      this.collect();
      changed = true;
    }
    return changed;
  }

  /** Records every object under the root, and stops three.js recomputing their matrices each frame. */
  private collect(): void {
    this.recorded = [];
    this.root.traverse((object) => {
      object.updateMatrix();
      object.matrixAutoUpdate = false;
      const transform = new Float64Array(10);
      recordTransform(object, transform);
      this.recorded.push({
        object,
        visible: object.visible,
        material: (object as Mesh).material ?? null,
        childCount: object.children.length,
        transform,
      });
    });
    this.root.updateMatrixWorld(true);
  }
}
