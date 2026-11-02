/**
 * PROTOTYPE - the source of `office-kit.js`, the 3D Office kit for design
 * drawings. `build-office-kit.ts` bundles this file, the desktop app's real
 * Office kit it imports, and three.js into one classic script that defines
 * two globals: `THREE` and `OfficeKit`. See ../OFFICE-KIT.md.
 *
 * Everything that draws (the colleagues, the props, the architecture, the
 * palette and the stage with its lights) is the app's own code, imported
 * from apps/desktop/src/renderer/office. Only the helper layer below is new:
 * the app drives its colleagues with a simulation and a camera rig that
 * need the whole Office, so the drawings get a small stand-in for each.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import tokensCss from "../../../../apps/desktop/src/renderer/styles/tokens.css?raw";
import overlayCss from "../../../../apps/desktop/src/renderer/office/engine/overlay.css?raw";
import { clearCaches } from "../../../../apps/desktop/src/renderer/office/engine/caches";
import { addContactShadow } from "../../../../apps/desktop/src/renderer/office/engine/contact-shadow";
import {
  CUTAWAY,
  CUTAWAY_HEIGHT,
  DESK_HEIGHT,
  LAMP,
  SEAT_HEIGHT,
  WALK_SPEED,
  WALL_HEIGHT,
  type Action,
  type ColleagueRig,
  type Cutaway,
  type DeskHandle,
  type Lamp,
} from "../../../../apps/desktop/src/renderer/office/engine/contracts";
import {
  isDarkTheme,
  paint,
  paintHue,
  paintVertexColors,
  readColor,
  readHue,
  readToken,
  refreshPalette,
  subscribePalette,
  writeOklch,
} from "../../../../apps/desktop/src/renderer/office/engine/palette";
import { Stage, type Frame } from "../../../../apps/desktop/src/renderer/office/engine/stage";
import {
  buildFloor,
  buildLamppost,
  buildLawn,
  buildPath,
  buildPlaque,
  buildSideStreet,
  buildWall,
  WALL_THICKNESS,
} from "../../../../apps/desktop/src/renderer/office/kit/architecture";
import {
  buildColleagueRig,
  setAmbientMotion,
} from "../../../../apps/desktop/src/renderer/office/kit/character";
import * as props from "../../../../apps/desktop/src/renderer/office/kit/props";
import {
  buildAssistantLook,
  buildLook,
  buildSessionLook,
  hashSeed,
  HEADWEAR,
  HERCULE_LOOK,
  HUES,
  SHAPES,
  WARDROBE,
  type Hue,
  type Look,
} from "../../../../apps/desktop/src/renderer/faces/look";

// ---------------------------------------------------------------------------
// Tokens and styles.

/** A colleague's state, as its face shows it: the app's `OfficePose`. */
type Pose = "working" | "waiting" | "idle" | "asleep" | "away" | "done";

/**
 * Makes sure the page has the app's colour tokens, which the kit's palette
 * reads from <html>. A drawing that links crew-bureau-2/tokens.css already
 * has them; for any other page the bundled copy is put first in <head>, so
 * the page's own stylesheets still win. The overlay's tag styles go in the
 * same way, once.
 */
function ensureStyles(): void {
  if (document.getElementById("office-kit-styles") !== null) return;
  const style = document.createElement("style");
  style.id = "office-kit-styles";
  const hasTokens =
    getComputedStyle(document.documentElement).getPropertyValue("--room-floor").trim() !== "";
  // The bundled tokens' fonts load relative to the app, not to the page, so they are left out.
  const tokens = hasTokens ? "" : tokensCss.replace(/@font-face\s*\{[^}]*\}/g, "");
  // The kit's own label rules come before the app's overlay styles, so an app tag keeps its
  // own offset from the point it labels.
  style.textContent = `${tokens}
.office-kit-labels { position: absolute; inset: 0; pointer-events: none; overflow: hidden; contain: strict; }
.office-kit-label { position: absolute; top: 0; left: 0; white-space: nowrap; translate: -50% -100%; will-change: transform; }
.office-kit-label:not(.is-shown) { visibility: hidden; }
${overlayCss}
/* A blur behind a tag would make the browser composite the whole canvas under it on every frame. */
.office-kit-labels .office-room-label { backdrop-filter: none; background: var(--raised); }
`;
  document.head.prepend(style);
}

/** Returns `build` wrapped so the page has the tokens before it paints anything. */
function withStyles<A extends unknown[], R>(build: (...args: A) => R): (...args: A) => R {
  return (...args) => {
    ensureStyles();
    return build(...args);
  };
}

// ---------------------------------------------------------------------------
// Colleagues.

/** A colleague's kind of work, which picks what it wears on its head. */
type ColleagueKind = "thread" | "run" | "agent" | "assistant";

interface ColleagueOptions {
  /** The seed of the look: a session id or an assistant id. Any string works. */
  readonly id: string;
  /** Default "thread": bare head. "run" wears a visor, "agent" a flat cap, "assistant" a hat. */
  readonly kind?: ColleagueKind;
  /** Default "working". */
  readonly pose?: Pose;
  /** An action that overrides the one the pose picks. */
  readonly action?: Action;
  /** Overrides parts of the look the id picks, such as `{ hue: "teal" }`. */
  readonly look?: Partial<Look>;
}

/** Where a colleague belongs: a seat, in world space, and what the seat is. */
interface SeatSpot {
  readonly position: THREE.Vector3;
  readonly facing: number;
  readonly desk: DeskHandle | null;
}

/** A straight walk under way. */
interface Walk {
  readonly to: THREE.Vector3;
  readonly facing: number | null;
  readonly speed: number;
  readonly done: () => void;
}

/** The colleague object `OfficeKit.colleague` returns: a three.js Group with these extras. */
interface ColleagueObject extends THREE.Group {
  readonly colleagueId: string;
  readonly look: Look;
  readonly rig: ColleagueRig;
  readonly pose: Pose;
  readonly action: Action;
  readonly headHeight: number;
  setPose(pose: Pose): void;
  play(action: Action | null): void;
  sitAt(seat: SeatTarget, index?: number): void;
  standAt(x: number, z: number, facing?: number): void;
  walkTo(x: number, z: number, facing?: number, speed?: number): Promise<void>;
  update(frame: Frame): boolean;
}

/** Anything a colleague can sit on: a desk, an armchair, one seat of a bench or a table, or a marker. */
type SeatTarget =
  | DeskHandle
  | { readonly seatMarker: THREE.Object3D }
  | { readonly seatMarkers: ReadonlyArray<THREE.Object3D> }
  | THREE.Object3D;

/** The facing of a colleague waiting beside its seat: toward the default camera, as in the app. */
const BESIDE_FACING = Math.PI / 4;
/** Where a waiting colleague stands beside its seat: metres sideways and forward in the seat's frame. */
const BESIDE_SEAT = [0.85, 0.15] as const;
/** How fast a heading closes in on its target, and the fastest turn, as the app's sim turns. */
const TURN_RATE = 9;
const MAX_TURN_SPEED = 6.5;

/** Every colleague object `OfficeKit.colleague` made, so a stage can tell one from a prop. */
const colleagueObjects = new WeakSet<THREE.Object3D>();
/** The callback each colleague calls when it changes, set by the stage it is added to. */
const changeListeners = new WeakMap<THREE.Object3D, () => void>();

/** Returns `angle` wrapped into (-PI, PI]. */
function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/** Returns the look of a colleague with `id` and `kind`, as the app picks it. */
function decideLook(id: string, kind: ColleagueKind): Look {
  return kind === "assistant" ? buildAssistantLook(id) : buildSessionLook(id, kind);
}

/** Returns the world spot of a seat marker: where to stand to sit, and the way to face. */
function readSeatSpot(marker: THREE.Object3D, desk: DeskHandle | null): SeatSpot {
  // A prop in a stage's still building only gets its matrix recomputed between frames.
  for (let node: THREE.Object3D | null = marker; node !== null; node = node.parent) {
    node.updateMatrix();
  }
  marker.updateWorldMatrix(true, false);
  const position = marker.getWorldPosition(new THREE.Vector3());
  const direction = marker.getWorldDirection(new THREE.Vector3());
  return { position, facing: Math.atan2(direction.x, direction.z), desk };
}

/** Returns the marker and desk of anything a colleague can sit on. */
function resolveSeat(target: SeatTarget, index: number): SeatSpot {
  if ("setLamp" in target) return readSeatSpot(target.seatMarker, target);
  if ("seatMarkers" in target) {
    const marker = target.seatMarkers[index];
    if (marker === undefined) {
      throw new Error(
        `OfficeKit: this prop has ${String(target.seatMarkers.length)} seats, so seat ${String(index)} does not exist. Pass an index from 0.`,
      );
    }
    return readSeatSpot(marker, null);
  }
  if ("seatMarker" in target) return readSeatSpot(target.seatMarker, null);
  return readSeatSpot(target, null);
}

/**
 * Builds a colleague: the app's bean rig with its contact shadow, plus the
 * few steps of the app's sim a drawing needs (sit at a desk and type,
 * stand and raise a hand, sip, doze, walk in a straight line).
 */
function buildColleague(options: ColleagueOptions): ColleagueObject {
  ensureStyles();
  const id = options.id;
  const look: Look = Object.freeze({ ...decideLook(id, options.kind ?? "thread"), ...options.look });
  const rig = buildColleagueRig({ id, look } as Parameters<typeof buildColleagueRig>[0]);
  addContactShadow(rig.object);
  const object = rig.object as ColleagueObject;

  let pose: Pose = options.pose ?? "working";
  let explicit: Action | null = options.action ?? null;
  let action: Action = "stand";
  let seat: SeatSpot | null = null;
  /** True while the colleague waits beside its seat rather than on it. */
  let beside = false;
  let walk: Walk | null = null;
  let yaw = 0;

  const notify = (): void => changeListeners.get(object)?.();

  const decideAction = (): Action => {
    if (walk !== null) return "walk";
    if (explicit !== null) return explicit;
    if (seat === null || beside) return pose === "waiting" ? "raise-hand" : "stand";
    switch (pose) {
      case "asleep":
      case "away":
        return "doze";
      case "working":
        return seat.desk !== null ? "type" : "read";
      case "idle":
      case "done":
        return "sip";
      case "waiting":
        return "raise-hand";
    }
  };

  /** Shows the pose on the face, the action on the body, and the desk's lamp, note and cup. */
  const apply = (): void => {
    rig.setFace(pose);
    action = decideAction();
    rig.setAction(action);
    if (seat?.desk != null) {
      seat.desk.setLamp(pose === "working");
      seat.desk.setNote(pose === "waiting");
      seat.desk.setCup(action === "sip");
    }
    notify();
  };

  /** Leaves the seat, putting out its desk's lamp, note and cup. */
  const leaveSeat = (): void => {
    seat?.desk?.setLamp(false);
    seat?.desk?.setNote(false);
    seat?.desk?.setCup(false);
    seat = null;
    beside = false;
  };

  const placeAt = (position: THREE.Vector3, facing: number): void => {
    object.position.copy(position);
    yaw = wrapAngle(facing);
    object.rotation.y = yaw;
  };

  /** Returns the spot beside `spot` where a waiting colleague stands. */
  const findBesideSpot = (spot: SeatSpot): THREE.Vector3 => {
    const forwardX = Math.sin(spot.facing);
    const forwardZ = Math.cos(spot.facing);
    const [sideways, forward] = BESIDE_SEAT;
    return new THREE.Vector3(
      spot.position.x + forwardZ * sideways + forwardX * forward,
      spot.position.y,
      spot.position.z - forwardX * sideways + forwardZ * forward,
    );
  };

  const startWalk = (to: THREE.Vector3, facing: number | null, speed: number): Promise<void> => {
    walk?.done();
    return new Promise((resolve) => {
      walk = { to: to.clone(), facing, speed, done: resolve };
      rig.setWalkSpeed(speed);
      apply();
    });
  };

  /**
   * Puts a seated colleague where its pose wants it, as the app's sim does:
   * a waiting one steps beside its seat and raises a hand, and one that is
   * answered steps back and sits. Then shows the pose and its action.
   */
  const settle = (): void => {
    if (seat !== null && walk === null && beside !== (pose === "waiting")) {
      beside = pose === "waiting";
      const to = beside ? findBesideSpot(seat) : seat.position;
      void startWalk(to, seat.facing + (beside ? BESIDE_FACING : 0), WALK_SPEED * 0.6);
      return;
    }
    apply();
  };

  /** Turns toward `target` one frame on. Returns the angle still to turn. */
  const turnToward = (target: number, dt: number): number => {
    const difference = wrapAngle(target - yaw);
    const limit = MAX_TURN_SPEED * dt;
    const step = Math.max(-limit, Math.min(limit, difference * (1 - Math.exp(-TURN_RATE * dt))));
    const rest = Math.abs(difference - step) < 0.004 ? 0 : difference - step;
    yaw = wrapAngle(target - rest);
    object.rotation.y = yaw;
    return rest;
  };

  /** Moves a walk one frame on. Returns true while it goes on. */
  const stepWalk = (current: Walk, dt: number): boolean => {
    const position = object.position;
    const dx = current.to.x - position.x;
    const dz = current.to.z - position.z;
    const distance = Math.hypot(dx, dz);
    if (distance > 0.005) {
      turnToward(Math.atan2(dx, dz), dt);
      const advance = Math.min(distance, current.speed * dt);
      position.x += (dx / distance) * advance;
      position.z += (dz / distance) * advance;
      position.y = current.to.y;
      return true;
    }
    if (current.facing !== null && turnToward(current.facing, dt) !== 0) return true;
    walk = null;
    settle();
    current.done();
    return false;
  };

  Object.defineProperties(object, {
    colleagueId: { value: id },
    look: { value: look },
    rig: { value: rig },
    pose: { get: () => pose },
    action: { get: () => action },
    headHeight: { get: () => rig.headHeight },
  });

  object.setPose = (next) => {
    pose = next;
    settle();
  };

  object.play = (next) => {
    explicit = next;
    apply();
  };

  object.sitAt = (target, index = 0) => {
    walk?.done();
    walk = null;
    leaveSeat();
    seat = resolveSeat(target, index);
    beside = pose === "waiting";
    if (beside) placeAt(findBesideSpot(seat), seat.facing + BESIDE_FACING);
    else placeAt(seat.position, seat.facing);
    apply();
  };

  object.standAt = (x, z, facing = 0) => {
    walk?.done();
    walk = null;
    leaveSeat();
    placeAt(new THREE.Vector3(x, object.position.y, z), facing);
    apply();
  };

  object.walkTo = (x, z, facing, speed = WALK_SPEED) => {
    leaveSeat();
    return startWalk(new THREE.Vector3(x, object.position.y, z), facing ?? null, speed);
  };

  object.update = (frame) => {
    let moving = false;
    if (walk !== null) moving = stepWalk(walk, frame.dt);
    return rig.update(frame) || moving;
  };

  colleagueObjects.add(object);
  apply();
  return object;
}

/**
 * Builds the app's name tag markup, as engine/overlay.ts writes it: a pill
 * with the colleague's hue dot, its name and its state. A waiting tag turns
 * marigold. Pass the returned element to `stage.label`.
 */
function buildTag(options: {
  readonly name: string;
  readonly state?: string;
  readonly hue: Hue;
  readonly waiting?: boolean;
}): HTMLElement {
  ensureStyles();
  const element = document.createElement("div");
  element.className = "office-tag";
  element.style.setProperty("--hue", `var(--hue-${options.hue})`);
  const dot = document.createElement("i");
  dot.className = "office-tag__dot";
  const name = document.createElement("b");
  name.className = "office-tag__name";
  name.textContent = options.name;
  const state = document.createElement("span");
  state.className = "office-tag__state";
  state.textContent = options.state ?? "";
  element.replaceChildren(dot, name, state);
  element.classList.toggle("office-tag--waiting", options.waiting === true);
  return element;
}

// ---------------------------------------------------------------------------
// A room.

type Side = "north" | "south" | "east" | "west";

interface RoomOptions {
  /** Wall middle to wall middle along x, in metres. Default 8. */
  readonly width?: number;
  /** Wall middle to wall middle along z, in metres. Default 6. */
  readonly depth?: number;
  /** A project's tint for the floor's inlaid border, or null for the plain inlay. */
  readonly tint?: "webshop" | "payments" | "ops" | null;
  /** Windows along the north wall. Default true. */
  readonly windows?: boolean;
  /** One doorway: its wall, its centre along the wall from the wall's middle, and its width. Null for none. */
  readonly door?: { readonly wall: Side; readonly at?: number; readonly width?: number } | null;
}

/**
 * Builds one room as the app's Bureau builds a project room's shell: a
 * parquet floor whose Deco border is inlaid in the project's tint, and four
 * panelled walls that the stage lowers to the dado rail when they stand
 * between the camera and the room. The origin is the middle of the floor.
 */
function buildRoom(options: RoomOptions = {}): THREE.Group {
  ensureStyles();
  const width = options.width ?? 8;
  const depth = options.depth ?? 6;
  const tint = options.tint ?? null;
  const door = options.door === undefined ? { wall: "south" as const } : options.door;
  const room = new THREE.Group();
  room.name = "room";
  room.add(buildFloor(width, depth, tint === null ? {} : { inlay: `proj-${tint}` }));
  // Walls along x run through the corners; walls along z stop at their faces, a hair lower,
  // so two caps never lie in one plane. Each wall's outward side is its local +z.
  const walls: ReadonlyArray<{
    readonly side: Side;
    readonly length: number;
    readonly x: number;
    readonly z: number;
    readonly rotation: number;
    readonly height: number;
  }> = [
    { side: "north", length: width + WALL_THICKNESS, x: 0, z: -depth / 2, rotation: Math.PI, height: WALL_HEIGHT },
    { side: "south", length: width + WALL_THICKNESS, x: 0, z: depth / 2, rotation: 0, height: WALL_HEIGHT },
    { side: "east", length: depth - WALL_THICKNESS, x: width / 2, z: 0, rotation: Math.PI / 2, height: WALL_HEIGHT - 0.004 },
    { side: "west", length: depth - WALL_THICKNESS, x: -width / 2, z: 0, rotation: -Math.PI / 2, height: WALL_HEIGHT - 0.004 },
  ];
  for (const wall of walls) {
    const doors =
      door !== null && door.wall === wall.side ? [{ at: door.at ?? 0, width: door.width ?? 1.0 }] : [];
    const object = buildWall(wall.length, {
      height: wall.height,
      doors,
      windows: options.windows !== false && wall.side === "north",
      cutaway: { roomId: "room", exterior: true },
    });
    object.rotation.y = wall.rotation;
    object.position.set(wall.x, 0, wall.z);
    room.add(object);
  }
  return room;
}

// ---------------------------------------------------------------------------
// The stage.

type Point = THREE.Vector3 | readonly [number, number, number];

interface View {
  readonly target?: Point;
  readonly distance?: number;
  /** Degrees around the y axis, from +z toward +x. The app's room view uses 38. */
  readonly azimuth?: number;
  /** Degrees above the horizon, 18 to 72. The app's room view uses 52. */
  readonly elevation?: number;
}

interface StageOptions {
  /** Sets <html data-theme>: "whitehaven", "orient-express", or any theme of tokens.css. */
  readonly theme?: string;
  /** "perspective" is the app's 28 degree lens; "iso" a 12 degree long lens that looks nearly isometric. */
  readonly camera?: "perspective" | "iso";
  /** The first view. Without one, the stage frames everything on its first frame. */
  readonly view?: View;
  /** Default true: drag, wheel and pinch move the camera. */
  readonly controls?: boolean;
}

interface Label {
  readonly element: HTMLElement;
  setContent(content: string | HTMLElement): void;
  remove(): void;
}

interface TrackedWall {
  readonly cutaway: Cutaway;
  readonly centre: THREE.Vector3;
  readonly normal: THREE.Vector3;
  goal: number;
  progress: number;
}

/** The app's camera limits and wall timings (engine/camera-rig.ts). */
const MIN_ELEVATION = 18;
const MAX_ELEVATION = 72;
const MIN_DISTANCE = 3;
const CLOSE_UP_DISTANCE = 16;
const WALL_SECONDS = 0.25;
const WALL_DEADBAND = 0.4;
/** The app's name tag lift over a colleague's head, in metres (engine/overlay.ts). */
const TAG_LIFT = 0.14;
/** How far a press may travel, in CSS pixels, and still count as a click. */
const CLICK_SLOP = 5;
const FIELD_OF_VIEW = { perspective: 28, iso: 12 } as const;

let liveStages = 0;

const toVector = (point: Point): THREE.Vector3 =>
  point instanceof THREE.Vector3 ? point.clone() : new THREE.Vector3(point[0], point[1], point[2]);

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Returns a smooth ease from 0 to 1. */
function easeInOut(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** Returns true when an object and every one of its ancestors is visible. */
function isShown(object: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node !== null; node = node.parent) {
    if (!node.visible) return false;
  }
  return true;
}

/**
 * Creates a stage in `container`: the app's own Stage (renderer, lights,
 * shadows, render loop), with orbit controls, the still building, wall
 * cutaways, lamps that follow the theme, HTML labels and picking.
 */
function createStage(container: HTMLElement, options: StageOptions = {}) {
  if (options.theme !== undefined) document.documentElement.dataset.theme = options.theme;
  ensureStyles();
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) setAmbientMotion(false);
  if (getComputedStyle(container).position === "static") container.style.position = "relative";

  const stage = new Stage(container);
  liveStages++;
  const { scene, camera, renderer } = stage;
  const canvas = renderer.domElement;
  canvas.style.display = "block";
  camera.fov = FIELD_OF_VIEW[options.camera ?? "perspective"];
  camera.updateProjectionMatrix();
  /** How much farther the camera stands than with the app's lens, for the same framing. */
  const lensFactor = Math.tan(radians(14)) / Math.tan(radians(camera.fov / 2));

  // The still building: everything but the colleagues. Its shadows are drawn once and redrawn
  // only when something in it changes, as in the app.
  const building = new THREE.Group();
  building.name = "building";
  scene.add(building);
  stage.setBuilding(building);

  const controls = new OrbitControls(camera, canvas);
  controls.enabled = options.controls !== false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.screenSpacePanning = false;
  controls.zoomToCursor = true;
  controls.minPolarAngle = radians(90 - MAX_ELEVATION);
  controls.maxPolarAngle = radians(90 - MIN_ELEVATION);
  controls.minDistance = MIN_DISTANCE * lensFactor;
  controls.maxDistance = 120 * lensFactor;
  // As in the app: drag grabs the floor, right-drag (or shift-drag) orbits; one finger pans,
  // two fingers pinch and turn.
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.PAN,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.ROTATE,
  };
  controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
  const onControlsChange = (): void => stage.requestRender();
  let interacted = false;
  const onControlsStart = (): void => {
    interacted = true;
    flight = null;
  };
  controls.addEventListener("change", onControlsChange);
  controls.addEventListener("start", onControlsStart);

  const colleagues = new Set<ColleagueObject>();
  const lamps: Lamp[] = [];
  let walls: TrackedWall[] = [];
  let buildingDirty = false;
  let autoFrame = options.view === undefined;
  const frameListeners = new Set<(frame: Frame) => boolean | void>();
  let disposed = false;

  const isEvening = (): boolean => stage.resolveTimeOfDay() === "evening";

  // -- The camera ------------------------------------------------------------

  /** Places the camera at a view at once. */
  const placeView = (view: View): void => {
    const target = view.target === undefined ? controls.target.clone() : toVector(view.target);
    const offset = new THREE.Vector3().subVectors(camera.position, controls.target);
    const current = new THREE.Spherical().setFromVector3(offset);
    const distance = view.distance ?? (current.radius > 0 ? current.radius : 12 * lensFactor);
    const azimuth = radians(view.azimuth ?? 38);
    const elevation = radians(view.elevation ?? 52);
    controls.target.copy(target);
    camera.position.set(
      target.x + distance * Math.cos(elevation) * Math.sin(azimuth),
      target.y + distance * Math.sin(elevation),
      target.z + distance * Math.cos(elevation) * Math.cos(azimuth),
    );
    camera.lookAt(target);
    controls.update();
    stage.requestRender();
  };

  /**
   * Returns the view that fits `object` (default: the whole building) in the
   * canvas from `azimuth` and `elevation`, as the app's Bureau frames a room.
   */
  const computeFrame = (
    object: THREE.Object3D = building,
    azimuth = 38,
    elevation = 52,
  ): Required<View> => {
    object.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return { target: [0, 0.4, 0], distance: 12 * lensFactor, azimuth, elevation };
    const target = box.getCenter(new THREE.Vector3()).setY(0.4);
    const az = radians(azimuth);
    const el = radians(elevation);
    const back = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
    const right = new THREE.Vector3(0, 1, 0).cross(back).normalize();
    const up = back.clone().cross(right).normalize();
    const tanY = Math.tan(radians(camera.fov / 2));
    const tanX = tanY * camera.aspect;
    let distance = 0;
    const corner = new THREE.Vector3();
    for (let index = 0; index < 8; index++) {
      // Walls drop to the dado rail, so the framing looks at the room below 1.2 m.
      corner.set(
        index & 1 ? box.max.x : box.min.x,
        index & 2 ? Math.min(box.max.y, 1.2) : box.min.y,
        index & 4 ? box.max.z : box.min.z,
      );
      const offset = corner.sub(target);
      const toward = offset.dot(back);
      distance = Math.max(
        distance,
        toward + Math.abs(offset.dot(right)) / tanX,
        toward + Math.abs(offset.dot(up)) / tanY,
      );
    }
    return { target, distance: distance * 1.12, azimuth, elevation };
  };

  let flight: {
    readonly fromTarget: THREE.Vector3;
    readonly toTarget: THREE.Vector3;
    readonly from: THREE.Spherical;
    readonly to: THREE.Spherical;
    readonly seconds: number;
    t: number;
    readonly done: () => void;
  } | null = null;

  /** Moves a flight one frame on. Returns true while it goes on. */
  const stepFlight = (dt: number): boolean => {
    if (flight === null) return false;
    flight.t = Math.min(1, flight.t + dt / flight.seconds);
    const e = easeInOut(flight.t);
    controls.target.lerpVectors(flight.fromTarget, flight.toTarget, e);
    const spherical = new THREE.Spherical(
      THREE.MathUtils.lerp(flight.from.radius, flight.to.radius, e),
      THREE.MathUtils.lerp(flight.from.phi, flight.to.phi, e),
      flight.from.theta + wrapAngle(flight.to.theta - flight.from.theta) * e,
    );
    camera.position.setFromSpherical(spherical).add(controls.target);
    camera.lookAt(controls.target);
    if (flight.t >= 1) {
      const { done } = flight;
      flight = null;
      done();
    }
    return true;
  };

  /** Returns the point a camera looks at for `target`: a colleague's chest, or a point. */
  const findLookPoint = (target: THREE.Object3D | Point): THREE.Vector3 => {
    if (!(target instanceof THREE.Object3D)) return toVector(target);
    const point = target.getWorldPosition(new THREE.Vector3());
    if (colleagueObjects.has(target)) point.y += 0.55;
    return point;
  };

  // -- The building, its lamps and its walls ---------------------------------

  /** Records every lamp and cutaway wall under `object`, and lights the lamps for the theme. */
  const collect = (object: THREE.Object3D): void => {
    object.traverse((child) => {
      if (child !== object && colleagueObjects.has(child)) {
        throw new Error(
          `OfficeKit: ${child.name} is inside ${object.name || "another object"}. Add each colleague with stage.add(colleague) on its own, because everything else becomes the still building, whose objects do not animate.`,
        );
      }
      const lamp = child.userData[LAMP] as Lamp | undefined;
      if (lamp !== undefined) {
        lamps.push(lamp);
        lamp.setOn(isEvening());
      }
    });
  };

  /** Finds every cutaway wall in the building again, with up-to-date world positions. */
  const trackWalls = (): void => {
    const previous = new Map(walls.map((wall) => [wall.cutaway, wall]));
    walls = [];
    building.traverse((object) => {
      const cutaway = object.userData[CUTAWAY] as Cutaway | undefined;
      if (cutaway === undefined) return;
      const box = new THREE.Box3().setFromObject(object);
      walls.push(
        previous.get(cutaway) ?? {
          cutaway,
          centre: box.getCenter(new THREE.Vector3()),
          normal: object.getWorldDirection(new THREE.Vector3()).setY(0).normalize(),
          goal: -1,
          progress: 0,
        },
      );
    });
  };

  /**
   * Lowers each wall that stands between the camera and what it looks at,
   * by the app's rule: from afar every interior wall drops and an exterior
   * wall drops when its outside faces the camera; close up a wall drops when
   * the camera and the target are on opposite sides of it. Returns true
   * while a wall still moves.
   */
  const updateWalls = (dt: number): boolean => {
    const eye = camera.position;
    const target = controls.target;
    const close = eye.distanceTo(target) < CLOSE_UP_DISTANCE * lensFactor;
    let moving = false;
    for (const wall of walls) {
      const band = wall.goal > 0.5 ? -WALL_DEADBAND : WALL_DEADBAND;
      const eyeSide = (eye.x - wall.centre.x) * wall.normal.x + (eye.z - wall.centre.z) * wall.normal.z;
      let cut: boolean;
      if (close) {
        const targetSide =
          (target.x - wall.centre.x) * wall.normal.x + (target.z - wall.centre.z) * wall.normal.z;
        cut = (eyeSide > band && targetSide < -band / 2) || (eyeSide < -band && targetSide > band / 2);
      } else {
        cut = !wall.cutaway.exterior || eyeSide > band;
      }
      const goal = cut ? 1 : 0;
      if (wall.goal < 0) {
        // A wall seen for the first time takes its height at once.
        wall.goal = wall.progress = goal;
        wall.cutaway.setCut(goal);
        continue;
      }
      wall.goal = goal;
      if (wall.progress === goal) continue;
      const step = dt / WALL_SECONDS;
      wall.progress = goal > wall.progress ? Math.min(goal, wall.progress + step) : Math.max(goal, wall.progress - step);
      wall.cutaway.setCut(easeInOut(wall.progress));
      moving = true;
    }
    return moving;
  };

  /** Fits the sun's shadow to the building and finds its walls again, after something was added. */
  const refreshBuilding = (): void => {
    building.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(building);
    if (!box.isEmpty()) stage.setShadowBounds(box.expandByScalar(0.5));
    trackWalls();
    if (autoFrame && !interacted && !box.isEmpty()) {
      autoFrame = false;
      placeView(computeFrame());
    }
  };

  // -- Labels ------------------------------------------------------------------

  const layer = document.createElement("div");
  layer.className = "office-kit-labels";
  container.append(layer);
  let layerWidth = container.clientWidth;
  let layerHeight = container.clientHeight;
  const labels = new Set<{
    readonly element: HTMLElement;
    readonly read: (out: THREE.Vector3) => THREE.Vector3;
    x: number;
    y: number;
    shown: boolean;
  }>();
  const projected = new THREE.Vector3();

  /** Moves every label over its point. Costs no layout: it writes transforms and a class. */
  const updateLabels = (): void => {
    if (labels.size === 0) return;
    camera.updateMatrixWorld();
    for (const label of labels) {
      label.read(projected).project(camera);
      const shown =
        projected.z > -1 && projected.z < 1 && Math.abs(projected.x) <= 1.1 && Math.abs(projected.y) <= 1.1;
      if (shown !== label.shown) {
        label.shown = shown;
        label.element.classList.toggle("is-shown", shown);
      }
      if (!shown) continue;
      const x = Math.round(((projected.x + 1) / 2) * layerWidth * 10) / 10;
      const y = Math.round(((1 - projected.y) / 2) * layerHeight * 10) / 10;
      if (x === label.x && y === label.y) continue;
      label.x = x;
      label.y = y;
      label.element.style.transform = `translate3d(${String(x)}px, ${String(y)}px, 0)`;
    }
  };

  const resizeObserver = new ResizeObserver(() => {
    layerWidth = container.clientWidth;
    layerHeight = container.clientHeight;
    stage.requestRender();
  });
  resizeObserver.observe(container);

  // -- Drawing only while seen -------------------------------------------------

  let inView = true;
  /** True between `pause()` and `resume()`: nothing animates and no frame asks for another. */
  let paused = false;
  const intersectionObserver = new IntersectionObserver((entries) => {
    inView = entries.some((entry) => entry.isIntersecting);
    if (inView) stage.requestRender();
  });
  intersectionObserver.observe(container);

  const themeObserver = new MutationObserver(() => {
    stage.applyTheme();
    for (const lamp of lamps) lamp.setOn(isEvening());
    stage.requestRender();
  });
  themeObserver.observe(document.documentElement, { attributeFilter: ["data-theme"] });
  // Signs drawn on canvases redraw once their typeface loads.
  void document.fonts.ready.then(() => {
    if (!disposed) stage.requestRender();
  });

  // -- Picking -----------------------------------------------------------------

  const pickers = new Set<{
    readonly objects: ReadonlyArray<THREE.Object3D>;
    readonly handle: (object: THREE.Object3D, hit: THREE.Intersection, event: PointerEvent) => void;
  }>();
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  /** Returns the nearest visible hit on `objects` at a point of the page, and which of them it is. */
  const pick = (
    objects: ReadonlyArray<THREE.Object3D>,
    clientX: number,
    clientY: number,
  ): { readonly object: THREE.Object3D; readonly hit: THREE.Intersection } | null => {
    const rect = canvas.getBoundingClientRect();
    pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    camera.updateMatrixWorld();
    raycaster.setFromCamera(pointer, camera);
    // The raycaster does not skip hidden meshes, such as a colleague's tucked-away teacup.
    const hit = raycaster.intersectObjects([...objects], true).find((each) => isShown(each.object));
    if (hit === undefined) return null;
    for (let node: THREE.Object3D | null = hit.object; node !== null; node = node.parent) {
      if (objects.includes(node)) return { object: node, hit };
    }
    return null;
  };

  let pressedAt: { readonly x: number; readonly y: number; readonly id: number } | null = null;
  const onPointerDown = (event: PointerEvent): void => {
    pressedAt = { x: event.clientX, y: event.clientY, id: event.pointerId };
  };
  const onPointerUp = (event: PointerEvent): void => {
    if (pressedAt === null || pressedAt.id !== event.pointerId) return;
    const travelled = Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y);
    pressedAt = null;
    if (travelled > CLICK_SLOP) return;
    for (const picker of pickers) {
      const found = pick(picker.objects, event.clientX, event.clientY);
      if (found !== null) picker.handle(found.object, found.hit, event);
    }
  };
  // A pick costs a few milliseconds over a furnished room, and a mouse reports up to 120 moves a
  // second, so the pointer shape is decided at most once per animation frame.
  let hoverAt: { readonly x: number; readonly y: number } | null = null;
  let hoverRequest = 0;
  const decideCursor = (): void => {
    hoverRequest = 0;
    if (hoverAt === null) return;
    let over = false;
    for (const picker of pickers) {
      if (pick(picker.objects, hoverAt.x, hoverAt.y) !== null) over = true;
    }
    canvas.style.cursor = over ? "pointer" : "";
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (event.buttons !== 0 || event.pointerType !== "mouse" || pickers.size === 0) return;
    hoverAt = { x: event.clientX, y: event.clientY };
    if (hoverRequest === 0) hoverRequest = requestAnimationFrame(decideCursor);
  };
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointermove", onPointerMove);

  // -- The frame ---------------------------------------------------------------

  if (options.view !== undefined) placeView(options.view);
  else placeView({ target: [0, 0.4, 0], distance: 12 * lensFactor });

  const stopFrames = stage.onFrame((frame) => {
    if (!inView || paused) return false;
    if (buildingDirty) {
      buildingDirty = false;
      refreshBuilding();
    }
    let moving = false;
    for (const listener of frameListeners) moving = listener(frame) === true || moving;
    for (const colleague of colleagues) {
      if (colleague.parent === null) {
        colleagues.delete(colleague);
        changeListeners.delete(colleague);
        continue;
      }
      moving = colleague.update(frame) || moving;
    }
    moving = stepFlight(frame.dt) || moving;
    moving = controls.update() || moving;
    moving = updateWalls(frame.dt) || moving;
    updateLabels();
    return moving;
  });

  const api = {
    scene,
    camera,
    renderer,
    controls,
    /** The still building: everything added that is not a colleague. */
    building,
    /** The app's Stage instance, for its lights (`sun`, `sky`) and `applyTheme`. */
    stage,

    /**
     * Adds objects to the scene. A colleague from `OfficeKit.colleague` joins
     * the scene and animates on every frame; anything else joins the still
     * building. Returns the first object.
     */
    add<T extends THREE.Object3D>(object: T, ...more: THREE.Object3D[]): T {
      for (const each of [object, ...more]) {
        if (colleagueObjects.has(each)) {
          scene.add(each);
          colleagues.add(each as ColleagueObject);
          changeListeners.set(each, () => stage.requestRender());
        } else {
          collect(each);
          building.add(each);
          buildingDirty = true;
        }
      }
      stage.requestRender();
      return object;
    },

    /** Takes an object out of the scene. */
    remove(object: THREE.Object3D): void {
      object.removeFromParent();
      colleagues.delete(object as ColleagueObject);
      changeListeners.delete(object);
      buildingDirty = true;
      stage.requestRender();
    },

    /**
     * Calls `listener` before each drawn frame with `{ dt, time }` in
     * seconds. Return true while it animates something, so the next frame is
     * drawn too. Returns the function that removes it.
     */
    onFrame(listener: (frame: Frame) => boolean | void): () => void {
      frameListeners.add(listener);
      stage.requestRender();
      return () => frameListeners.delete(listener);
    },

    /** Stops animating and drawing, until `resume()`, for a page that hides the stage. */
    pause(): void {
      paused = true;
    },

    /** Animates and draws again after `pause()`. */
    resume(): void {
      paused = false;
      stage.requestRender();
    },

    /** Draws one more frame. Call it after changing the scene from outside a frame listener. */
    requestRender(): void {
      stage.requestRender();
    },

    /** Places the camera at a view at once: a target, a distance, an azimuth and an elevation. */
    view(view: View): void {
      flight = null;
      autoFrame = false;
      placeView(view);
    },

    /**
     * Places the camera so `object` (default: everything but the colleagues)
     * fills the canvas, from `azimuth` and `elevation` (default 38 and 52, the
     * app's room view). Returns the view, so a page can fly back to it.
     */
    frame(
      object?: THREE.Object3D,
      view: { azimuth?: number; elevation?: number } = {},
    ): Required<View> {
      flight = null;
      autoFrame = false;
      const framed = computeFrame(object, view.azimuth, view.elevation);
      placeView(framed);
      return framed;
    },

    /**
     * Flies the camera to look at `target` (an object, a colleague or a
     * point) from `distance` metres, keeping its angles unless `view` gives
     * new ones. Resolves when the flight lands.
     */
    flyTo(
      target: THREE.Object3D | Point,
      distance?: number,
      view: { azimuth?: number; elevation?: number; seconds?: number } = {},
    ): Promise<void> {
      flight?.done();
      autoFrame = false;
      const from = new THREE.Spherical().setFromVector3(
        new THREE.Vector3().subVectors(camera.position, controls.target),
      );
      const to = from.clone();
      if (distance !== undefined) to.radius = distance;
      if (view.elevation !== undefined) to.phi = radians(90 - view.elevation);
      if (view.azimuth !== undefined) to.theta = radians(view.azimuth);
      return new Promise((resolve) => {
        flight = {
          fromTarget: controls.target.clone(),
          toTarget: findLookPoint(target),
          from,
          to,
          seconds: view.seconds ?? 0.8,
          t: 0,
          done: resolve,
        };
        stage.requestRender();
      });
    },

    /**
     * Shows `content` (HTML text or an element) over a point of the scene,
     * every frame: over an object's origin, over a colleague's head, or at a
     * point. `offset` lifts it in metres (a number) or moves it ([x, y, z]).
     */
    label(
      target: THREE.Object3D | Point,
      content: string | HTMLElement,
      opts: { offset?: number | Point; className?: string } = {},
    ): Label {
      const offset =
        opts.offset === undefined
          ? new THREE.Vector3()
          : typeof opts.offset === "number"
            ? new THREE.Vector3(0, opts.offset, 0)
            : toVector(opts.offset);
      const fixed = target instanceof THREE.Object3D ? null : toVector(target);
      const read = (out: THREE.Vector3): THREE.Vector3 => {
        if (fixed !== null) return out.copy(fixed).add(offset);
        const object = target as THREE.Object3D;
        object.getWorldPosition(out).add(offset);
        if (colleagueObjects.has(object)) out.y += (object as ColleagueObject).headHeight + TAG_LIFT;
        return out;
      };
      const buildElement = (value: string | HTMLElement): HTMLElement => {
        const element =
          typeof value === "string" ? Object.assign(document.createElement("div"), { innerHTML: value }) : value;
        element.classList.add("office-kit-label");
        if (opts.className !== undefined) element.classList.add(...opts.className.split(/\s+/).filter(Boolean));
        return element;
      };
      const entry = { element: buildElement(content), read, x: NaN, y: NaN, shown: false };
      layer.append(entry.element);
      labels.add(entry);
      stage.requestRender();
      return {
        get element() {
          return entry.element;
        },
        setContent(next) {
          const element = buildElement(next);
          if (entry.shown) element.classList.add("is-shown");
          element.style.transform = entry.element.style.transform;
          entry.element.replaceWith(element);
          (entry as { element: HTMLElement }).element = element;
        },
        remove() {
          entry.element.remove();
          labels.delete(entry);
        },
      };
    },

    /**
     * Calls `handle(object, hit, event)` when a click or tap lands on one of
     * `objects` (or anything inside it). A drag is not a click. Returns the
     * function that stops listening.
     */
    onPick(
      objects: THREE.Object3D | ReadonlyArray<THREE.Object3D>,
      handle: (object: THREE.Object3D, hit: THREE.Intersection, event: PointerEvent) => void,
    ): () => void {
      const picker = { objects: Array.isArray(objects) ? [...objects] : [objects as THREE.Object3D], handle };
      pickers.add(picker);
      return () => pickers.delete(picker);
    },

    /** Stops drawing and frees the WebGL context, the labels and every colleague. */
    dispose(): void {
      if (disposed) return;
      disposed = true;
      stopFrames();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      themeObserver.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointermove", onPointerMove);
      cancelAnimationFrame(hoverRequest);
      controls.removeEventListener("change", onControlsChange);
      controls.removeEventListener("start", onControlsStart);
      controls.dispose();
      layer.remove();
      for (const colleague of colleagues) colleague.rig.dispose();
      colleagues.clear();
      stage.dispose();
      liveStages--;
      // The kit's geometry and materials are shared by every stage on the page.
      if (liveStages === 0) clearCaches();
    },
  };
  return api;
}

// ---------------------------------------------------------------------------
// The globals.

const wrappedProps = Object.fromEntries(
  Object.entries(props).map(([name, value]) => [name, typeof value === "function" ? withStyles(value as (...args: unknown[]) => unknown) : value]),
) as typeof props;

const OfficeKit = {
  /** The three.js revision the kit was built with. */
  threeRevision: THREE.REVISION,
  stage: { create: createStage },
  colleague: buildColleague,
  tag: buildTag,
  buildRoom,
  OrbitControls,
  Stage,

  // The colleagues.
  buildColleagueRig: withStyles(buildColleagueRig),
  setAmbientMotion,
  addContactShadow,
  buildLook,
  buildSessionLook,
  buildAssistantLook,
  hashSeed,
  HUES,
  SHAPES,
  WARDROBE,
  HEADWEAR,
  HERCULE_LOOK,

  // The props and the architecture.
  ...wrappedProps,
  buildFloor: withStyles(buildFloor),
  buildWall: withStyles(buildWall),
  buildPlaque: withStyles(buildPlaque),
  buildLamppost: withStyles(buildLamppost),
  buildLawn: withStyles(buildLawn),
  buildPath: withStyles(buildPath),
  buildSideStreet: withStyles(buildSideStreet),

  // The palette.
  readColor: withStyles(readColor),
  readHue: withStyles(readHue),
  readToken: withStyles(readToken),
  paint: withStyles(paint),
  paintHue: withStyles(paintHue),
  paintVertexColors,
  refreshPalette,
  subscribePalette,
  isDarkTheme,
  writeOklch,

  // The office's scale and keys, in metres.
  SEAT_HEIGHT,
  DESK_HEIGHT,
  WALL_HEIGHT,
  WALL_THICKNESS,
  CUTAWAY_HEIGHT,
  WALK_SPEED,
  CUTAWAY,
  LAMP,
  clearCaches,
};

Object.assign(globalThis, { THREE, OfficeKit });
