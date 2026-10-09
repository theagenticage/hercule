/**
 * The Secretariat's longcase clock: a tall case on a plinth, a hood with a
 * round dial, and a pendulum that hangs still in the trunk's open front.
 *
 * The case is part of the still building. The hands are not: they turn once
 * a minute, and anything that moves under the building's root makes the
 * stage draw the sun's shadows again. So the hands are a group of their
 * own, which the office adds to the scene beside the building, and they
 * cast no shadow.
 */
import { Group, Mesh, type Object3D } from "three";
import {
  PartList,
  addMeshes,
  buildBlock,
  buildCylinder,
  buildRing,
  buildSheet,
  buildSphere,
  memoize,
  paintSurface,
  type Surface,
} from "./shared";
import { readHandGeometry } from "./walls";

const LONGCASE_SURFACES = {
  case: { token: "room-wood", finish: "lacquer", shadow: true },
  panel: { token: "room-inlay-2", finish: "lacquer", shadow: true },
  brass: { token: "brass", finish: "brass", shadow: true },
  face: { token: "room-paper", finish: "paper", shadow: false },
  ink: { token: "room-inlay-2", finish: "satin", shadow: false },
} as const satisfies Record<string, Surface>;

/** The height of the dial's centre above the floor, and how far its face stands in front of the origin. */
const DIAL_Y = 1.78;
const DIAL_Z = 0.155;
const DIAL_RADIUS = 0.15;

const readLongcaseGeometry = memoize(() => {
  const parts = new PartList(LONGCASE_SURFACES);
  // The plinth: a stepped base, then the trunk's foot.
  parts.add("case", buildBlock(0.52, 0.06, 0.34, 0.01, 1));
  parts.add("case", buildBlock(0.48, 0.3, 0.3, 0.015, 2), { y: 0.06 });
  parts.add("brass", buildBlock(0.49, 0.012, 0.31, 0.004, 1), { y: 0.33 });
  // The trunk, with a long dark panel framed in brass, in front of which the pendulum hangs.
  parts.add("case", buildBlock(0.38, 1.12, 0.26, 0.015, 2), { y: 0.36 });
  parts.add("panel", buildSheet(0.24, 0.86, 0.01), { y: 0.48, z: 0.13 });
  for (const side of [-1, 1]) {
    parts.add("brass", buildSheet(0.008, 0.86, 0.01), { x: side * 0.124, y: 0.48, z: 0.135 });
  }
  // The pendulum hangs still, so it is merged with the case: a rod and a round brass bob.
  parts.add("brass", buildCylinder(0.005, 0.005, 0.62, 6), { y: 0.68, z: 0.142 });
  parts.add("brass", buildCylinder(0.065, 0.065, 0.01, 24), {
    y: 0.68,
    z: 0.138,
    rx: Math.PI / 2,
  });
  // The hood: wider than the trunk, a square front framing the round dial.
  parts.add("case", buildBlock(0.46, 0.06, 0.32, 0.01, 1), { y: 1.48 });
  parts.add("case", buildBlock(0.42, 0.42, 0.3, 0.015, 2), { y: 1.54 });
  parts.add("brass", buildRing(DIAL_RADIUS + 0.012, 0.01, Math.PI * 2, 8, 48), {
    y: DIAL_Y,
    z: DIAL_Z - 0.002,
  });
  parts.add("face", buildCylinder(DIAL_RADIUS, DIAL_RADIUS, 0.006, 48), {
    y: DIAL_Y,
    z: DIAL_Z - 0.006,
    rx: Math.PI / 2,
  });
  // Brass spandrels in the dial's four corners.
  for (const x of [-1, 1]) {
    for (const y of [-1, 1]) {
      parts.add("brass", buildSphere(0.018, 10, 6, Math.PI / 2), {
        x: x * 0.165,
        y: DIAL_Y + y * 0.165,
        z: 0.15,
        rx: Math.PI / 2,
        sy: 0.4,
      });
    }
  }
  // The hour marks: a bar at each quarter, a dot at each other hour.
  for (let hour = 0; hour < 12; hour++) {
    const angle = (hour / 12) * Math.PI * 2;
    const x = Math.sin(angle) * (DIAL_RADIUS - 0.022);
    const y = DIAL_Y + Math.cos(angle) * (DIAL_RADIUS - 0.022);
    if (hour % 3 === 0) {
      parts.nest({ x, y, z: DIAL_Z, rz: -angle }, () => {
        parts.add("ink", buildSheet(0.011, 0.034, 0.003), { y: -0.017 });
      });
    } else {
      parts.add("ink", buildCylinder(0.0055, 0.0055, 0.003, 8), {
        x,
        y,
        z: DIAL_Z,
        rx: Math.PI / 2,
      });
    }
  }
  // A stepped Deco crest over the hood, with a brass finial.
  parts.add("case", buildBlock(0.48, 0.04, 0.33, 0.01, 1), { y: 1.96 });
  parts.add("case", buildBlock(0.32, 0.06, 0.28, 0.01, 1), { y: 2.0 });
  parts.add("case", buildBlock(0.16, 0.05, 0.24, 0.01, 1), { y: 2.06 });
  parts.add("brass", buildSphere(0.025, 12, 8), { y: 2.135 });
  return parts.merge();
});

/** The longcase clock: the case, and its hands, which the office places and turns. */
export interface LongcaseClockHandle {
  readonly object: Object3D;
  /**
   * The hands, centred on the dial in the clock's own space and not parented
   * to `object`. Once the clock stands in its place, move the hands by the
   * clock's world matrix and add them to the scene beside the building.
   */
  readonly hands: Object3D;
  /** Turns the hands to the hour and minute of `now`, local time. */
  readonly setTime: (now: Date) => void;
}

/**
 * Builds a longcase clock, 0.52 wide and 0.34 deep at its plinth and 2.16
 * tall to its finial, its dial facing +z. The hands show nothing until
 * `setTime` is called.
 */
export function buildLongcaseClock(): LongcaseClockHandle {
  const object = new Group();
  object.name = "longcase-clock";
  addMeshes(object, readLongcaseGeometry());
  const hands = new Group();
  hands.name = "longcase-hands";
  hands.position.set(0, DIAL_Y, DIAL_Z);
  const material = paintSurface(LONGCASE_SURFACES.ink);
  const buildHand = (size: string, z: number): Mesh => {
    const hand = new Mesh(readHandGeometry(size), material);
    hand.position.z = z;
    // The sun's shadows are drawn once; a hand that cast one would leave it behind as it turned.
    hand.castShadow = false;
    hand.receiveShadow = false;
    hands.add(hand);
    return hand;
  };
  const hourHand = buildHand("0.085x0.016", 0.003);
  const minuteHand = buildHand("0.125x0.012", 0.007);
  return {
    object,
    hands,
    setTime: (now) => {
      const minutes = now.getMinutes();
      const hours = (now.getHours() % 12) + minutes / 60;
      hourHand.rotation.z = -(hours / 12) * Math.PI * 2;
      minuteHand.rotation.z = -(minutes / 60) * Math.PI * 2;
    },
  };
}
