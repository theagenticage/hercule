/**
 * PROTOTYPE - a colleague's 3D body: the Bureau crew's egg on short legs
 * (`bean`), or the same face on a grown-up figure in a suit (`suited`).
 *
 * A rig is a skeleton of seventeen bones and two or three skinned meshes,
 * each painted in vertex colours so it costs one draw call: the body in
 * vinyl (the hue, its shade and tint, shoes and bowtie), the face in gloss
 * (features, badge and brass), and a hat in satin if it wears one. The
 * geometry is shared by every rig with the same look, so a rig owns only
 * its bones and a few small props, hidden until used: a cup and saucer, a
 * newspaper, the marigold palm, the sleeper's Zs, a magnifying glass for
 * Triage, and the selection ring on the floor.
 *
 * `motion.ts` moves the bones; `face.ts` draws the face; `parts.ts` builds
 * the shapes; `anatomy.ts` sizes them.
 */
import {
  Bone,
  type BufferGeometry,
  type Camera,
  Group,
  type Material,
  Matrix4,
  Mesh,
  type Object3D,
  Quaternion,
  Skeleton,
  SkinnedMesh,
  Sphere,
  Vector3,
} from "three";
import type { BuildColleagueRig, ColleagueRig } from "../../engine/contracts";
import { paint, paintHue, paintVertexColors } from "../../engine/palette";
import type { Pose } from "../../world/types";
import { readAnatomy, type Anatomy } from "./anatomy";
import { hasOpenEyes, readEyeCentre, readFaceGeometry } from "./face";
import { Motion, Spring, isSittingAction, measureDamping, type RigBones } from "./motion";
import {
  BONE,
  BONE_PARENTS,
  buildCup,
  buildDome,
  buildLens,
  buildLetterZ,
  buildLoupe,
  buildNewspaper,
  buildSaucer,
  buildSelectionRing,
  measureHatHeight,
  readBodyGeometry,
} from "./parts";

let ambientMotion = true;

/**
 * Turns the colleagues' ambient motion on or off for every rig: breathing,
 * typing, glancing around. With it off, a rig whose action has settled
 * stops moving, and its `update` returns false, so the office draws no
 * frames while nothing happens.
 */
export function setAmbientMotion(enabled: boolean): void {
  ambientMotion = enabled;
}

/** How long ambient motion takes to fade in or out, in seconds. */
const AMBIENT_FADE_SECONDS = 0.32;
/** How long a blink takes, in seconds; a new face is swapped in while the eyes are shut. */
const BLINK_SECONDS = 0.16;
/** How long a held prop takes to appear or disappear, in seconds. */
const PROP_FADE_SECONDS = 0.2;

/** The box every rig's skinned meshes stay inside, standing, sitting or with an arm up. */
const RIG_BOUNDS = new Sphere(new Vector3(0, 0.66, 0.05), 0.84);

/** The last camera position a colleague was drawn from, for the glance at the camera on hover. */
const lastCameraPosition = new Vector3();
let hasCameraPosition = false;

/** Records where the camera is, each time a colleague's body is drawn. */
function recordCamera(camera: Camera): void {
  if (!("isPerspectiveCamera" in camera)) return;
  lastCameraPosition.setFromMatrixPosition(camera.matrixWorld);
  hasCameraPosition = true;
}

const billboardPosition = new Vector3();
const billboardScale = new Vector3();
const billboardTurn = new Quaternion();

/** Turns a mesh to face the camera as it is drawn, keeping its place and size. */
function faceCamera(mesh: Object3D, camera: Camera): void {
  mesh.matrixWorld.decompose(billboardPosition, billboardTurn, billboardScale);
  camera.getWorldQuaternion(billboardTurn);
  mesh.matrixWorld.compose(billboardPosition, billboardTurn, billboardScale);
}

/** Returns a smooth ease from 0 to 1. */
function easeInOut(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** A prop that eases in and out of view by scaling. */
class Presence {
  value = 0;
  target = 0;
  readonly mesh: Object3D;

  constructor(mesh: Object3D) {
    this.mesh = mesh;
    mesh.visible = false;
  }

  /** Moves the fade one frame on. Returns true while it still changes. */
  update(dt: number): boolean {
    if (this.value === this.target) return false;
    const step = dt / PROP_FADE_SECONDS;
    this.value =
      this.target > this.value
        ? Math.min(this.target, this.value + step)
        : Math.max(this.target, this.value - step);
    this.mesh.visible = this.value > 0;
    this.mesh.scale.setScalar(Math.max(1e-3, easeInOut(this.value)));
    return true;
  }
}

// Geometry shared by every rig, built when the first rig needs it.
let cupGeometry: BufferGeometry | null = null;
let saucerGeometry: BufferGeometry | null = null;
let loupeGeometry: BufferGeometry | null = null;
let lensGeometry: BufferGeometry | null = null;
let letterGeometry: BufferGeometry | null = null;
const palmGeometries = new Map<number, BufferGeometry>();
const ringGeometries = new Map<number, BufferGeometry>();
const newspaperGeometries = new Map<string, BufferGeometry>();

/**
 * Returns the marigold palm for a mitten of `radius`: a low pad on the left
 * hand's palm side (+x), which faces forward while the hand is raised.
 */
function readPalmGeometry(radius: number): BufferGeometry {
  let geometry = palmGeometries.get(radius);
  if (geometry === undefined) {
    geometry = buildDome(radius * 0.62, radius * 0.7, radius * 0.28, 12);
    geometry.rotateY(Math.PI / 2);
    geometry.translate(radius * 0.58, -radius * 0.72, 0);
    palmGeometries.set(radius, geometry);
  }
  return geometry;
}

/** Returns the selection ring of `radius`, rounded to the centimetre so rigs share it. */
function readRingGeometry(radius: number): BufferGeometry {
  const key = Math.round(radius * 100);
  let geometry = ringGeometries.get(key);
  if (geometry === undefined) {
    geometry = buildSelectionRing(key / 100);
    ringGeometries.set(key, geometry);
  }
  return geometry;
}

/** Returns a newspaper `width` by `height`. */
function readNewspaperGeometry(width: number, height: number): BufferGeometry {
  const key = `${width}x${height}`;
  let geometry = newspaperGeometries.get(key);
  if (geometry === undefined) {
    geometry = buildNewspaper(width, height);
    newspaperGeometries.set(key, geometry);
  }
  return geometry;
}

/** Creates the rig's bones, parented as `BONE_PARENTS` says, with their fixed offsets. */
function createBones(anatomy: Anatomy, root: Object3D): { list: Bone[]; named: RigBones } {
  const list = BONE_PARENTS.map(() => new Bone());
  const bone = (index: number): Bone => list[index]!;
  BONE_PARENTS.forEach((parent, index) => {
    if (parent < 0) root.add(bone(index));
    else bone(parent).add(bone(index));
  });
  const { neck, upperArm, forearm, thigh, shin, egg } = anatomy;
  bone(BONE.head).position.set(neck.x, neck.y, neck.z);
  for (const index of [BONE.elbowL, BONE.elbowR]) bone(index).position.set(0, -upperArm, 0);
  for (const index of [BONE.handL, BONE.handR]) bone(index).position.set(0, -forearm, 0);
  for (const index of [BONE.kneeL, BONE.kneeR]) bone(index).position.set(0, -thigh, 0);
  for (const index of [BONE.footL, BONE.footR]) bone(index).position.set(0, -shin, 0);
  bone(BONE.eyeL).position.copy(readEyeCentre(egg, "left"));
  bone(BONE.eyeR).position.copy(readEyeCentre(egg, "right"));
  const named: RigBones = {
    pelvis: bone(BONE.pelvis),
    torso: bone(BONE.torso),
    head: bone(BONE.head),
    shoulders: [bone(BONE.shoulderL), bone(BONE.shoulderR)],
    elbows: [bone(BONE.elbowL), bone(BONE.elbowR)],
    hands: [bone(BONE.handL), bone(BONE.handR)],
    hips: [bone(BONE.hipL), bone(BONE.hipR)],
    knees: [bone(BONE.kneeL), bone(BONE.kneeR)],
    feet: [bone(BONE.footL), bone(BONE.footR)],
  };
  return { list, named };
}

/** Creates a skinned mesh on `skeleton` whose bones carry its parts as they are. */
function createSkinnedMesh(
  geometry: BufferGeometry,
  material: Material | Material[],
  skeleton: Skeleton,
): SkinnedMesh {
  const mesh = new SkinnedMesh(geometry, material);
  // Each part is built in its bone's own space, so nothing needs unbinding.
  mesh.bind(skeleton, new Matrix4());
  mesh.boundingSphere = RIG_BOUNDS;
  return mesh;
}

const scratchHold = new Vector3();

export const buildColleagueRig: BuildColleagueRig = (colleague, style) => {
  const { look } = colleague;
  const anatomy = readAnatomy(style, look.shape);
  const build = { anatomy, accessories: look.accessories, headwear: look.headwear };
  const object = new Group();
  object.name = `colleague ${colleague.id}`;
  const { list: boneList, named: bones } = createBones(anatomy, object);
  const skeleton = new Skeleton(
    boneList,
    boneList.map(() => new Matrix4()),
  );

  const geometry = readBodyGeometry(build, look.hue);
  const body = createSkinnedMesh(geometry.body, paintVertexColors("vinyl"), skeleton);
  body.onBeforeRender = (_renderer, _scene, camera) => recordCamera(camera);
  const hat =
    geometry.hat === null
      ? null
      : createSkinnedMesh(geometry.hat, paintVertexColors("satin"), skeleton);
  for (const mesh of [body, hat]) {
    if (mesh === null) continue;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    object.add(mesh);
  }

  let shownPose: Pose = "idle";
  let nextPose: Pose | null = null;
  const face = createSkinnedMesh(
    readFaceGeometry(anatomy, shownPose, look.accessories),
    paintVertexColors("gloss"),
    skeleton,
  );
  // The features lie flat on the body, which throws the shadow for them.
  face.receiveShadow = true;
  object.add(face);
  const eyes = [boneList[BONE.eyeL]!, boneList[BONE.eyeR]!];

  const motion = new Motion(anatomy, bones, object, colleague.id);
  const hatHeight = measureHatHeight(build);

  // The props a colleague holds now and then.
  const porcelain = paint("room-paper", "gloss");
  cupGeometry ??= buildCup();
  saucerGeometry ??= buildSaucer();
  const cup = new Presence(new Mesh(cupGeometry, porcelain));
  const saucer = new Presence(new Mesh(saucerGeometry, porcelain));
  const paper = motion.newspaper;
  const newspaper = new Presence(
    new Mesh(readNewspaperGeometry(paper.width, paper.height), paint("room-paper", "paper")),
  );
  newspaper.mesh.position.copy(paper.centre);
  newspaper.mesh.rotation.x = -0.12;
  const palm = new Presence(
    new Mesh(readPalmGeometry(anatomy.handRadius), paintHue("you", "body", "vinyl")),
  );
  bones.hands[0].add(palm.mesh);
  for (const prop of [cup, saucer, newspaper]) {
    prop.mesh.castShadow = prop === newspaper;
    bones.torso.add(prop.mesh);
  }

  // Triage's mark: a brass magnifying glass in the right hand.
  let loupe: Presence | null = null;
  if (colleague.role === "triage") {
    loupeGeometry ??= buildLoupe();
    lensGeometry ??= buildLens();
    const frame = new Mesh(loupeGeometry, paint("brass", "brass"));
    frame.add(new Mesh(lensGeometry, paint("surface", "glass")));
    // Held loosely by the handle, the lens hanging below the fist and facing forward.
    const grip = new Group();
    grip.position.set(0, -anatomy.handRadius * 0.75, 0);
    frame.position.set(0, -0.09, 0);
    frame.rotation.z = Math.PI;
    grip.add(frame);
    bones.hands[1].add(grip);
    loupe = new Presence(grip);
  }

  // The sleeper's Zs, which always face the camera.
  letterGeometry ??= buildLetterZ(1);
  const letters = [0, 1].map(() => {
    const letter = new Mesh(letterGeometry!, paint("muted", "matte"));
    letter.frustumCulled = false;
    letter.onBeforeRender = (_renderer, _scene, camera) => faceCamera(letter, camera);
    object.add(letter);
    return new Presence(letter);
  });

  // The selection ring, flat on the floor.
  const ringRadius =
    Math.max(anatomy.egg.halfWidth, anatomy.jacket?.halfWidth ?? 0) +
    (style === "bean" ? 0.12 : 0.14);
  const ring = new Mesh(readRingGeometry(ringRadius), paint("accent", "matte"));
  ring.position.y = 0.006;
  ring.visible = false;
  ring.renderOrder = 1;
  object.add(ring);
  const ringScale = new Spring(0, 220, measureDamping(220, 0.42));
  const notice = new Spring(0, 180, measureDamping(180, 0.4));

  let ambient = ambientMotion ? 1 : 0;
  let blinkClock = -1;
  let nextBlink = 1.5 + Math.random() * 3;
  let hovered = false;
  const lookTarget = new Vector3();
  let hasLookTarget = false;
  let letterClock = 0;

  /** Swaps in the face of `pose`: its features and its badge. */
  const showPose = (pose: Pose): void => {
    shownPose = pose;
    face.geometry = readFaceGeometry(anatomy, pose, look.accessories);
  };

  /** Moves the blink on; returns true while the eyes are closing or opening. */
  const updateBlink = (dt: number): boolean => {
    if (blinkClock < 0 && ambient > 0 && hasOpenEyes(shownPose)) {
      nextBlink -= dt;
      if (nextBlink <= 0) {
        blinkClock = 0;
        nextBlink = 2.5 + Math.random() * 3.5;
      }
    }
    if (blinkClock < 0) return false;
    blinkClock += dt;
    const u = Math.min(1, blinkClock / BLINK_SECONDS);
    if (u >= 0.5 && nextPose !== null) {
      showPose(nextPose);
      nextPose = null;
    }
    const open = 1 - 0.92 * Math.sin(Math.PI * u);
    for (const eye of eyes) eye.scale.set(1, open, 1);
    if (u >= 1) blinkClock = -1;
    return true;
  };

  /** Places the held props at the hands. Returns true while one still fades. */
  const updateProps = (dt: number): boolean => {
    const action = motion.readAction();
    cup.target = action === "sip" ? 1 : 0;
    saucer.target = action === "sip" ? 1 : 0;
    newspaper.target = action === "read" ? 1 : 0;
    palm.target = action === "raise-hand" ? 1 : 0;
    if (loupe !== null) {
      // The magnifying glass is put away while the right hand is busy.
      loupe.target = isSittingAction(action) && action !== "sit" ? 0 : 1;
    }
    let fading = false;
    for (const prop of [cup, saucer, newspaper, palm, loupe]) {
      if (prop !== null) fading = prop.update(dt) || fading;
    }
    if (saucer.mesh.visible) {
      const hand = readMitten(1, scratchHold);
      saucer.mesh.position.set(hand.x + 0.012, hand.y + anatomy.handRadius * 0.62, hand.z + 0.01);
      const sip = motion.measureSip() * ambient;
      const holder = readMitten(0, scratchHold);
      // The cup rests on the saucer, and is lifted from it by the left hand.
      cup.mesh.position
        .copy(saucer.mesh.position)
        .setY(saucer.mesh.position.y + 0.007)
        .lerp(holder.set(holder.x - 0.05, holder.y - 0.03, holder.z + 0.005), sip);
      cup.mesh.rotation.set(-0.55 * sip, 0, 0);
    }
    return fading;
  };

  /** Returns the centre of a mitten, in the torso's space. Writes it to `out`. */
  const readMitten = (side: 0 | 1, out: Vector3): Vector3 =>
    out.copy(motion.wrists[side]).addScaledVector(motion.forearms[side], anatomy.handRadius * 0.75);

  /** Floats the Zs up from above a sleeper's head. Returns true while they move. */
  const updateLetters = (dt: number): boolean => {
    const asleep = shownPose === "asleep";
    let moving = false;
    letterClock += dt * ambient;
    const crown = motion.measureCrown() + hatHeight;
    letters.forEach((letter, index) => {
      letter.target = asleep ? 1 : 0;
      moving = letter.update(dt) || moving;
      if (!letter.mesh.visible) return;
      // Each Z rises and shrinks away; with no ambient motion they hold still.
      const cycle = ambient > 0 ? (letterClock / 2.8 + index * 0.5) % 1 : index === 0 ? 0.25 : 0.7;
      const size = (index === 0 ? 0.075 : 0.055) * Math.sin(Math.PI * Math.min(1, cycle * 1.15));
      letter.mesh.position.set(0.1 + 0.07 * cycle, crown + 0.05 + 0.2 * cycle, 0.02);
      letter.mesh.scale.setScalar(Math.max(1e-3, size * easeInOut(letter.value)));
      if (asleep && ambient > 0) moving = true;
    });
    return moving;
  };

  const rig: ColleagueRig = {
    colleague,
    object,
    get headHeight() {
      return motion.measureCrown() + hatHeight;
    },
    setAction(action) {
      motion.setAction(action);
    },
    setFace(pose) {
      if (pose === (nextPose ?? shownPose)) return;
      nextPose = pose === shownPose ? null : pose;
      if (blinkClock < 0) blinkClock = 0;
    },
    setWalkSpeed(speed) {
      motion.setWalkSpeed(speed);
    },
    lookAt(point) {
      hasLookTarget = point !== null;
      if (point !== null) lookTarget.copy(point);
    },
    setHovered(next) {
      hovered = next;
      notice.target = next ? 1 : 0;
    },
    setSelected(selected) {
      ringScale.target = selected ? 1 : 0;
    },
    update(frame) {
      const { dt } = frame;
      let moving = false;
      const ambientTarget = ambientMotion ? 1 : 0;
      if (ambient !== ambientTarget) {
        const step = dt / AMBIENT_FADE_SECONDS;
        ambient =
          ambientTarget > ambient ? Math.min(1, ambient + step) : Math.max(0, ambient - step);
        moving = true;
      }
      moving = notice.update(dt) || moving;
      const ringMoving = ringScale.update(dt);
      // The settling frame snaps the spring to its target, so it is drawn too.
      if (ringMoving || ring.visible) {
        ring.visible = ringScale.value > 0.01;
        ring.scale.setScalar(Math.max(1e-3, ringScale.value));
      }
      moving = ringMoving || moving;
      const glance = hovered && hasCameraPosition ? lastCameraPosition : null;
      moving =
        motion.update({
          dt,
          ambient: easeInOut(ambient),
          notice: notice.value,
          look: glance ?? (hasLookTarget ? lookTarget : null),
          asleep: shownPose === "asleep" || motion.readAction() === "sleep",
        }) || moving;
      moving = updateBlink(dt) || moving;
      moving = updateProps(dt) || moving;
      moving = updateLetters(dt) || moving;
      return moving;
    },
    dispose() {
      object.removeFromParent();
      skeleton.dispose();
    },
  };
  return rig;
};
