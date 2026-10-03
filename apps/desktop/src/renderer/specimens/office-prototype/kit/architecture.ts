/**
 * PROTOTYPE - the office's architecture: floors, walls, signs, the lift, the
 * tubes, and the outdoors. STUB: plain boxes, until the architecture kit
 * replaces them. Keep every exported name and signature: the layouts import
 * them.
 *
 * Every builder returns an object whose origin sits on the floor, in the
 * middle of its footprint, with its front facing +z, unless its comment says
 * otherwise.
 */
import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  Object3D,
  type Material,
  type Vector3,
} from "three";
import type { Hue } from "../../../faces/look";
import { CUTAWAY, CUTAWAY_HEIGHT, WALL_HEIGHT, type Cutaway } from "../engine/contracts";
import { paint, type Token } from "../engine/palette";
import type { Frame } from "../engine/stage";

/** Returns a box of the given size whose base sits at `y`, centred at (x, z). */
function block(
  material: Material,
  width: number,
  height: number,
  depth: number,
  x = 0,
  y = 0,
  z = 0,
): Mesh {
  const mesh = new Mesh(new BoxGeometry(width, height, depth), material);
  mesh.position.set(x, y + height / 2, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** The thickness of every wall. */
export const WALL_THICKNESS = 0.12;

/**
 * Builds a floor `width` by `depth`. Its top is at y = 0. An `inlay` draws a
 * border in that colour, a project's low-chroma tint for a code room.
 */
export function buildFloor(
  width: number,
  depth: number,
  options: { readonly inlay?: Token } = {},
): Object3D {
  const object = new Group();
  const slab = block(paint("room-floor", "matte"), width, 0.1, depth, 0, -0.1);
  slab.castShadow = false;
  object.add(slab);
  if (options.inlay !== undefined) {
    const inlay = block(paint(options.inlay, "matte"), width - 0.4, 0.005, depth - 0.4);
    inlay.castShadow = false;
    object.add(inlay);
  }
  return object;
}

/** What a wall has: its height, its doors and windows, and whether the camera may lower it. */
export interface WallOptions {
  /** Default WALL_HEIGHT. */
  readonly height?: number;
  /** The doorways, by their centre's distance from the wall's middle along x, and their width. */
  readonly doors?: ReadonlyArray<{ readonly at: number; readonly width: number }>;
  readonly windows?: boolean;
  /**
   * Makes the wall one the camera can lower to the dado rail, for the room
   * it bounds. Its outward side, local +z, must point out of that room.
   */
  readonly cutaway?: { readonly roomId: string; readonly exterior: boolean };
}

/**
 * Builds a wall `length` long, along local x, centred on the origin, its
 * base at y = 0. A wall built with `cutaway` stores a `Cutaway` in its
 * `userData[CUTAWAY]`.
 */
export function buildWall(length: number, options: WallOptions = {}): Object3D {
  const height = options.height ?? WALL_HEIGHT;
  const object = new Group();
  const upper = new Group();
  const doors = options.doors ?? [];
  // The wall's pieces, between the doorways.
  const edges = [
    -length / 2,
    ...doors.flatMap((door) => [door.at - door.width / 2, door.at + door.width / 2]),
    length / 2,
  ];
  for (let index = 0; index < edges.length; index += 2) {
    const from = edges[index]!;
    const to = edges[index + 1]!;
    if (to - from < 0.01) continue;
    const middle = (from + to) / 2;
    object.add(block(paint("room-panel"), to - from, CUTAWAY_HEIGHT, WALL_THICKNESS, middle));
    upper.add(
      block(
        paint("room-wall", "matte"),
        to - from,
        height - CUTAWAY_HEIGHT,
        WALL_THICKNESS,
        middle,
        CUTAWAY_HEIGHT,
      ),
    );
  }
  object.add(upper);
  if (options.cutaway !== undefined) {
    const cutaway: Cutaway = {
      ...options.cutaway,
      setCut(amount) {
        upper.visible = amount < 0.99;
        upper.scale.y = 1 - amount;
        upper.position.y = CUTAWAY_HEIGHT * amount;
      },
    };
    object.userData[CUTAWAY] = cutaway;
  }
  return object;
}

/** Builds a Deco pilaster or column, `height` tall. */
export function buildColumn(height: number = WALL_HEIGHT): Object3D {
  return block(paint("room-panel", "satin"), 0.3, height, 0.3);
}

/**
 * Builds a brass plaque with `text` in the display face, for a room's door
 * or a runner's floor. Its back is at z = 0 and its centre at y = 0. A `hue`
 * adds a crew-coloured enamel stripe.
 */
export function buildPlaque(text: string, options: { readonly hue?: Hue } = {}): Object3D {
  void text;
  void options;
  return block(paint("brass", "brass"), 0.8, 0.22, 0.03, 0, -0.11, 0.015);
}

/** Builds a wordmark in the display face, `height` tall, standing on y = 0, facing +z. */
export function buildWordmark(text: string, height: number): Object3D {
  return block(paint("brass", "brass"), text.length * height * 0.6, height, 0.08);
}

/** The tower's lift: a shaft through every storey, and a car that moves between them. */
export interface LiftHandle {
  readonly object: Object3D;
  /** The car, which a riding colleague stands in. Its origin is the car's floor. */
  readonly car: Object3D;
  /** Sends the car to a storey. */
  callTo(floor: number): void;
  /** Advances the car. Returns true while it moves. */
  update(frame: Frame): boolean;
}

/** Builds a lift shaft `floors` storeys tall, each `floorHeight`, with its doors on +z. */
export function buildLift(floors: number, floorHeight: number): LiftHandle {
  const object = new Group();
  object.add(block(paint("brass", "brass"), 1.4, floors * floorHeight, 0.05, 0, 0, -0.7));
  const car = block(paint("room-panel", "lacquer"), 1.2, 2.2, 1.2);
  object.add(car);
  let target = 0;
  return {
    object,
    car,
    callTo(floor) {
      target = floor * floorHeight;
    },
    update(frame) {
      const step =
        Math.sign(target - car.position.y) *
        Math.min(Math.abs(target - car.position.y), frame.dt * 1.5);
      car.position.y += step;
      return Math.abs(target - car.position.y) > 0.001;
    },
  };
}

/** The pneumatic tubes that carry events to Triage. */
export interface TubeHandle {
  readonly object: Object3D;
  /** Sends a capsule from the first point to the last. */
  send(): void;
  /** Advances the capsules. Returns true while one moves. */
  update(frame: Frame): boolean;
}

/** Builds a tube along `points`, in world space. */
export function buildTubes(points: ReadonlyArray<Vector3>): TubeHandle {
  const object = new Group();
  for (const point of points) {
    const joint = new Mesh(new CylinderGeometry(0.06, 0.06, 0.12), paint("brass", "brass"));
    joint.position.copy(point);
    object.add(joint);
  }
  return { object, send() {}, update: () => false };
}

/** Builds a tree, for the campus. */
export function buildTree(): Object3D {
  const object = new Group();
  object.add(block(paint("room-wood"), 0.2, 1.2, 0.2));
  object.add(block(paint("room-plant", "satin"), 1.4, 1.6, 1.4, 0, 1.2));
  return object;
}

/** Builds a street lamp, for the campus. */
export function buildLamppost(): Object3D {
  return block(paint("ink", "metal"), 0.1, 3, 0.1);
}

/** Builds a paved path `width` wide and `length` long, along local z, its top at y = 0.01. */
export function buildPath(width: number, length: number): Object3D {
  const path = block(paint("room-inlay", "matte"), width, 0.01, length);
  path.castShadow = false;
  return path;
}

/** Builds a patch of lawn `width` by `depth`, its top at y = 0. */
export function buildLawn(width: number, depth: number): Object3D {
  const lawn = block(
    paint("room-plant", "matte", { dl: 0.12, dc: -0.05 }),
    width,
    0.1,
    depth,
    0,
    -0.1,
  );
  lawn.castShadow = false;
  return lawn;
}
