/**
 * PROTOTYPE - the name tags drawn over the 3D office, as DOM elements placed
 * at each colleague's head. STUB: every tag shows, until the camera part
 * replaces this with smart tags. Keep the exported signature.
 */
import { Vector3, type PerspectiveCamera } from "three";
import type { ColleagueRig } from "./contracts";
import type { TagMode } from "../office-store";

export interface Overlay {
  /** Places every tag at its colleague's head, as the camera now sees it. */
  update(): void;
  setMode(mode: TagMode): void;
  setHovered(id: string | null): void;
  setSelected(id: string | null): void;
  dispose(): void;
}

const head = new Vector3();

export function createOverlay(
  container: HTMLElement,
  camera: PerspectiveCamera,
  rigs: ReadonlyMap<string, ColleagueRig>,
): Overlay {
  const layer = document.createElement("div");
  layer.className = "office-tags";
  container.append(layer);
  const tags = new Map<string, HTMLElement>();
  for (const [id, rig] of rigs) {
    const tag = document.createElement("div");
    tag.className = "office-tag";
    tag.textContent = rig.colleague.name;
    layer.append(tag);
    tags.set(id, tag);
  }
  let mode: TagMode = "smart";
  return {
    update() {
      const { clientWidth: width, clientHeight: height } = container;
      for (const [id, rig] of rigs) {
        const tag = tags.get(id)!;
        rig.object.getWorldPosition(head);
        head.y += rig.headHeight + 0.18;
        head.project(camera);
        const visible = mode !== "none" && head.z < 1;
        tag.hidden = !visible;
        if (!visible) continue;
        tag.style.transform = `translate(${((head.x + 1) / 2) * width}px, ${((1 - head.y) / 2) * height}px) translate(-50%, -100%)`;
      }
    },
    setMode(next) {
      mode = next;
    },
    setHovered() {},
    setSelected() {},
    dispose() {
      layer.remove();
    },
  };
}
