/**
 * PROTOTYPE - how the Tower opens a storey to the user: the storeys above
 * the one in focus lift up and fade away, so the camera looks straight into
 * it, and they come back down when the focus moves down or away.
 *
 * Every material in the office is shared through the palette, so a storey
 * cannot fade by changing its own materials. While a storey fades, each of
 * its meshes wears a private copy of its material whose opacity follows the
 * fade; once the storey is back in place, the meshes wear the shared
 * materials again, so a still tower costs nothing extra.
 */
import type { Material, Mesh, MeshStandardMaterial, Object3D } from "three";
import { subscribePalette } from "../engine/palette";
import type { Frame } from "../engine/stage";

/** How long a storey takes to lift away or come back, in seconds. */
const FADE_SECONDS = 0.42;
/** How far the storey just above the focus rises, in metres. Each one above it rises a little more. */
const LIFT_METRES = 4.5;
const LIFT_STEP_METRES = 1.2;

/** One storey the focus can lift away. */
interface FadingStorey {
  readonly group: Object3D;
  readonly baseY: number;
  /** 0 in place, 1 lifted away and hidden. */
  amount: number;
  target: number;
  /** How many storeys it sits above the focused one, which sets how far it rises. */
  rank: number;
  /** The private copy of each shared material, made the first time the storey fades. */
  readonly copies: Map<Material, Material>;
  /** The material each mesh wore before it faded, to put back when the storey lands. */
  readonly worn: Map<Mesh, Material | Material[]>;
}

/** The handle the tower drives the storeys with. */
export interface StoreyFocus {
  /** Lifts away every storey above `floor`; null brings them all back. */
  focus(floor: number | null): void;
  /** Advances the lift. Returns true while a storey still moves. */
  update(frame: Frame): boolean;
  /** Returns how far a storey has lifted away: 0 in place, 1 gone. */
  readAmount(floor: number): number;
  dispose(): void;
}

/** Eases a fade's progress in and out, so a storey starts and lands softly. */
function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** Copies a shared material's colours into its private copy, after a theme change. */
function copyColours(from: Material, to: Material): void {
  const source = from as MeshStandardMaterial;
  const copy = to as MeshStandardMaterial;
  if (source.color !== undefined) copy.color.copy(source.color);
  if (source.emissive !== undefined) copy.emissive.copy(source.emissive);
}

/**
 * Creates the focus for `groups`, one per storey from the ground floor up,
 * each placed at its storey's height.
 */
export function createStoreyFocus(groups: ReadonlyArray<Object3D>): StoreyFocus {
  const storeys: FadingStorey[] = groups.map((group) => ({
    group,
    baseY: group.position.y,
    amount: 0,
    target: 0,
    rank: 0,
    copies: new Map(),
    worn: new Map(),
  }));

  /** Returns the storey's private copy of `material`, making it the first time. */
  const copyMaterial = (storey: FadingStorey, material: Material): Material => {
    let copy = storey.copies.get(material);
    if (copy === undefined) {
      copy = material.clone();
      copy.userData.opacity = material.opacity;
      copy.transparent = true;
      storey.copies.set(material, copy);
    }
    return copy;
  };

  /** Dresses every mesh of a storey in its private copies, so the storey can fade on its own. */
  const wearCopies = (storey: FadingStorey): void => {
    storey.group.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh || storey.worn.has(mesh)) return;
      storey.worn.set(mesh, mesh.material);
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map((material) => copyMaterial(storey, material))
        : copyMaterial(storey, mesh.material);
    });
  };

  /** Puts the shared materials back on a storey that has landed. */
  const wearShared = (storey: FadingStorey): void => {
    for (const [mesh, material] of storey.worn) {
      // A prop may have changed a material while the storey was away, a
      // desk lamp lit by the sim: that change stays.
      const current = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if (current !== undefined && [...storey.copies.values()].includes(current)) {
        mesh.material = material;
      }
    }
    storey.worn.clear();
  };

  const setOpacity = (storey: FadingStorey, opacity: number): void => {
    for (const copy of storey.copies.values()) {
      copy.opacity = (copy.userData.opacity as number) * opacity;
      // A nearly gone storey stops hiding what is behind it.
      copy.depthWrite = opacity > 0.6;
    }
  };

  const stopPalette = subscribePalette(() => {
    for (const storey of storeys) {
      for (const [material, copy] of storey.copies) copyColours(material, copy);
    }
  });

  return {
    focus(floor) {
      storeys.forEach((storey, index) => {
        const above = floor !== null && index > floor;
        storey.target = above ? 1 : 0;
        if (above) storey.rank = index - floor - 1;
      });
    },
    update(frame) {
      let moving = false;
      for (const storey of storeys) {
        if (storey.amount === storey.target) continue;
        moving = true;
        const step = frame.dt / FADE_SECONDS;
        storey.amount =
          storey.target > storey.amount
            ? Math.min(storey.target, storey.amount + step)
            : Math.max(storey.target, storey.amount - step);
        const eased = easeInOut(storey.amount);
        if (storey.amount > 0) wearCopies(storey);
        storey.group.visible = storey.amount < 1;
        storey.group.position.y =
          storey.baseY + eased * (LIFT_METRES + storey.rank * LIFT_STEP_METRES);
        setOpacity(storey, 1 - eased);
        if (storey.amount === 0) wearShared(storey);
      }
      return moving;
    },
    readAmount(floor) {
      return storeys[floor]?.amount ?? 0;
    },
    dispose() {
      stopPalette();
      for (const storey of storeys) {
        wearShared(storey);
        for (const copy of storey.copies.values()) copy.dispose();
      }
    },
  };
}
