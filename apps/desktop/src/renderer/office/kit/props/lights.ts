/**
 * The room's lights: the standard lamp. It is a `Lamp` the office switches
 * on in the evening: its shade lights up and its point light comes on.
 *
 * Point lights are the most expensive thing in the kit: every one adds work
 * to every lit pixel of the frame. They never cast shadows, they reach only a
 * few metres, and a room should have few of them.
 */
import { Group, PointLight, type Mesh, type Object3D } from "three";
import { LAMP, type Lamp } from "../../engine/contracts";
import { paint } from "../../engine/palette";
import {
  PartList,
  addMeshes,
  buildCylinder,
  buildLathe,
  buildSphere,
  memoize,
  writeLamplight,
  type Surface,
} from "./shared";

/** How far a lamp's light reaches, in metres. It fades to nothing there. */
const LIGHT_RANGE = 6;

/** The surfaces of the room's lights. The shade is repainted when the lamp is lit. */
const LIGHT_SURFACES = {
  base: { token: "room-inlay-2", finish: "lacquer", shadow: true },
  brass: { token: "brass", finish: "brass", shadow: true },
  shade: {
    token: "room-paper",
    finish: "satin",
    shift: { dl: -0.06, dc: 0.035 },
    shadow: true,
    changesAtRuntime: true,
  },
} as const satisfies Record<string, Surface>;

/** Returns the material of a lit shade: warm parchment, glowing from inside. */
function paintLitParchment() {
  return paint("room-paper", "glow", { dl: 0.02, dc: 0.05 });
}

/**
 * Builds a point light `intensity` candela bright, in lamplight's colour. It
 * starts switched off and never casts a shadow.
 */
function buildLampLight(intensity: number): PointLight {
  const light = new PointLight(0xffffff, intensity, LIGHT_RANGE, 2);
  light.castShadow = false;
  light.visible = false;
  light.name = "lamp-light";
  writeLamplight(light.color, 0.9);
  return light;
}

/**
 * Makes `object` a `Lamp`: switching it lights `shade` and shows `light`.
 * Returns the lamp, which is also stored in `object.userData[LAMP]`.
 */
function attachLamp(object: Object3D, shade: Mesh, light: PointLight): Lamp {
  const lamp: Lamp = {
    setOn(on) {
      shade.material = on
        ? paintLitParchment()
        : paint("room-paper", "satin", LIGHT_SURFACES.shade.shift);
      light.visible = on;
      // The director switches every lamp after each change of theme, so the
      // light takes the new theme's lamplight here.
      writeLamplight(light.color, 0.9);
    },
  };
  object.userData[LAMP] = lamp;
  return lamp;
}

// ---------------------------------------------------------------------------
// The standard lamp.

/** The height of the top of the standard lamp's shade. */
const FLOOR_LAMP_HEIGHT = 1.58;

const readFloorLampGeometry = memoize(() => {
  const parts = new PartList(LIGHT_SURFACES);
  // A round, stepped foot.
  parts.add(
    "base",
    buildLathe(
      [
        [0, 0],
        [0.17, 0],
        [0.172, 0.018],
        [0.14, 0.03],
        [0.135, 0.045],
        [0.09, 0.055],
        [0.085, 0.07],
        [0, 0.075],
      ],
      32,
    ),
  );
  // A brass stem with a knop half way up and a collar under the shade.
  parts.add("brass", buildCylinder(0.014, 0.018, 1.27, 12), { y: 0.07 });
  parts.add("brass", buildSphere(0.03, 14, 10), { y: 0.72 });
  parts.add("brass", buildCylinder(0.026, 0.03, 0.02, 14), { y: 0.075 });
  parts.add("brass", buildCylinder(0.024, 0.024, 0.04, 14), { y: 1.3 });
  // A tapered drum shade, open at the bottom, with brass trim at both edges.
  parts.add(
    "shade",
    buildLathe(
      [
        [0.215, 1.32],
        [0.21, 1.33],
        [0.15, FLOOR_LAMP_HEIGHT - 0.01],
        [0.14, FLOOR_LAMP_HEIGHT],
        [0.13, FLOOR_LAMP_HEIGHT - 0.008],
        [0.19, 1.335],
        [0.2, 1.322],
      ],
      36,
    ),
  );
  parts.add("brass", buildCylinder(0.218, 0.218, 0.012, 36), { y: 1.318 });
  parts.add("brass", buildCylinder(0.143, 0.143, 0.01, 36), { y: FLOOR_LAMP_HEIGHT - 0.012 });
  return parts.merge();
});

/** A standard lamp, which the office lights in the evening. */
interface FloorLampHandle {
  readonly object: Object3D;
  setOn(on: boolean): void;
}

/**
 * Builds a standard lamp: a stepped foot, a brass stem, and a parchment drum
 * shade. It is 0.34 across its foot, 0.44 across its shade and 1.58 tall.
 * Lit, its shade glows and one point light inside the shade lights the floor
 * and the walls around it. The `Lamp` is in `object.userData[LAMP]` too.
 */
export function buildFloorLamp(): FloorLampHandle {
  const object = new Group();
  object.name = "floor-lamp";
  const meshes = addMeshes(object, readFloorLampGeometry());
  const light = buildLampLight(8);
  light.position.y = 1.42;
  object.add(light);
  const lamp = attachLamp(object, meshes.get("shade")!, light);
  return { object, setOn: (on) => lamp.setOn(on) };
}
