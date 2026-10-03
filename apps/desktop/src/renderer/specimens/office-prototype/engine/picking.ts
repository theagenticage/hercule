/**
 * PROTOTYPE - finds the colleague under the pointer.
 */
import { Raycaster, Vector2, type Object3D, type PerspectiveCamera } from "three";
import type { ColleagueRig } from "./contracts";

/** The key under which a rig's root object stores its colleague's id. */
export const COLLEAGUE_ID = "colleagueId";

export interface Picker {
  /** Returns the id of the colleague drawn at a point of the canvas, or null. */
  pick(clientX: number, clientY: number): string | null;
}

export function createPicker(
  canvas: HTMLCanvasElement,
  camera: PerspectiveCamera,
  rigs: ReadonlyMap<string, ColleagueRig>,
): Picker {
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  const roots: Object3D[] = [];
  for (const [id, rig] of rigs) {
    rig.object.userData[COLLEAGUE_ID] = id;
    roots.push(rig.object);
  }
  return {
    pick(clientX, clientY) {
      const box = canvas.getBoundingClientRect();
      pointer.set(
        ((clientX - box.left) / box.width) * 2 - 1,
        -((clientY - box.top) / box.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const [hit] = raycaster.intersectObjects(roots, true);
      let object: Object3D | null = hit?.object ?? null;
      while (object !== null) {
        const id = object.userData[COLLEAGUE_ID] as string | undefined;
        if (id !== undefined) return id;
        object = object.parent;
      }
      return null;
    },
  };
}
