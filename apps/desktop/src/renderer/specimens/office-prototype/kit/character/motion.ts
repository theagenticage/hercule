/**
 * PROTOTYPE - how a colleague moves: a posture per action, blended from one
 * action to the next, with feet that plant on the floor and limbs that
 * reach their targets.
 *
 * Every frame runs the same steps:
 *
 * - the action's posture is worked out: where the pelvis is, how the body
 *   leans, where each ankle and each wrist should be;
 * - the posture is blended with the one the previous action left behind,
 *   so a change of action is a short crossfade and never a jump;
 * - the look (at a point, at the camera, a glance around) turns the head;
 * - two-bone IK turns the posture into bone rotations.
 *
 * While the colleague stands or walks, its feet belong to the foot planner.
 * A planted foot stays where it touched the floor in the world, whatever the
 * root does, and steps only when it has to: in the walk cycle, or to settle
 * back under the body when the root turned or stopped. That is why feet
 * never slide.
 *
 * Ambient motion (breathing, typing, gestures, nods, glances) is scaled by
 * one amplitude from 0 to 1. At 0 every action holds a still pose, so a rig
 * whose action has settled stops moving entirely.
 */
import { type Bone, Matrix4, type Object3D, Quaternion, Vector3, Euler } from "three";
import { DESK_HEIGHT, SEAT_HEIGHT, WALK_SPEED, type Action } from "../../engine/contracts";
import { mapFacePoint, measureEggRadius, type Anatomy } from "./anatomy";

/** How long `hop` takes, from the crouch to the landing; the rig then stands on its own. */
export const HOP_SECONDS = 0.62;

const SITTING_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  "sit",
  "type",
  "read",
  "sip",
  "sleep",
]);

/** Returns true when `action` is done sitting on a seat. */
export function isSittingAction(action: Action): boolean {
  return SITTING_ACTIONS.has(action);
}

/** Returns true when the foot planner places the feet during `action`: standing and walking. */
function hasPlantedFeet(action: Action): boolean {
  return !SITTING_ACTIONS.has(action) && action !== "hop";
}

/** A side of the body: 0 is the colleague's left (+x), 1 its right. */
type Side = 0 | 1;
const SIDES: ReadonlyArray<Side> = [0, 1];
type Pair<T> = [T, T];

/** Returns +1 for the left side and -1 for the right, to mirror an x. */
function mirrorX(side: Side): number {
  return side === 0 ? 1 : -1;
}

/** The bones a rig moves, by name. */
export interface RigBones {
  readonly pelvis: Bone;
  readonly torso: Bone;
  readonly head: Bone;
  readonly shoulders: Pair<Bone>;
  readonly elbows: Pair<Bone>;
  readonly hands: Pair<Bone>;
  readonly hips: Pair<Bone>;
  readonly knees: Pair<Bone>;
  readonly feet: Pair<Bone>;
}

/** Returns a smooth ease from 0 to 1 with zero speed at both ends. */
function easeInOut(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/** Returns a deterministic number in [0, 1) for an integer and a seed, for the rig's own randomness. */
function hashUnit(seed: number, index: number): number {
  const x = Math.sin(seed * 127.1 + index * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * A pose of the whole body, in the terms the actions think in. Turns are
 * (pitch, yaw, roll) in radians: positive pitch tips the top forward,
 * positive roll tips it toward -x.
 */
class Posture {
  /** The pelvis, in the root's space. */
  readonly pelvis = new Vector3();
  readonly pelvisTurn = new Vector3();
  /** The torso's turn on the pelvis. */
  readonly torsoTurn = new Vector3();
  /** The head's turn on the torso. A bean's head is its body, so this turns the torso too. */
  readonly headTurn = new Vector3();
  /** The body egg's squash: below 1 squashed, above 1 stretched. */
  squash = 1;
  /** The ankles, in the root's space. */
  readonly feet: Pair<Vector3> = [new Vector3(), new Vector3()];
  readonly footTurns: Pair<Vector3> = [new Vector3(), new Vector3()];
  /** The direction each knee points, in the root's space. */
  readonly kneePoles: Pair<Vector3> = [new Vector3(), new Vector3()];
  /** The wrists, in the torso's space. */
  readonly hands: Pair<Vector3> = [new Vector3(), new Vector3()];
  /** The direction each elbow points, in the torso's space. */
  readonly elbowPoles: Pair<Vector3> = [new Vector3(), new Vector3()];
  /** Each hand's turn on its forearm. */
  readonly handTurns: Pair<Vector3> = [new Vector3(), new Vector3()];

  /** Copies `other` into this posture. Returns this posture. */
  copy(other: Posture): this {
    return this.blend(other, other, 0, 0);
  }

  /**
   * Sets this posture between `a` and `b`: `t` of the way for the body and
   * `feetT` of the way for the feet. Returns this posture.
   */
  blend(a: Posture, b: Posture, t: number, feetT: number): this {
    this.pelvis.lerpVectors(a.pelvis, b.pelvis, t);
    this.pelvisTurn.lerpVectors(a.pelvisTurn, b.pelvisTurn, t);
    this.torsoTurn.lerpVectors(a.torsoTurn, b.torsoTurn, t);
    this.headTurn.lerpVectors(a.headTurn, b.headTurn, t);
    this.squash = a.squash + (b.squash - a.squash) * t;
    for (const side of SIDES) {
      this.feet[side].lerpVectors(a.feet[side], b.feet[side], feetT);
      this.footTurns[side].lerpVectors(a.footTurns[side], b.footTurns[side], feetT);
      this.kneePoles[side].lerpVectors(a.kneePoles[side], b.kneePoles[side], t);
      this.hands[side].lerpVectors(a.hands[side], b.hands[side], t);
      this.elbowPoles[side].lerpVectors(a.elbowPoles[side], b.elbowPoles[side], t);
      this.handTurns[side].lerpVectors(a.handTurns[side], b.handTurns[side], t);
    }
    return this;
  }
}

// ---------------------------------------------------------------------------
// Two-bone IK.

const scratchDirection = new Vector3();
const scratchNormal = new Vector3();
const scratchUpper = new Vector3();
const scratchX = new Vector3();
const scratchY = new Vector3();
const scratchZ = new Vector3();
const scratchBasis = new Matrix4();

/** The result of solving one limb. */
interface LimbSolution {
  /** The upper bone's rotation in the space the limb was solved in. */
  readonly upper: Quaternion;
  /** The middle joint's bend, about the upper bone's x axis. */
  bend: number;
  /** Where the end joint (wrist or ankle) ended up: the target, or as near as the limb reaches. */
  readonly end: Vector3;
  /** The lower bone's direction, from the middle joint to the end joint. */
  readonly lowerDirection: Vector3;
}

/**
 * Solves a limb of two bones, `upperLength` and `lowerLength` long, hanging
 * from `start` and reaching for `target`, with its middle joint pointing
 * toward `pole`. Writes the result to `out`; all of it is in the space of
 * `start`, `target` and `pole`. A target out of reach leaves the limb
 * straight, pointing at it.
 *
 * Each bone hangs down its own -y at rest. The upper bone's z axis points
 * toward the pole, and the middle joint bends about its x axis.
 */
function solveLimb(
  start: Vector3,
  target: Vector3,
  pole: Vector3,
  upperLength: number,
  lowerLength: number,
  out: LimbSolution,
): void {
  const a = upperLength;
  const b = lowerLength;
  const direction = scratchDirection.subVectors(target, start);
  let distance = direction.length();
  if (distance < 1e-6) direction.set(0, -1, 0);
  else direction.divideScalar(distance);
  distance = Math.min(Math.max(distance, Math.abs(a - b) + 1e-3), a + b - 1e-4);
  const normal = scratchNormal.copy(pole).addScaledVector(direction, -pole.dot(direction));
  if (normal.lengthSq() < 1e-10) normal.set(direction.y, -direction.x, 0.3);
  normal.normalize();
  const cosStart = (a * a + distance * distance - b * b) / (2 * a * distance);
  const sinStart = Math.sqrt(Math.max(0, 1 - cosStart * cosStart));
  const upper = scratchUpper
    .copy(direction)
    .multiplyScalar(cosStart)
    .addScaledVector(normal, sinStart)
    .normalize();
  const y = scratchY.copy(upper).negate();
  const z = scratchZ.copy(normal).addScaledVector(upper, -normal.dot(upper)).normalize();
  const x = scratchX.crossVectors(y, z);
  out.upper.setFromRotationMatrix(scratchBasis.makeBasis(x, y, z));
  const cosMiddle = (a * a + b * b - distance * distance) / (2 * a * b);
  out.bend = Math.PI - Math.acos(Math.min(1, Math.max(-1, cosMiddle)));
  // The lower bone's -y after the bend, in the solve's space.
  out.lowerDirection
    .copy(upper)
    .multiplyScalar(Math.cos(out.bend))
    .addScaledVector(z, -Math.sin(out.bend));
  out.end.copy(start).addScaledVector(upper, a).addScaledVector(out.lowerDirection, b);
}

/** Returns a fresh, empty limb solution. */
function createLimbSolution(): LimbSolution {
  return { upper: new Quaternion(), bend: 0, end: new Vector3(), lowerDirection: new Vector3() };
}

// ---------------------------------------------------------------------------
// The foot planner.

/** One foot, as the planner tracks it. */
interface PlannedFoot {
  /** True while the foot stands on the floor. */
  planted: boolean;
  /** Where a planted foot stands, in the world. */
  readonly lock: Vector3;
  /** The world yaw a planted foot points in. */
  lockYaw: number;
  /** Where a stepping foot lifted off, in the world, and the yaw it had. */
  readonly liftedFrom: Vector3;
  liftedYaw: number;
  /** How far through its step a stepping foot is, from 0 to 1. */
  progress: number;
  /** The walk cycle's swing fraction at which this step started. */
  swingStart: number;
}

/** How a colleague's gait is sized. */
interface Gait {
  /** The distance the root travels in one whole cycle (two steps). */
  readonly cycleLength: number;
  /** The fraction of a cycle each foot stands on the floor. */
  readonly stance: number;
  /** The fewest cycles per second, so a slow walk still steps. */
  readonly minimumCadence: number;
  /** How high a stepping foot lifts. */
  readonly lift: number;
}

const BEAN_GAIT: Gait = { cycleLength: 0.4, stance: 0.5, minimumCadence: 1.4, lift: 0.045 };
const SUITED_GAIT: Gait = { cycleLength: 0.56, stance: 0.55, minimumCadence: 1.1, lift: 0.05 };

/** A settling step's length in seconds: a foot stepping back under the body. */
const SETTLE_STEP_SECONDS = 0.22;

const scratchWorld = new Vector3();
const scratchLocal = new Vector3();

/**
 * Places a colleague's feet while it stands or walks. A planted foot is
 * locked to the world; the planner works out each foot's place in the
 * root's space every frame.
 */
class FootPlanner {
  readonly positions: Pair<Vector3> = [new Vector3(), new Vector3()];
  /** Each foot's yaw against the root, and its pitch from stepping. */
  readonly yaws: Pair<number> = [0, 0];
  readonly pitches: Pair<number> = [0, 0];
  /** The walk cycle's phase, from 0 to 1; the left foot touches down at 0. */
  phase = 0;
  private readonly feet: Pair<PlannedFoot>;
  private needsPlanting = true;
  private walking = false;
  private readonly gait: Gait;
  /** Where each foot stands at rest, under its hip, in the root's space. */
  private readonly neutral: Pair<Vector3>;

  constructor(gait: Gait, neutral: Pair<Vector3>) {
    this.gait = gait;
    this.neutral = neutral;
    const foot = (): PlannedFoot => ({
      planted: true,
      lock: new Vector3(),
      lockYaw: 0,
      liftedFrom: new Vector3(),
      liftedYaw: 0,
      progress: 0,
      swingStart: 0,
    });
    this.feet = [foot(), foot()];
  }

  /** Plants both feet under the body on the next update, wherever they were. */
  plantUnderBody(): void {
    this.needsPlanting = true;
  }

  /** Returns true while a foot is in the air. */
  isStepping(): boolean {
    return !this.feet[0].planted || !this.feet[1].planted;
  }

  /**
   * Moves the feet one frame on. `walking` runs the walk cycle at `speed`
   * (the root's measured speed) with a cadence for `cadenceSpeed`;
   * otherwise a foot steps only to settle back under the body.
   */
  update(
    dt: number,
    walking: boolean,
    speed: number,
    cadenceSpeed: number,
    root: Matrix4,
    inverseRoot: Matrix4,
    rootYaw: number,
  ): void {
    if (this.needsPlanting) {
      this.needsPlanting = false;
      for (const side of SIDES) this.plant(side, this.neutral[side], 0, root, rootYaw);
    }
    if (walking && !this.walking) this.startWalking();
    this.walking = walking;
    if (walking) this.walk(dt, speed, cadenceSpeed, root, inverseRoot, rootYaw);
    else this.settle(dt, root, inverseRoot, rootYaw);
  }

  /** Locks a foot to the floor at `local`, in the root's space, pointing `yaw` against the root. */
  private plant(side: Side, local: Vector3, yaw: number, root: Matrix4, rootYaw: number): void {
    const foot = this.feet[side];
    foot.planted = true;
    foot.lock.copy(local).applyMatrix4(root);
    foot.lockYaw = rootYaw + yaw;
    foot.progress = 0;
    this.positions[side].copy(local).setY(this.neutral[side].y);
    this.yaws[side] = yaw;
    this.pitches[side] = 0;
  }

  /** Lifts a foot off the floor for a step, from where it stands. */
  private lift(side: Side, swingStart: number): void {
    const foot = this.feet[side];
    foot.planted = false;
    foot.liftedFrom.copy(foot.lock);
    foot.liftedYaw = foot.lockYaw;
    foot.progress = 0;
    foot.swingStart = swingStart;
  }

  /** Writes a planted foot's place in the root's space. */
  private holdPlanted(side: Side, inverseRoot: Matrix4, rootYaw: number): void {
    const foot = this.feet[side];
    this.positions[side].copy(foot.lock).applyMatrix4(inverseRoot).setY(this.neutral[side].y);
    this.yaws[side] = wrapAngle(foot.lockYaw - rootYaw);
    this.pitches[side] = 0;
  }

  /** Writes a stepping foot's place, `progress` of the way from where it lifted to `landing`. */
  private moveStepping(
    side: Side,
    progress: number,
    landing: Vector3,
    inverseRoot: Matrix4,
    rootYaw: number,
  ): void {
    const foot = this.feet[side];
    const eased = easeInOut(progress);
    const from = scratchLocal.copy(foot.liftedFrom).applyMatrix4(inverseRoot);
    from.y = this.neutral[side].y;
    this.positions[side].lerpVectors(from, landing, eased);
    this.positions[side].y += this.gait.lift * Math.sin(Math.PI * progress);
    this.yaws[side] = wrapAngle(foot.liftedYaw - rootYaw) * (1 - eased);
    // The toe dips as the foot leaves the floor and lifts before it lands.
    this.pitches[side] = 0.3 * Math.sin(2 * Math.PI * progress);
  }

  /** Starts the walk cycle where the feet are, so no foot jumps. */
  private startWalking(): void {
    const { stance } = this.gait;
    const stepping = SIDES.find((side) => !this.feet[side].planted);
    if (stepping === undefined) {
      // The left foot is about to lift; the right one has just landed.
      this.phase = stance - 0.01;
      return;
    }
    const foot = this.feet[stepping];
    const swing = stance + foot.progress * (1 - stance);
    this.phase = wrapUnit(swing - stepping * 0.5);
    foot.swingStart = foot.progress;
    foot.progress = 0;
  }

  private walk(
    dt: number,
    speed: number,
    cadenceSpeed: number,
    root: Matrix4,
    inverseRoot: Matrix4,
    rootYaw: number,
  ): void {
    const { stance, cycleLength, minimumCadence } = this.gait;
    const cadence = Math.max(minimumCadence, cadenceSpeed / cycleLength);
    this.phase = wrapUnit(this.phase + cadence * dt);
    // The root travels this far while one foot stands; the foot lands half of it ahead.
    const stride = (speed * stance) / cadence;
    for (const side of SIDES) {
      const foot = this.feet[side];
      const phase = wrapUnit(this.phase + side * 0.5);
      if (phase < stance) {
        if (!foot.planted) {
          this.plant(side, this.positions[side], this.yaws[side], root, rootYaw);
        }
        this.holdPlanted(side, inverseRoot, rootYaw);
        continue;
      }
      const swing = (phase - stance) / (1 - stance);
      if (foot.planted) this.lift(side, swing);
      const progress = Math.min(1, (swing - foot.swingStart) / Math.max(1e-3, 1 - foot.swingStart));
      foot.progress = progress;
      const landing = scratchWorld.copy(this.neutral[side]);
      landing.z += stride / 2;
      this.moveStepping(side, progress, landing, inverseRoot, rootYaw);
    }
  }

  private settle(dt: number, root: Matrix4, inverseRoot: Matrix4, rootYaw: number): void {
    let stepping: Side | null = null;
    for (const side of SIDES) if (!this.feet[side].planted) stepping = side;
    if (stepping === null) {
      // Step the foot that strayed furthest from under the body, if any did.
      let furthest = 0.045;
      for (const side of SIDES) {
        const foot = this.feet[side];
        const local = scratchLocal.copy(foot.lock).applyMatrix4(inverseRoot);
        const stray = Math.hypot(local.x - this.neutral[side].x, local.z - this.neutral[side].z);
        const turn = Math.abs(wrapAngle(foot.lockYaw - rootYaw));
        const need = Math.max(stray, turn * 0.15);
        if (need > furthest) {
          furthest = need;
          stepping = side;
        }
      }
      if (stepping !== null) this.lift(stepping, 0);
    }
    for (const side of SIDES) {
      const foot = this.feet[side];
      if (foot.planted) {
        this.holdPlanted(side, inverseRoot, rootYaw);
        continue;
      }
      foot.progress = Math.min(1, foot.progress + dt / SETTLE_STEP_SECONDS);
      this.moveStepping(side, foot.progress, this.neutral[side], inverseRoot, rootYaw);
      if (foot.progress >= 1) this.plant(side, this.neutral[side], 0, root, rootYaw);
    }
  }
}

/** Returns `angle` wrapped into [-PI, PI). */
function wrapAngle(angle: number): number {
  return angle - Math.PI * 2 * Math.floor((angle + Math.PI) / (Math.PI * 2));
}

/** Returns `value` wrapped into [0, 1). */
function wrapUnit(value: number): number {
  return value - Math.floor(value);
}

// ---------------------------------------------------------------------------
// A springy value, for the squash and the hover.

/** A value that follows its target like a spring. */
export class Spring {
  value: number;
  target: number;
  private velocity = 0;
  private readonly stiffness: number;
  private readonly damping: number;

  constructor(value: number, stiffness: number, damping: number) {
    this.value = value;
    this.target = value;
    this.stiffness = stiffness;
    this.damping = damping;
  }

  /** Moves the spring one frame on. Returns true while it still moves. */
  update(dt: number): boolean {
    const step = Math.min(dt, 1 / 60);
    for (let left = dt; left > 1e-6; left -= step) {
      const h = Math.min(step, left);
      this.velocity +=
        (this.stiffness * (this.target - this.value) - this.damping * this.velocity) * h;
      this.value += this.velocity * h;
    }
    // A thousandth of a spring's travel is under a millimetre on screen, so the
    // spring settles there instead of drawing an invisible tail for a second.
    if (Math.abs(this.velocity) < 1e-3 && Math.abs(this.target - this.value) < 1e-3) {
      this.value = this.target;
      this.velocity = 0;
      return false;
    }
    return true;
  }
}

/** Returns the damping that gives a spring of `stiffness` the damping ratio `ratio`. */
export function measureDamping(stiffness: number, ratio: number): number {
  return 2 * Math.sqrt(stiffness) * ratio;
}

// ---------------------------------------------------------------------------
// The motion of one rig.

/** What a rig's motion is told each frame besides the time. */
export interface MotionInput {
  readonly dt: number;
  /** The ambient amplitude, 0 still to 1 fully alive. */
  readonly ambient: number;
  /** How much the colleague has noticed the pointer, 0 to about 1, springy. */
  readonly notice: number;
  /** A world point to look at, or null to look ahead (or glance around). */
  readonly look: Vector3 | null;
  /** True while the colleague sleeps, so it does not look at anything. */
  readonly asleep: boolean;
}

const scratchQuaternion = new Quaternion();
const scratchTurn = new Quaternion();
const scratchEuler = new Euler(0, 0, 0, "YXZ");
const scratchPoint = new Vector3();
const scratchMatrix = new Matrix4();
const scratchTorsoTurn = new Vector3();

/** Writes the rotation of a (pitch, yaw, roll) turn to `out`. Returns `out`. */
function writeTurn(turn: Vector3, out: Quaternion): Quaternion {
  return out.setFromEuler(scratchEuler.set(turn.x, turn.y, turn.z, "YXZ"));
}

/**
 * Moves one colleague's bones: its action, the crossfade between actions,
 * its feet, its look and the squash of its body.
 */
export class Motion {
  private readonly anatomy: Anatomy;
  private readonly bones: RigBones;
  private readonly root: Object3D;
  private readonly bean: boolean;
  private readonly seed: number;
  private readonly gait: Gait;
  private readonly planner: FootPlanner;

  private readonly standingHeight: number;
  private readonly seatedHeight: number;
  private readonly neutralFeet: Pair<Vector3>;
  private readonly shoulders: Pair<Vector3>;
  private readonly hangingHands: Pair<Vector3>;
  private readonly hipOffsets: Pair<Vector3>;
  private readonly reach: number;
  /** The face's mouth and eye line, in the torso's space. */
  private readonly mouth: Vector3;
  /** Where a reader holds the newspaper, in the torso's space, and its size. */
  readonly newspaper: { readonly centre: Vector3; readonly width: number; readonly height: number };

  private action: Action = "stand";
  private clock = 0;
  private hopClock = 0;
  private blendWeight = 1;
  private blendSeconds = 0.2;
  private blendArc = 0;
  private blendFeet = true;
  private hasPosture = false;
  private readonly from = new Posture();
  private readonly target = new Posture();
  private readonly output = new Posture();

  private walkSpeed = WALK_SPEED;
  private measuredSpeed = 0;
  private readonly lastRootPosition = new Vector3();
  private hasRootPosition = false;
  private readonly inverseRoot = new Matrix4();

  private lookYaw = 0;
  private lookPitch = 0;
  private readonly squash = new Spring(1, 260, measureDamping(260, 0.32));
  private readonly limb = createLimbSolution();
  /** Where each wrist ended up and which way each forearm points, in the torso's space. */
  readonly wrists: Pair<Vector3> = [new Vector3(), new Vector3()];
  readonly forearms: Pair<Vector3> = [new Vector3(0, -1, 0), new Vector3(0, -1, 0)];

  constructor(anatomy: Anatomy, bones: RigBones, root: Object3D, id: string) {
    this.anatomy = anatomy;
    this.bones = bones;
    this.root = root;
    this.bean = anatomy.style === "bean";
    let hash = 7;
    for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 100003;
    this.seed = hash / 100003;
    this.gait = this.bean ? BEAN_GAIT : SUITED_GAIT;
    this.standingHeight = anatomy.standingPelvis;
    this.seatedHeight = SEAT_HEIGHT + anatomy.seatedPelvis;
    const { hip, shoulder } = anatomy;
    const footX = hip.x + (this.bean ? 0.006 : 0.004);
    this.neutralFeet = [
      new Vector3(footX, anatomy.ankle, hip.z),
      new Vector3(-footX, anatomy.ankle, hip.z),
    ];
    this.hipOffsets = [new Vector3(hip.x, hip.y, hip.z), new Vector3(-hip.x, hip.y, hip.z)];
    this.shoulders = [
      new Vector3(shoulder.x, shoulder.y, shoulder.z),
      new Vector3(-shoulder.x, shoulder.y, shoulder.z),
    ];
    this.reach = anatomy.upperArm + anatomy.forearm;
    const out = this.bean ? 0.05 : 0.028;
    this.hangingHands = SIDES.map((side) =>
      this.shoulders[side]
        .clone()
        .add(new Vector3(mirrorX(side) * out, -this.reach * 0.94, this.bean ? 0.025 : 0.02)),
    ) as Pair<Vector3>;
    const { egg, neck } = anatomy;
    const mouth = mapFacePoint(egg, 24, 34.4, new Vector3());
    mouth.z = egg.depth * measureEggRadius(egg, mouth.y);
    this.mouth = mouth.add(new Vector3(neck.x, neck.y, neck.z));
    const eyeLine = neck.y + mapFacePoint(egg, 24, 26.6, new Vector3()).y;
    this.newspaper = this.placeNewspaper(eyeLine);
    this.planner = new FootPlanner(this.gait, this.neutralFeet);
    for (const side of SIDES) bones.shoulders[side].position.copy(this.shoulders[side]);
  }

  /** Returns the action the rig is doing now. */
  readAction(): Action {
    return this.action;
  }

  /** Returns the height of the top of the body egg above the root, as the rig stands or sits now. */
  measureCrown(): number {
    const { egg, neck } = this.anatomy;
    return this.output.pelvis.y + neck.y + egg.height * this.squash.value;
  }

  /** Starts `action`, crossfading from whatever the body is doing now. */
  setAction(action: Action): void {
    if (action === this.action && action !== "hop") return;
    const previous = this.action;
    this.action = action;
    if (action === "hop") this.hopClock = 0;
    if (!this.hasPosture) return;
    this.from.copy(this.output);
    this.blendWeight = 0;
    const changesSeat = isSittingAction(previous) !== isSittingAction(action);
    this.blendSeconds = changesSeat ? 0.32 : action === "hop" ? 0.12 : 0.2;
    this.blendArc = changesSeat ? 0.06 : 0;
    this.blendFeet = !(hasPlantedFeet(previous) && hasPlantedFeet(action));
    if (hasPlantedFeet(action) && !hasPlantedFeet(previous)) this.planner.plantUnderBody();
  }

  setWalkSpeed(speed: number): void {
    this.walkSpeed = speed;
  }

  /** Moves the body one frame on. Returns true while anything still moves. */
  update(input: MotionInput): boolean {
    const { dt } = input;
    this.clock += dt;
    let moving = false;
    if (this.action === "hop") {
      this.hopClock += dt;
      if (this.hopClock >= HOP_SECONDS) this.setAction("stand");
      moving = true;
    }
    moving = this.measureRoot(dt) || moving;
    if (hasPlantedFeet(this.action)) {
      const walking = this.action === "walk";
      const cadenceSpeed = this.measuredSpeed > 0.05 ? this.measuredSpeed : this.walkSpeed;
      this.planner.update(
        dt,
        walking,
        this.measuredSpeed,
        cadenceSpeed,
        this.root.matrixWorld,
        this.inverseRoot,
        readYaw(this.root.matrixWorld),
      );
      moving = moving || walking || this.planner.isStepping();
    }
    this.writePosture(this.target, input.ambient);
    if (!this.hasPosture) {
      this.hasPosture = true;
      this.output.copy(this.target);
      this.blendWeight = 1;
    } else if (this.blendWeight < 1) {
      this.blendWeight = Math.min(1, this.blendWeight + dt / this.blendSeconds);
      const eased = easeInOut(this.blendWeight);
      this.output.blend(this.from, this.target, eased, this.blendFeet ? eased : 1);
      const arc = Math.sin(Math.PI * eased);
      this.output.pelvis.y += this.blendArc * arc;
      // Feet swing forward clear of the seat's edge as the colleague climbs on or off.
      if (this.blendArc > 0) {
        for (const side of SIDES) this.output.feet[side].z += 0.08 * arc;
      }
      moving = true;
    } else {
      this.output.copy(this.target);
    }
    // Noticing the pointer: the body perks up a little.
    this.output.pelvis.y += 0.012 * input.notice;
    this.squash.target = this.output.squash * (1 + 0.045 * input.notice);
    moving = this.squash.update(dt) || moving;
    moving = this.turnToLook(input) || moving;
    this.applyPosture(this.output);
    return moving || input.ambient > 0;
  }

  /** Reads the root's world motion: its speed, and whether it jumped. Returns true if it moved. */
  private measureRoot(dt: number): boolean {
    this.root.updateWorldMatrix(true, false);
    const matrix = this.root.matrixWorld;
    this.inverseRoot.copy(matrix).invert();
    const position = scratchPoint.setFromMatrixPosition(matrix);
    if (!this.hasRootPosition) {
      this.hasRootPosition = true;
      this.lastRootPosition.copy(position);
      return false;
    }
    const distance = Math.hypot(
      position.x - this.lastRootPosition.x,
      position.z - this.lastRootPosition.z,
    );
    this.lastRootPosition.copy(position);
    if (distance > 0.6) {
      // The root was placed somewhere new rather than walked there.
      this.planner.plantUnderBody();
      this.measuredSpeed = 0;
      return true;
    }
    const speed = dt > 0 ? distance / dt : 0;
    this.measuredSpeed += (speed - this.measuredSpeed) * (1 - Math.exp(-dt / 0.12));
    if (this.measuredSpeed < 1e-3) this.measuredSpeed = 0;
    return distance > 1e-5 || this.measuredSpeed > 0;
  }

  /** Writes the posture of the current action, at the current time, to `p`. */
  private writePosture(p: Posture, ambient: number): void {
    const t = this.clock + this.seed * 97;
    switch (this.action) {
      case "stand":
        this.writeStanding(p);
        this.addBreath(p, t, ambient, 1);
        break;
      case "walk":
        this.writeStanding(p);
        this.addGait(p);
        break;
      case "raise-hand":
        this.writeRaisedHand(p, t, ambient);
        break;
      case "talk":
        this.writeTalking(p, t, ambient);
        break;
      case "listen":
        this.writeListening(p, t, ambient);
        break;
      case "pin":
        this.writePinning(p, t, ambient);
        break;
      case "hop":
        this.writeHop(p);
        break;
      case "sit":
        this.writeSitting(p);
        this.addBreath(p, t, ambient, 1);
        this.addLegSwing(p, t, ambient);
        break;
      case "type":
        this.writeTyping(p, t, ambient);
        break;
      case "read":
        this.writeReading(p, t, ambient);
        break;
      case "sip":
        this.writeSipping(p, t, ambient);
        break;
      case "sleep":
        this.writeSleeping(p, t, ambient);
        break;
    }
    if (hasPlantedFeet(this.action)) {
      for (const side of SIDES) {
        p.feet[side].copy(this.planner.positions[side]);
        p.footTurns[side].x += this.planner.pitches[side];
        p.footTurns[side].y += this.planner.yaws[side];
      }
    }
  }

  /** Returns the depth of the front of the torso's egg (a bean's body, a suit's jacket) at height `y`. */
  private measureFront(y: number): number {
    const egg = this.anatomy.jacket ?? this.anatomy.egg;
    return egg.depth * measureEggRadius(egg, y);
  }

  private writeStanding(p: Posture): void {
    p.pelvis.set(0, this.standingHeight, 0);
    p.pelvisTurn.set(0, 0, 0);
    p.torsoTurn.set(0, 0, 0);
    p.headTurn.set(0, 0, 0);
    p.squash = 1;
    for (const side of SIDES) {
      const x = mirrorX(side);
      p.feet[side].copy(this.neutralFeet[side]);
      // Beans stand with their toes a little out.
      p.footTurns[side].set(0, this.bean ? x * 0.14 : x * 0.06, 0);
      p.kneePoles[side].set(x * 0.15, 0, 1);
      p.hands[side].copy(this.hangingHands[side]);
      p.elbowPoles[side].set(x * 0.4, 0, -1);
      p.handTurns[side].set(0, 0, 0);
    }
  }

  /** Adds breathing to a still pose: the body swells and the hands rise a little. */
  private addBreath(p: Posture, t: number, ambient: number, depth: number): void {
    const breath = Math.sin(2 * Math.PI * 0.27 * t) * ambient * depth;
    p.squash += (this.bean ? 0.014 : 0.008) * breath;
    for (const side of SIDES) p.hands[side].y += 0.004 * breath;
    // A slow shift of weight from foot to foot.
    const sway = Math.sin(2 * Math.PI * 0.07 * t + 1.3) * ambient;
    p.pelvisTurn.z += 0.012 * sway;
  }

  /** Adds the walk cycle's bob, lean, waddle and arm swing to a standing pose. */
  private addGait(p: Posture): void {
    const { stance } = this.gait;
    const phase = this.planner.phase;
    const pace = Math.min(1, Math.max(this.measuredSpeed, 0.3) / WALK_SPEED);
    const bob = this.bean ? 0.014 : 0.012;
    // Lowest just after each foot lands, highest as it passes under the body.
    p.pelvis.y -= (this.bean ? 0.012 : 0.01) + bob * Math.cos(4 * Math.PI * (phase - 0.04));
    p.pelvisTurn.x += (this.bean ? 0.08 : 0.05) * pace;
    // The body rolls over whichever foot stands on the floor.
    const over = Math.cos(2 * Math.PI * (phase - stance / 2));
    p.pelvisTurn.z -= (this.bean ? 0.065 : 0.02) * over;
    p.pelvis.x += (this.bean ? 0.01 : 0.007) * over;
    if (!this.bean) p.torsoTurn.y += 0.05 * Math.sin(2 * Math.PI * phase) * pace;
    const swing = (this.bean ? 0.07 : 0.1) * pace * Math.cos(2 * Math.PI * phase);
    for (const side of SIDES) {
      // Each arm swings with the opposite leg.
      const forward = side === 0 ? -swing : swing;
      p.hands[side].z += forward;
      p.hands[side].y += 0.25 * Math.abs(forward);
    }
  }

  private writeRaisedHand(p: Posture, t: number, ambient: number): void {
    this.writeStanding(p);
    this.addBreath(p, t, ambient, 0.6);
    const wave = Math.sin(2 * Math.PI * 1.3 * t) * ambient;
    const shoulder = this.shoulders[0];
    p.hands[0].set(
      shoulder.x + (this.bean ? 0.07 : 0.05) + 0.03 * wave,
      shoulder.y + this.reach * 0.88,
      shoulder.z + 0.05,
    );
    p.elbowPoles[0].set(1, -0.2, -0.5);
    p.handTurns[0].set(0.28 * wave, 0, 0);
    // The body leans away from the raised arm, and bounces a little with eagerness.
    p.torsoTurn.z += this.bean ? 0.05 : 0.03;
    p.pelvis.y += 0.004 * Math.max(0, Math.sin(2 * Math.PI * 1.3 * t)) * ambient;
  }

  private writeTalking(p: Posture, t: number, ambient: number): void {
    this.writeStanding(p);
    this.addBreath(p, t, ambient, 0.6);
    const gesture = (offset: number): number =>
      (0.6 * Math.sin(1.9 * t + offset) + 0.4 * Math.sin(3.1 * t + offset * 2.3)) * ambient;
    for (const side of SIDES) {
      const x = mirrorX(side);
      const shoulder = this.shoulders[side];
      const g = gesture(side * 2.1);
      const height = shoulder.y - this.reach * 0.55 + 0.05 * Math.max(0, g);
      p.hands[side].set(
        shoulder.x + x * (0.03 + 0.03 * g),
        height,
        this.measureFront(height) + 0.07 + 0.03 * g,
      );
      p.elbowPoles[side].set(x * 0.8, -0.6, -1);
      p.handTurns[side].set(-0.5, 0, 0);
    }
    p.torsoTurn.y += 0.07 * Math.sin(0.9 * t) * ambient;
    p.torsoTurn.x += 0.025 * Math.sin(2.3 * t) * ambient;
  }

  private writeListening(p: Posture, t: number, ambient: number): void {
    this.writeStanding(p);
    this.addBreath(p, t, ambient, 1);
    for (const side of SIDES) {
      const x = mirrorX(side);
      const height = this.shoulders[side].y - this.reach * 0.78;
      p.hands[side].set(x * 0.04, height, this.measureFront(height) + 0.035);
      p.elbowPoles[side].set(x, -0.3, -0.8);
    }
    // Two nods every few seconds, and the head tipped a little to one side.
    const cycle = wrapUnit(t / 3.2);
    const nod = cycle < 0.3 ? Math.sin((cycle / 0.3) * Math.PI * 2) ** 2 : 0;
    if (this.bean) {
      p.torsoTurn.x += 0.08 * nod * ambient;
      p.torsoTurn.z += 0.05;
    } else {
      p.headTurn.x += 0.18 * nod * ambient;
      p.headTurn.z += 0.08;
    }
  }

  private writePinning(p: Posture, t: number, ambient: number): void {
    this.writeStanding(p);
    this.addBreath(p, t, ambient, 0.6);
    const press = Math.max(0, Math.sin(2 * Math.PI * (t / 2.4))) ** 4 * ambient;
    const shoulder = this.shoulders[0];
    p.hands[0].set(
      shoulder.x - 0.03,
      shoulder.y + this.reach * 0.7,
      shoulder.z + this.reach * 0.5 + 0.025 * press,
    );
    p.elbowPoles[0].set(1, -0.6, -0.2);
    p.handTurns[0].set(-0.6, 0, 0);
    p.torsoTurn.x += this.bean ? -0.06 : 0.03;
    if (!this.bean) p.headTurn.x -= 0.16;
  }

  /** The hop: a crouch, a jump with arms up, a landing that squashes; then the rig stands. */
  private writeHop(p: Posture): void {
    this.writeStanding(p);
    const t = this.hopClock;
    const crouch = 0.14;
    const air = 0.32;
    let dip: number;
    let height = 0;
    let squash: number;
    let joy = 0;
    if (t < crouch) {
      const k = easeInOut(t / crouch);
      dip = -0.04 * k;
      squash = 1 - 0.1 * k;
    } else if (t < crouch + air) {
      const u = (t - crouch) / air;
      height = 0.16 * Math.sin(Math.PI * u);
      dip = -0.04 * (1 - easeInOut(u / 0.25));
      squash = u < 0.5 ? 1.08 : 1.02;
      joy = Math.sin(Math.PI * Math.min(1, u * 1.3));
      for (const side of SIDES) p.feet[side].y += 0.035 * Math.sin(Math.PI * u);
    } else {
      const v = Math.min(1, (t - crouch - air) / (HOP_SECONDS - crouch - air));
      dip = -0.035 * Math.sin(Math.PI * v);
      squash = 1 - 0.1 * Math.sin(Math.PI * v);
    }
    p.pelvis.y += dip + height;
    p.squash = squash;
    for (const side of SIDES) {
      p.feet[side].y += height;
      const x = mirrorX(side);
      const shoulder = this.shoulders[side];
      const up = scratchPoint.set(
        shoulder.x + x * 0.1,
        shoulder.y + this.reach * 0.62,
        shoulder.z + 0.05,
      );
      p.hands[side].lerp(up, joy);
      p.elbowPoles[side].set(x, -0.4 * joy, -1 + joy * 0.6);
    }
  }

  private writeSitting(p: Posture): void {
    const bean = this.bean;
    const { anatomy } = this;
    const pelvisZ = bean ? 0.06 : 0.03;
    p.pelvis.set(0, this.seatedHeight, pelvisZ);
    p.pelvisTurn.set(0, 0, 0);
    p.torsoTurn.set(0, 0, 0);
    p.headTurn.set(0, 0, 0);
    p.squash = 1;
    const hipY = this.seatedHeight + anatomy.hip.y;
    for (const side of SIDES) {
      const x = mirrorX(side);
      if (bean) {
        // A bean's legs stick out over the seat's edge, toes up.
        p.feet[side].set(x * (anatomy.hip.x + 0.012), hipY - 0.034, pelvisZ + 0.2);
        p.footTurns[side].set(-1.0, x * 0.18, 0);
        p.kneePoles[side].set(x * 0.2, 1, 0.3);
      } else {
        // A suited colleague's shins hang over the seat's edge; its feet do not reach the floor.
        p.feet[side].set(
          x * (anatomy.hip.x + 0.004),
          hipY - anatomy.shin * 0.97,
          pelvisZ + anatomy.thigh * 0.98 + 0.035,
        );
        p.footTurns[side].set(0.25, x * 0.05, 0);
        p.kneePoles[side].set(0, 1, 1);
      }
      this.writeLapHand(p, side);
    }
  }

  /** Rests a hand in the lap: on a bean's belly, on a suited colleague's thigh. */
  private writeLapHand(p: Posture, side: Side): void {
    const x = mirrorX(side);
    if (this.bean) {
      const height = this.anatomy.egg.widestHeight * 0.5;
      p.hands[side].set(x * 0.085, height, this.measureFront(height) + 0.03);
      p.elbowPoles[side].set(x, -0.2, -0.6);
      p.handTurns[side].set(0.3, 0, 0);
    } else {
      const { hip, legRadius } = this.anatomy;
      p.hands[side].set(x * 0.08, hip.y + legRadius + 0.045, 0.15);
      p.elbowPoles[side].set(x * 0.6, 0, -1);
      p.handTurns[side].set(0.5, 0, 0);
    }
  }

  /** Swings a sitting colleague's legs a little: a bean wiggles its feet, a suited one swings its shins. */
  private addLegSwing(p: Posture, t: number, ambient: number): void {
    for (const side of SIDES) {
      const swing = Math.sin(2 * Math.PI * 0.45 * t + side * Math.PI) * ambient;
      if (this.bean) p.footTurns[side].y += mirrorX(side) * 0.14 * swing;
      else p.feet[side].z += 0.025 * swing;
    }
  }

  /**
   * Converts a point in the root's space to the torso's space of posture
   * `p`, so a hand can reach for something in the room. Returns `out`.
   */
  private convertToTorso(p: Posture, point: Vector3, out: Vector3): Vector3 {
    const pelvis = writeTurn(p.pelvisTurn, scratchQuaternion);
    const turn = scratchTorsoTurn.copy(p.torsoTurn);
    if (this.bean) turn.add(p.headTurn);
    const torso = writeTurn(turn, scratchTurn);
    pelvis.multiply(torso);
    scratchMatrix.compose(p.pelvis, pelvis, scratchWorld.set(1, 1, 1)).invert();
    return out.copy(point).applyMatrix4(scratchMatrix);
  }

  private writeTyping(p: Posture, t: number, ambient: number): void {
    this.writeSitting(p);
    p.pelvis.z += this.bean ? 0.06 : 0.03;
    p.torsoTurn.x += this.bean ? 0.17 : 0.2;
    if (!this.bean) p.headTurn.x += 0.14;
    this.addBreath(p, t, ambient, 0.5);
    // Typing comes in bursts, with a short pause to think between them.
    const burst = easeInOut(Math.min(1, 4 * Math.sin(2 * Math.PI * (t / 5.3)) + 3));
    for (const side of SIDES) {
      const x = mirrorX(side);
      const tap = (0.5 + 0.5 * Math.sin(2 * Math.PI * 3.4 * t + side * Math.PI)) * burst * ambient;
      const desk = scratchPoint.set(
        x * 0.1,
        DESK_HEIGHT + this.anatomy.handRadius * 0.5 + 0.014 * tap,
        0.43,
      );
      this.convertToTorso(p, desk, p.hands[side]);
      p.elbowPoles[side].set(x * 0.8, -1, 0);
      p.handTurns[side].set(0.7, 0, 0);
    }
  }

  private writeReading(p: Posture, t: number, ambient: number): void {
    this.writeSitting(p);
    this.addBreath(p, t, ambient, 0.8);
    this.addLegSwing(p, t, ambient * 0.5);
    p.torsoTurn.x += this.bean ? 0.02 : -0.05;
    if (!this.bean) p.headTurn.x += 0.2;
    const paper = this.newspaper;
    // Now and then the paper is shaken straight.
    const shake = Math.max(0, Math.sin(2 * Math.PI * (t / 6.5))) ** 8 * ambient;
    for (const side of SIDES) {
      const x = mirrorX(side);
      p.hands[side].set(
        x * paper.width * 0.42,
        paper.centre.y - paper.height * 0.12 + 0.01 * shake,
        paper.centre.z - 0.03,
      );
      p.elbowPoles[side].set(x * 0.7, -1, -0.3);
      p.handTurns[side].set(-0.2, 0, 0);
    }
  }

  /**
   * Returns where a reader holds the newspaper, in the torso's space, and
   * its size. A bean peeks over the top of it, just below `eyeLine`.
   */
  private placeNewspaper(eyeLine: number): Motion["newspaper"] {
    if (this.bean) {
      const height = 0.15;
      const y = eyeLine - 0.045 - height / 2;
      return { centre: new Vector3(0, y, this.measureFront(y) + 0.1), width: 0.24, height };
    }
    const height = 0.2;
    const y = this.anatomy.shoulder.y - 0.06;
    return { centre: new Vector3(0, y, this.measureFront(y) + 0.13), width: 0.3, height };
  }

  /** Returns how far a sip has lifted the cup, from 0 at the saucer to 1 at the mouth. */
  measureSip(): number {
    if (this.action !== "sip") return 0;
    const cycle = wrapUnit((this.clock + this.seed * 97) / 5.5);
    const lift = 1.6 / 5.5;
    if (cycle > lift) return 0;
    const u = cycle / lift;
    return easeInOut(Math.min(1, u / 0.3)) * easeInOut(Math.min(1, (1 - u) / 0.3));
  }

  private writeSipping(p: Posture, t: number, ambient: number): void {
    this.writeSitting(p);
    this.addBreath(p, t, ambient, 0.8);
    this.addLegSwing(p, t, ambient * 0.5);
    const sip = this.measureSip() * ambient;
    const lap = this.bean ? this.anatomy.egg.widestHeight * 0.42 : this.anatomy.hip.y + 0.11;
    // The right hand holds the saucer; the left lifts the cup from it to the mouth.
    p.hands[1].set(-0.045, lap, this.measureFront(lap) + (this.bean ? 0.07 : 0.1));
    p.elbowPoles[1].set(-1, -0.4, -0.6);
    p.handTurns[1].set(0.9, 0, 0);
    const rest = scratchPoint.set(0.06, lap + 0.07, this.measureFront(lap) + 0.08);
    const mouth = scratchWorld.set(0.05, this.mouth.y + 0.03, this.mouth.z + 0.07);
    p.hands[0].lerpVectors(rest, mouth, sip);
    p.elbowPoles[0].set(1, -0.5, -0.5);
    p.handTurns[0].set(0.6, 0, 0);
    if (this.bean) p.torsoTurn.x -= 0.06 * sip;
    else p.headTurn.x -= 0.12 * sip;
  }

  private writeSleeping(p: Posture, t: number, ambient: number): void {
    this.writeSitting(p);
    p.pelvis.z += 0.02;
    // Slumped back and to one side; deep, slow breaths.
    p.torsoTurn.x -= this.bean ? 0.12 : 0.08;
    p.torsoTurn.z += this.bean ? 0.16 : 0.08;
    if (!this.bean) p.headTurn.set(0.32, 0.1, 0.26);
    const breath = Math.sin(2 * Math.PI * 0.17 * t) * ambient;
    p.squash += (this.bean ? 0.022 : 0.012) * breath;
    for (const side of SIDES) {
      p.footTurns[side].y += mirrorX(side) * 0.3;
      p.hands[side].y += 0.006 * breath;
    }
  }

  /**
   * Turns the head toward the look target, or the camera, or a glance
   * around, smoothly and within a neck's reach. Returns true while it turns.
   */
  private turnToLook(input: MotionInput): boolean {
    let yaw = 0;
    let pitch = 0;
    const yawLimit = this.bean ? 0.6 : 0.85;
    if (input.asleep) {
      // A sleeper looks nowhere.
    } else if (input.look !== null) {
      const local = scratchPoint.copy(input.look).applyMatrix4(this.inverseRoot);
      const headY = this.output.pelvis.y + this.anatomy.neck.y + this.anatomy.egg.height * 0.55;
      local.y -= headY;
      local.z -= this.output.pelvis.z;
      yaw = Math.atan2(local.x, local.z);
      if (Math.abs(yaw) > Math.PI * 0.85) yaw = 0;
      yaw = Math.max(-yawLimit, Math.min(yawLimit, yaw));
      pitch = -Math.atan2(local.y, Math.max(0.1, Math.hypot(local.x, local.z)));
      pitch = Math.max(-0.35, Math.min(0.3, pitch));
    } else if (input.ambient > 0 && this.action !== "walk" && this.action !== "hop") {
      // A glance to one side now and then.
      const slot = Math.floor((this.clock + this.seed * 50) / 4.6);
      const pick = hashUnit(this.seed, slot);
      if (pick > 0.55) yaw = (pick > 0.78 ? 1 : -1) * (0.25 + 0.25 * hashUnit(this.seed, slot + 7));
      yaw *= input.ambient;
    }
    const follow = 1 - Math.exp(-input.dt * 7);
    this.lookYaw += (yaw - this.lookYaw) * follow;
    this.lookPitch += (pitch - this.lookPitch) * follow;
    const turning = Math.abs(yaw - this.lookYaw) > 5e-4 || Math.abs(pitch - this.lookPitch) > 5e-4;
    if (!turning) {
      this.lookYaw = yaw;
      this.lookPitch = pitch;
    }
    const p = this.output;
    if (this.bean) {
      p.torsoTurn.y += this.lookYaw * 0.9;
      p.torsoTurn.x += this.lookPitch * 0.45;
    } else {
      p.headTurn.y += this.lookYaw * 0.75;
      p.torsoTurn.y += this.lookYaw * 0.25;
      p.headTurn.x += this.lookPitch;
    }
    return turning;
  }

  /** Turns posture `p` into bone positions and rotations. */
  private applyPosture(p: Posture): void {
    const { bones, anatomy } = this;
    bones.pelvis.position.copy(p.pelvis);
    writeTurn(p.pelvisTurn, bones.pelvis.quaternion);
    if (this.bean) {
      writeTurn(scratchWorld.copy(p.torsoTurn).add(p.headTurn), bones.torso.quaternion);
      bones.head.quaternion.identity();
    } else {
      writeTurn(p.torsoTurn, bones.torso.quaternion);
      writeTurn(p.headTurn, bones.head.quaternion);
    }
    const squash = this.squash.value;
    const across = 1 / Math.sqrt(squash);
    bones.head.scale.set(across, squash, across);
    for (const side of SIDES) {
      // Arms, in the torso's space.
      solveLimb(
        this.shoulders[side],
        p.hands[side],
        p.elbowPoles[side],
        anatomy.upperArm,
        anatomy.forearm,
        this.limb,
      );
      bones.shoulders[side].quaternion.copy(this.limb.upper);
      bones.elbows[side].quaternion.setFromAxisAngle(AXIS_X, this.limb.bend);
      writeTurn(p.handTurns[side], bones.hands[side].quaternion);
      this.wrists[side].copy(this.limb.end);
      this.forearms[side].copy(this.limb.lowerDirection);
      // Legs, in the root's space; the hips ride on the pelvis but do not squash.
      const hip = bones.hips[side].position
        .copy(this.hipOffsets[side])
        .applyQuaternion(bones.pelvis.quaternion)
        .add(p.pelvis);
      solveLimb(hip, p.feet[side], p.kneePoles[side], anatomy.thigh, anatomy.shin, this.limb);
      bones.hips[side].quaternion.copy(this.limb.upper);
      bones.knees[side].quaternion.setFromAxisAngle(AXIS_X, this.limb.bend);
      const knee = scratchQuaternion.copy(this.limb.upper).multiply(bones.knees[side].quaternion);
      const foot = writeTurn(p.footTurns[side], scratchTurn);
      bones.feet[side].quaternion.copy(knee.invert().multiply(foot));
    }
  }
}

const AXIS_X = new Vector3(1, 0, 0);

/** Returns the yaw of a world matrix: the angle of its +z axis around +y, from +z toward +x. */
function readYaw(matrix: Matrix4): number {
  const e = matrix.elements;
  return Math.atan2(e[8] ?? 0, e[10] ?? 1);
}
