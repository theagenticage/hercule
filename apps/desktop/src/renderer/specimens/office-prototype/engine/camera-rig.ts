/**
 * PROTOTYPE - how the user looks around the office. STUB: three's orbit
 * controls, until the camera part replaces this. Keep the exported signature.
 */
import { Vector3, type Box3, type PerspectiveCamera } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { CameraView } from "./contracts";
import type { Frame } from "./stage";

export interface CameraRig {
  /** Advances any flight or damping. Returns true while the camera moves. */
  update(frame: Frame): boolean;
  /** Flies to a view. */
  flyTo(view: CameraView): void;
  /** Keeps a moving point in view, or stops following with null. */
  follow(target: (() => Vector3) | null): void;
  /** Limits panning to the office's box. */
  setBounds(bounds: Box3): void;
  dispose(): void;
}

/** Places the camera at a view at once. */
export function placeCamera(camera: PerspectiveCamera, view: CameraView): void {
  const azimuth = (view.azimuth * Math.PI) / 180;
  const elevation = (view.elevation * Math.PI) / 180;
  camera.position.set(
    view.target.x + view.distance * Math.cos(elevation) * Math.sin(azimuth),
    view.target.y + view.distance * Math.sin(elevation),
    view.target.z + view.distance * Math.cos(elevation) * Math.cos(azimuth),
  );
  camera.lookAt(view.target);
}

export function createCameraRig(
  camera: PerspectiveCamera,
  element: HTMLElement,
  requestRender: () => void,
): CameraRig {
  const controls = new OrbitControls(camera, element);
  controls.enableDamping = true;
  controls.addEventListener("change", requestRender);
  return {
    update() {
      return controls.update();
    },
    flyTo(view) {
      placeCamera(camera, view);
      controls.target.copy(view.target);
      requestRender();
    },
    follow() {},
    setBounds() {},
    dispose() {
      controls.dispose();
    },
  };
}
