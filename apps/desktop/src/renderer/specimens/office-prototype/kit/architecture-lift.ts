/**
 * PROTOTYPE - the tower's lift: a brass cage shaft through every storey, a
 * car with a folding gate, and a dial over each landing whose needle follows
 * the car.
 *
 * Real dimensions, in metres:
 *
 * - the shaft's footprint is `LIFT_FOOTPRINT` (1.3 by 1.3), its landing on +z;
 * - the car is 1.06 by 1.06 outside, and its interior `LIFT_CAR_INTERIOR`
 *   is 0.96 wide, 0.96 deep and 1.7 tall;
 * - a landing's opening is 1.0 wide and 1.8 tall;
 * - the machine room on top adds 0.62 above the last storey.
 */
import {
  BufferGeometry,
  CircleGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  TorusGeometry,
} from "three";
import { paint } from "../engine/palette";
import type { Frame } from "../engine/stage";
import {
  buildCanvasLabel,
  buildMergedMesh,
  decoFont,
  mergeParts,
  placeBox,
  readCssColor,
} from "./architecture-shared";

/** The shaft's outer width and depth. */
export const LIFT_FOOTPRINT = 1.3;
/** The room inside the car: width (x), depth (z) and height. */
export const LIFT_CAR_INTERIOR = { width: 0.96, depth: 0.96, height: 1.7 } as const;

/** The tower's lift: a shaft through every storey, and a car that moves between them. */
export interface LiftHandle {
  readonly object: Object3D;
  /**
   * The car, which a riding colleague stands in. Its origin is the car's
   * floor, in the middle. A layout may set `car.position.y` itself; `update`
   * always starts from where the car is.
   */
  readonly car: Object3D;
  /** Sends the car to a storey, counted from 0 at the bottom. */
  callTo(floor: number): void;
  /**
   * Advances the car: it closes its gate, travels, and opens it again. It
   * also moves the dials' needles and the cable to wherever the car is, even
   * when the car was moved from outside. Returns true while the car or its
   * gate moves.
   */
  update(frame: Frame): boolean;
}

/** The posts at the shaft's corners stand this far from its centre. */
const POST_AT = LIFT_FOOTPRINT / 2 - 0.025;
const POST = 0.05;
/** The car's outer half width, and its walls' thickness. */
const CAR_HALF = LIFT_CAR_INTERIOR.width / 2 + 0.03;
const CAR_WALL = 0.03;
const LANDING_WIDTH = 1.0;
const LANDING_HEIGHT = 1.8;
/** How long the gate takes to fold or unfold. */
const GATE_SECONDS = 0.5;
/** How far the folded gate shrinks toward its post. */
const GATE_FOLDED = 0.12;
/** The dial's radius, and the needle's sweep either side of straight up. */
const DIAL_RADIUS = 0.15;
const DIAL_SWEEP = (Math.PI / 2) * 0.78;
const MACHINE_ROOM_HEIGHT = 0.62;

/** What the car is doing now. */
type LiftPhase = "idle" | "closing" | "moving" | "opening";

/**
 * Builds a lift shaft `floors` storeys tall, each `floorHeight`, with its
 * landings on +z. The shaft's origin is the middle of its footprint at the
 * bottom storey's floor; the car starts there with its gate open.
 *
 * Each storey's piece of shaft is its own child, tagged
 * `userData.liftFloor = k` (0 at the bottom), so a layout can hide the
 * storeys above a cut. The machine room is tagged with the top storey's
 * index. The car is a separate child.
 */
export function buildLift(floors: number, floorHeight: number): LiftHandle {
  const storeys = Math.max(1, Math.round(floors));
  const object = new Group();
  const dial = buildDial(storeys);
  const cageGeometry = buildCageStorey(floorHeight);
  const brass = paint("brass", "brass");
  const needleMaterial = paint("room-inlay-2", "gloss");
  const dialY = Math.min(LANDING_HEIGHT + 0.27, floorHeight - DIAL_RADIUS - 0.08);
  const needles: Mesh[] = [];
  const needleGeometry = mergeParts([
    placeBox(0.012, DIAL_RADIUS * 0.82, 0.004),
    new CylinderGeometry(0.018, 0.018, 0.008, 16).rotateX(Math.PI / 2).translate(0, 0, 0.002),
  ])!;
  for (let storey = 0; storey < storeys; storey++) {
    const section = new Group();
    section.position.y = storey * floorHeight;
    section.userData.liftFloor = storey;
    const cage = new Mesh(cageGeometry, brass);
    cage.castShadow = true;
    cage.receiveShadow = true;
    section.add(cage);
    const face = new Mesh(dial.face, dial.material);
    face.position.set(0, dialY, POST_AT + 0.036);
    section.add(face);
    const rim = new Mesh(dial.rim, brass);
    rim.position.copy(face.position);
    section.add(rim);
    const needle = new Mesh(needleGeometry, needleMaterial);
    needle.position.set(0, dialY, POST_AT + 0.04);
    section.add(needle);
    needles.push(needle);
    if (storey === 0) {
      // A ring round the foot of the shaft; the car's floor sits inside it, flush with the storey.
      const outer = LIFT_FOOTPRINT + 0.08;
      const ring = 0.12;
      const plinth = buildMergedMesh(paint("room-inlay-2", "gloss"), [
        placeBox(outer, 0.04, ring, 0, 0, -(outer - ring) / 2),
        placeBox(outer, 0.04, ring, 0, 0, (outer - ring) / 2),
        placeBox(ring, 0.04, outer - 2 * ring, -(outer - ring) / 2),
        placeBox(ring, 0.04, outer - 2 * ring, (outer - ring) / 2),
      ]);
      if (plinth !== null) section.add(plinth);
    }
    object.add(section);
  }
  const machineRoom = buildMachineRoom();
  machineRoom.position.y = storeys * floorHeight;
  machineRoom.userData.liftFloor = storeys - 1;
  object.add(machineRoom);

  const { car, gate } = buildCar();
  object.add(car);
  const cable = new Mesh(new CylinderGeometry(0.008, 0.008, 1, 6).translate(0, 0.5, 0), brass);
  object.add(cable);
  const roof = LIFT_CAR_INTERIOR.height + 0.09;
  const top = storeys * floorHeight;
  const highest = (storeys - 1) * floorHeight;

  let phase: LiftPhase = "idle";
  let gateOpen = 1;
  let target = 0;
  let from = 0;
  let elapsed = 0;
  let duration = 0;

  /** Moves the gate, the cable and every needle to match the car. */
  const followCar = () => {
    gate.scale.x = GATE_FOLDED + (1 - GATE_FOLDED) * (1 - gateOpen);
    const y = car.position.y;
    cable.position.y = y + roof;
    cable.scale.y = Math.max(0.001, top - y - roof);
    const share = highest > 0 ? Math.min(1, Math.max(0, y / highest)) : 0;
    const angle = DIAL_SWEEP - share * 2 * DIAL_SWEEP;
    for (const needle of needles) needle.rotation.z = angle;
  };
  followCar();

  return {
    object,
    car,
    callTo(floor) {
      target = Math.min(storeys - 1, Math.max(0, Math.round(floor))) * floorHeight;
      if (phase === "moving") {
        from = car.position.y;
        elapsed = 0;
        duration = travelSeconds(target - from);
      } else if (Math.abs(target - car.position.y) > 1e-3) {
        phase = "closing";
      }
    },
    update(frame) {
      if (phase === "closing") {
        gateOpen = Math.max(0, gateOpen - frame.dt / GATE_SECONDS);
        if (gateOpen === 0) {
          phase = "moving";
          from = car.position.y;
          elapsed = 0;
          duration = travelSeconds(target - from);
        }
      } else if (phase === "moving") {
        elapsed += frame.dt;
        const progress = Math.min(1, elapsed / duration);
        car.position.y = from + (target - from) * (0.5 - 0.5 * Math.cos(progress * Math.PI));
        if (progress === 1) phase = "opening";
      } else if (phase === "opening") {
        gateOpen = Math.min(1, gateOpen + frame.dt / GATE_SECONDS);
        if (gateOpen === 1) phase = "idle";
      }
      followCar();
      return phase !== "idle";
    },
  };
}

/** Returns how long the car takes to travel `distance`: a short start and stop, then 2 m/s on average. */
function travelSeconds(distance: number): number {
  return 0.6 + Math.abs(distance) / 2;
}

/**
 * Returns one storey of the brass cage: corner posts, bands at the floor, the
 * waist and the top, bars on the three closed sides, and a stepped portal
 * round the landing on +z with bars above it. Every storey shares it.
 */
function buildCageStorey(height: number): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (const x of [-POST_AT, POST_AT]) {
    for (const z of [-POST_AT, POST_AT]) parts.push(placeBox(POST, height, POST, x, 0, z));
  }
  const span = LIFT_FOOTPRINT - 0.02;
  const half = LANDING_WIDTH / 2;
  for (const y of [0, height * 0.42, height - 0.05]) {
    const band = 0.04;
    parts.push(placeBox(span, band, 0.03, 0, y, -POST_AT));
    parts.push(placeBox(0.03, band, span, -POST_AT, y, 0));
    parts.push(placeBox(0.03, band, span, POST_AT, y, 0));
    // On the landing side the band at the waist stops at the portal, so the way in stays clear.
    if (y > 0 && y < LANDING_HEIGHT + 0.1) {
      const side = POST_AT - half;
      parts.push(placeBox(side, band, 0.03, -(half + side / 2), y, POST_AT));
      parts.push(placeBox(side, band, 0.03, half + side / 2, y, POST_AT));
    } else {
      parts.push(placeBox(span, band, 0.03, 0, y, POST_AT));
    }
  }
  // Bars on the back and the two sides, about 0.11 apart.
  const bars = Math.round((2 * POST_AT) / 0.11);
  for (let index = 1; index < bars; index++) {
    const along = -POST_AT + (index * 2 * POST_AT) / bars;
    parts.push(placeBox(0.014, height, 0.014, along, 0, -POST_AT));
    parts.push(placeBox(0.014, height, 0.014, -POST_AT, 0, along));
    parts.push(placeBox(0.014, height, 0.014, POST_AT, 0, along));
  }
  // The landing: a stepped portal on +z, and bars above it.
  const portalTop = Math.min(LANDING_HEIGHT, height - 0.3);
  for (const [width, proud] of [
    [0.07, 0.02],
    [0.035, 0.034],
  ] as const) {
    const z = POST_AT + proud / 2;
    parts.push(placeBox(width, portalTop + width, proud, -half - width / 2, 0, z));
    parts.push(placeBox(width, portalTop + width, proud, half + width / 2, 0, z));
    parts.push(placeBox(LANDING_WIDTH + 2 * width, width, proud, 0, portalTop, z));
  }
  // A stepped crest over the portal, under the dial.
  parts.push(placeBox(0.42, 0.04, 0.03, 0, portalTop + 0.07, POST_AT + 0.015));
  parts.push(placeBox(0.22, 0.035, 0.03, 0, portalTop + 0.11, POST_AT + 0.015));
  for (let index = 1; index < bars; index++) {
    const along = -POST_AT + (index * 2 * POST_AT) / bars;
    if (Math.abs(along) < half + 0.07) {
      parts.push(placeBox(0.014, height - portalTop, 0.014, along, portalTop, POST_AT));
    } else {
      parts.push(placeBox(0.014, height, 0.014, along, 0, POST_AT));
    }
  }
  return mergeParts(parts)!;
}

/** The parts of a landing dial that every landing shares. */
interface DialParts {
  readonly face: BufferGeometry;
  readonly rim: BufferGeometry;
  readonly material: MeshStandardMaterial;
}

/**
 * Returns the dial's half-disc face, with a tick and a numeral for each
 * storey (G for the ground storey), and its brass rim. The face is in the
 * x-y plane, its centre at the origin.
 */
function buildDial(storeys: number): DialParts {
  const size = 256;
  const { texture } = buildCanvasLabel(size, size, (context) => {
    const centre = size / 2;
    const radius = size / 2;
    context.fillStyle = readCssColor("room-paper");
    context.beginPath();
    context.arc(centre, centre, radius, Math.PI, 0);
    context.fill();
    context.strokeStyle = readCssColor("room-inlay-2");
    context.fillStyle = readCssColor("room-inlay-2");
    context.lineWidth = 5;
    context.font = decoFont(30);
    context.textAlign = "center";
    context.textBaseline = "middle";
    for (let storey = 0; storey < storeys; storey++) {
      const share = storeys > 1 ? storey / (storeys - 1) : 0.5;
      // The canvas's y grows downward, so the angle is measured from the left, through the top.
      const angle = Math.PI / 2 + DIAL_SWEEP - share * 2 * DIAL_SWEEP;
      const x = Math.cos(angle);
      const y = -Math.sin(angle);
      context.beginPath();
      context.moveTo(centre + x * radius * 0.8, centre + y * radius * 0.8);
      context.lineTo(centre + x * radius * 0.94, centre + y * radius * 0.94);
      context.stroke();
      context.fillText(
        storey === 0 ? "G" : String(storey),
        centre + x * radius * 0.6,
        centre + y * radius * 0.6,
      );
    }
  });
  const material = new MeshStandardMaterial({ map: texture, roughness: 0.6, metalness: 0 });
  const face = new CircleGeometry(DIAL_RADIUS, 24, 0, Math.PI);
  face.addEventListener("dispose", () => {
    texture.dispose();
    material.dispose();
  });
  const rim = mergeParts([
    new TorusGeometry(DIAL_RADIUS, 0.012, 6, 24, Math.PI),
    placeBox(2 * DIAL_RADIUS + 0.04, 0.022, 0.02, 0, -0.022, 0),
  ])!;
  return { face, rim, material };
}

/** Builds the machine room on top of the shaft: a stepped Deco crown with a brass band and a finial. */
function buildMachineRoom(): Object3D {
  const dark: BufferGeometry[] = [
    placeBox(LIFT_FOOTPRINT + 0.1, 0.06, LIFT_FOOTPRINT + 0.1),
    placeBox(LIFT_FOOTPRINT - 0.04, 0.24, LIFT_FOOTPRINT - 0.04, 0, 0.06),
    placeBox(LIFT_FOOTPRINT - 0.3, 0.14, LIFT_FOOTPRINT - 0.3, 0, 0.32),
    placeBox(LIFT_FOOTPRINT - 0.62, 0.1, LIFT_FOOTPRINT - 0.62, 0, 0.46),
  ];
  const trim: BufferGeometry[] = [
    placeBox(LIFT_FOOTPRINT - 0.02, 0.03, LIFT_FOOTPRINT - 0.02, 0, 0.2),
    placeBox(LIFT_FOOTPRINT - 0.28, 0.02, LIFT_FOOTPRINT - 0.28, 0, 0.3),
    new CylinderGeometry(0.012, 0.04, MACHINE_ROOM_HEIGHT - 0.56, 8).translate(
      0,
      0.56 + (MACHINE_ROOM_HEIGHT - 0.56) / 2,
      0,
    ),
  ];
  const object = new Group();
  const body = buildMergedMesh(paint("room-inlay-2", "gloss"), dark);
  const band = buildMergedMesh(paint("brass", "brass"), trim);
  if (body !== null) object.add(body);
  if (band !== null) object.add(band);
  return object;
}

/**
 * Builds the car: a floor, panelled lower walls on the back and the sides
 * with brass bars above them, a roof with a stepped crown, and a folding
 * scissor gate on +z. Returns the car and the gate, which folds toward its
 * post at -x by scaling along x.
 */
function buildCar(): { car: Object3D; gate: Object3D } {
  const { width, depth, height } = LIFT_CAR_INTERIOR;
  const wood: BufferGeometry[] = [
    placeBox(2 * CAR_HALF + 0.04, 0.06, 2 * CAR_HALF + 0.04, 0, -0.06),
    placeBox(2 * CAR_HALF, 0.06, 2 * CAR_HALF, 0, height),
    placeBox(2 * CAR_HALF - 0.16, 0.035, 2 * CAR_HALF - 0.16, 0, height + 0.06),
  ];
  const panel = 0.62;
  wood.push(placeBox(width, panel, CAR_WALL, 0, 0, -depth / 2 - CAR_WALL / 2));
  for (const side of [-1, 1]) {
    wood.push(placeBox(CAR_WALL, panel, depth, side * (width / 2 + CAR_WALL / 2), 0, 0));
  }
  const brass: BufferGeometry[] = [];
  for (const x of [-CAR_HALF, CAR_HALF]) {
    for (const z of [-CAR_HALF, CAR_HALF]) {
      brass.push(
        placeBox(
          0.035,
          height,
          0.035,
          x + (x < 0 ? 0.0175 : -0.0175),
          0,
          z + (z < 0 ? 0.0175 : -0.0175),
        ),
      );
    }
  }
  brass.push(placeBox(width, 0.02, 0.04, 0, panel, -depth / 2 - CAR_WALL / 2));
  for (const side of [-1, 1]) {
    brass.push(placeBox(0.04, 0.02, depth, side * (width / 2 + CAR_WALL / 2), panel, 0));
  }
  // A handrail on the back wall, and bars above the panels.
  brass.push(placeBox(width - 0.12, 0.016, 0.016, 0, 0.5, -depth / 2 + 0.03));
  const bars = 8;
  for (let index = 1; index < bars; index++) {
    const along = -width / 2 + (index * width) / bars;
    const rise = height - panel;
    brass.push(placeBox(0.012, rise, 0.012, along, panel, -depth / 2 - CAR_WALL / 2));
    brass.push(placeBox(0.012, rise, 0.012, -width / 2 - CAR_WALL / 2, panel, along));
    brass.push(placeBox(0.012, rise, 0.012, width / 2 + CAR_WALL / 2, panel, along));
  }
  brass.push(placeBox(2 * CAR_HALF + 0.01, 0.025, 2 * CAR_HALF + 0.01, 0, height + 0.035));

  const car = new Group();
  const body = buildMergedMesh(paint("room-wood", "satin"), wood);
  const trim = buildMergedMesh(paint("brass", "brass"), brass);
  if (body !== null) car.add(body);
  if (trim !== null) car.add(trim);

  // The scissor gate: uprights with crossed slats between them, folding toward x = -width / 2.
  const gateHeight = height - 0.06;
  const slats: BufferGeometry[] = [];
  const pitch = width / 10;
  for (let index = 0; index <= 10; index++) {
    slats.push(placeBox(0.012, gateHeight, 0.01, index * pitch, 0.02, 0));
  }
  const rows = 6;
  const rise = gateHeight / rows;
  const length = Math.hypot(pitch, rise);
  const tilt = Math.atan2(rise, pitch);
  for (let index = 0; index < 10; index++) {
    for (let row = 0; row < rows; row++) {
      const x = (index + 0.5) * pitch;
      const y = 0.02 + (row + 0.5) * rise;
      for (const sign of [-1, 1]) {
        slats.push(
          placeBox(length, 0.008, 0.006, 0, -0.004, 0)
            .rotateZ(sign * tilt)
            .translate(x, y, sign * 0.006),
        );
      }
    }
  }
  const gate = new Group();
  gate.position.set(-width / 2, 0, depth / 2 + 0.02);
  const gateMesh = buildMergedMesh(paint("brass", "brass"), slats, { cast: false });
  if (gateMesh !== null) gate.add(gateMesh);
  car.add(gate);
  return { car, gate };
}
