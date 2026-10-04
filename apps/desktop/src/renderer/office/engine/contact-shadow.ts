/**
 * The soft shadow under a colleague's feet. The sun's shadows are
 * drawn once for the still building and kept, so a colleague, who moves, can
 * not cast into them: its shadow would stay where it stood when they were
 * drawn. A dark disc that fades toward its rim stands in for it, as in many
 * games, and costs one small draw per colleague.
 */
import {
  CanvasTexture,
  CircleGeometry,
  Mesh,
  MeshBasicMaterial,
  SRGBColorSpace,
  type Object3D,
} from "three";
import { registerCache } from "./caches";

/** The disc's radius, in metres: a little wider than a standing colleague. */
const RADIUS = 0.34;
/** How dark the middle of the disc is. */
const DARKNESS = 0.3;
/** How far above the floor the disc lies, so it never flickers into the floor. */
const LIFT = 0.004;

let shared: { readonly geometry: CircleGeometry; readonly material: MeshBasicMaterial } | null =
  null;

/** Returns the disc's geometry and material, which every colleague shares. */
function readShared(): NonNullable<typeof shared> {
  if (shared !== null) return shared;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const context = canvas.getContext("2d")!;
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(0, 0, 0, 1)");
  gradient.addColorStop(0.45, "rgba(0, 0, 0, 0.75)");
  gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const geometry = new CircleGeometry(RADIUS, 24);
  geometry.rotateX(-Math.PI / 2);
  const material = new MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: DARKNESS,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  shared = { geometry, material };
  return shared;
}

/**
 * Frees the disc's geometry, material and texture, which every colleague
 * shares and so no colleague frees. The next contact shadow builds them again.
 */
function disposeContactShadows(): void {
  if (shared === null) return;
  shared.material.map?.dispose();
  shared.material.dispose();
  shared.geometry.dispose();
  shared = null;
}

registerCache(disposeContactShadows);

/**
 * Lays a contact shadow under `object`, a colleague's root, whose origin sits
 * between the feet on the floor, and stops every mesh under it from casting
 * the sun's shadow.
 */
export function addContactShadow(object: Object3D): void {
  object.traverse((child) => {
    child.castShadow = false;
  });
  const { geometry, material } = readShared();
  const disc = new Mesh(geometry, material);
  disc.name = "contact shadow";
  disc.position.y = LIFT;
  // A click on the shadow is a click on the floor, not on the colleague.
  disc.raycast = () => {};
  object.add(disc);
}
