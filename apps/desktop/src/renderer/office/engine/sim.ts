/**
 * The office's life: where every colleague is when the office
 * opens, and every walk after that, from the queue at the user's desk to a
 * cup of tea.
 *
 * Each colleague is an actor that runs one script at a time: a short async
 * function that walks, waits and changes actions ("stand up, walk to the
 * queue, raise a hand"). A new script cancels the one before it wherever it
 * was, and starts from where the colleague stands. Walking and turning
 * advance with the frames; every other wait is a timer that asks the stage
 * for a frame when it fires, so an office where nobody walks draws nothing
 * between happenings.
 */
import { Vector3 } from "three";
import type {
  Action,
  BuildSim,
  ColleagueRig,
  ColleagueState,
  Seat,
  Sim,
  SimContext,
  Spot,
} from "./contracts";
import { WALK_SPEED } from "./contracts";
import { isOfficeNavGraph } from "./nav";
import type { Frame } from "./stage";
import type { Pose } from "@hercule/client-core";
import type { Colleague, OfficeRequest } from "../world/types";

// ---------------------------------------------------------------------------
// Timings, in seconds.

/** Getting up from a seat, at the least. */
const STAND_UP_SECONDS = 0.5;
/** Sitting down onto a seat, at the least. */
const SIT_DOWN_SECONDS = 0.55;
/** One happy hop, from take-off to standing again. */
const HOP_SECONDS = 0.9;
/** Between two colleagues of the queue stepping forward. */
const QUEUE_STEP_SECONDS = 0.35;
/** Between an answered colleague's hop and the queue moving up behind it. */
const QUEUE_CLOSE_SECONDS = HOP_SECONDS + 0.7;
/** The least time between two colleagues setting off on an errand, so no two start at once. */
const DEPARTURE_GAP_SECONDS = 0.7;
/** A visit's exchange: the visitor talks, listens, and talks again. */
const VISIT_SECONDS = [2.2, 1.8, 1.1] as const;
/** At the tea trolley. */
const TEA_SECONDS = 2.6;
/** Sipping the fetched tea before a working colleague types again. */
const TEA_BREAK_SECONDS = 16;
/** Reaching up to pin one card. */
const PIN_SECONDS = 1.6;
/** From the office opening to Ada's walk to Investigate backup timeouts. */
const ADA_VISIT_DELAY_SECONDS = 4;
/** The gap between two small happenings, per liveliness level. */
const HAPPENING_GAP_SECONDS: Readonly<Record<1 | 2, readonly [number, number]>> = {
  1: [15, 40],
  2: [4, 12],
};
/** The most colleagues out on errands at once, per liveliness level. */
const ERRAND_LIMIT: Readonly<Record<0 | 1 | 2, number>> = { 0: 0, 1: 3, 2: 6 };
/** The gap between two glances of the queue at its head. */
const GLANCE_GAP_SECONDS = [3, 7] as const;
const GLANCE_SECONDS = 1.6;

// ---------------------------------------------------------------------------
// Motion.

/** m/s², setting off. */
const ACCELERATION = 2.6;
/** m/s², slowing into the last step. */
const BRAKING = 1.5;
/** The speed the last step ends at, so the walk does not crawl to a stop. */
const ARRIVAL_SPEED = 0.16;
/** The cadence a colleague keeps while it turns on the spot, so its feet step. */
const TURNING_CADENCE = 0.35;
/** How far each corner of a path is rounded off, at most, in metres. */
const CORNER_RADIUS = 0.32;
/** How far inside a corner of a path the rounded curve may pass, in metres. */
const CORNER_CUT = 0.04;
const CORNER_SAMPLES = 6;
/** How far ahead along the path a walker looks to choose its heading, in metres. */
const LOOK_AHEAD = 0.22;
/** How fast a heading closes in on its target: the share left after one second is e^-rate. */
const TURN_RATE = 9;
/** rad/s. */
const MAX_TURN_SPEED = 6.5;
/** A heading this close to its target counts as there, in radians. */
const SETTLED_ANGLE = 0.004;
/** m/s, sliding onto a seat or off it. */
const GLIDE_SPEED = 0.8;
/** The longest slide onto or off a seat other than a desk's, in metres; a longer one is walked. */
const MAX_GLIDE = 1.0;
/**
 * The disc around a colleague standing in the queue that the centres of
 * other walkers keep out of, in metres: two bodies' radii and a little room.
 * It stays under the queue's spacing, so the next place in line is never
 * inside a neighbour's disc.
 */
const QUEUE_DISC_RADIUS = 0.65;
/** A colleague waiting at its desk faces the default camera, the user, with its raised hand. */
const TOWARD_USER = Math.PI / 4;

/** The actions in which a colleague sits. */
const SEATED: ReadonlySet<Action> = new Set<Action>(["sit", "type", "read", "sip", "sleep"]);

/** Where to stand beside a seat, as (sideways, forward) metres in the seat's own frame, best first. */
const BESIDE_SEAT: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [
    [0.85, 0.15],
    [-0.85, 0.15],
  ],
  [
    [1.0, -0.15],
    [-1.0, -0.15],
  ],
  [
    [0.75, -0.5],
    [-0.75, -0.5],
  ],
  [[0, -0.75]],
  [
    [1.25, 0],
    [-1.25, 0],
  ],
  [[0, -1.1]],
];

// ---------------------------------------------------------------------------
// Types.

/** What an actor's script is doing, so the happenings leave busy colleagues alone. */
type Errand = "queue" | "desk-wait" | "answer" | "visit" | "tea" | "lounge" | "pin" | "home";

/** Where an actor rests between scripts. */
type Place = "home" | "lounge" | "queue" | "desk-side" | "entrance" | "elsewhere";

/** A stretch of a path on one storey, with its corners rounded. */
interface WalkLeg {
  readonly kind: "walk";
  readonly points: ReadonlyArray<Vector3>;
  /** The distance along the leg to each point. */
  readonly distances: ReadonlyArray<number>;
  readonly length: number;
}

/**
 * A short slide without steps: sitting down onto a seat, or getting up from
 * one, between the seat and a place to stand: beside a desk's chair, or the
 * nearest one for any other seat. A desk's chair sits inside the desk's
 * obstacle, so the last steps onto it are not walked: the colleague sits
 * down as it slides in, the way a person pulls a chair in.
 */
interface GlideLeg {
  readonly kind: "glide";
  readonly from: Vector3;
  readonly to: Vector3;
  readonly seconds: number;
  /** The heading to turn to before the slide, or null to keep the current one. */
  readonly facing: number | null;
  /** What the colleague does while it slides: `stand` getting up, its seated action sitting down. */
  readonly action: Action;
}

type Leg = WalkLeg | GlideLeg;

/** A walk in progress, which the frames advance. */
interface Walk {
  readonly legs: ReadonlyArray<Leg>;
  /** Every point the walk passes, from start to end, for drawing it. */
  readonly route: ReadonlyArray<Vector3>;
  leg: number;
  /** Metres along a walk leg, or seconds into a glide. */
  progress: number;
  speed: number;
  /** The heading to settle into at the end. */
  readonly facing: number;
  readonly finish: () => void;
}

/** One colleague as the sim runs it. */
interface Actor {
  readonly colleague: Colleague;
  readonly rig: ColleagueRig;
  readonly home: Seat;
  pose: Pose;
  action: Action;
  place: Place;
  floor: number;
  yaw: number;
  motion: Walk | null;
  errand: Errand | null;
  /** Bumped by every new script, so an old script's end does not clear a newer one's errand. */
  script: number;
  /** Another colleague stands at this one's desk talking to it. */
  hosting: boolean;
  /** The order of its request in the queue: lower waited longer. */
  ticket: number;
  loungeSeat: Seat | null;
  /** Frees the disc it holds in the queue. */
  releaseDisc: (() => void) | null;
  /** The ids of the sim timers its script waits on. */
  readonly timers: Set<number>;
  /** The rejecters of the promises its script awaits, so a cancel can fail them. */
  readonly pending: Set<(error: Error) => void>;
  walkCadence: number;
}

/** A timer on the sim's clock, which counts only the time the window is shown. */
interface SimTimer {
  readonly callback: () => void;
  /** The time left to wait, as of `startedAt`, in ms. */
  remainingMs: number;
  /** When the browser timer last started, by `performance.now()`. */
  startedAt: number;
  /** The browser timer while the window is shown. */
  handle: number;
}

/** What the lab reads of the sim, besides the contract. */
export interface SimInspector {
  /**
   * Returns the route each walking colleague follows now, its corners
   * rounded, by colleague id. A route keeps its identity for the whole walk.
   */
  readWalkPaths(): ReadonlyMap<string, ReadonlyArray<Vector3>>;
  /** Returns the ids of the colleagues waiting on the user: the queue from its head, then the rest, longest waiting first. */
  listWaitingColleagues(): ReadonlyArray<string>;
}

/** Fails an awaited step of a script that a newer script replaced. */
class ScriptCancelled extends Error {
  constructor() {
    super("The colleague's script was replaced by a newer one.");
  }
}

// ---------------------------------------------------------------------------
// Small helpers.

/** Returns an angle wrapped into (-PI, PI]. */
function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/** Returns the yaw that faces from one point toward another. */
function computeYawToward(from: Vector3, to: Vector3): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

/** Returns a random number from `min` up to, but not including, `max`. */
function pickRandomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function pickRandom<T>(items: ReadonlyArray<T>): T | undefined {
  return items[Math.floor(Math.random() * items.length)];
}

/** Checks whether a spot is a desk's seat, which a colleague gets onto from beside its chair. */
function isDeskSeat(spot: Spot): spot is Seat {
  return "kind" in spot && spot.kind === "desk";
}

/** Returns the short state a name tag shows for a pose the sim has just set, such as "typing". */
function describePose(pose: Pose): string {
  return pose === "working" ? "typing" : pose;
}

/** Builds the question a colleague asks the user with when the world gave it none. */
function buildRequest(colleague: Colleague): OfficeRequest {
  return {
    kind: "question",
    short: "Go ahead with the plan?",
    prompt: `${colleague.name} has a plan ready and asks whether to go ahead with it.`,
    answers: ["Go ahead", "Not yet"],
    waitingSince: new Date().toISOString(),
  };
}

/** Returns the action a colleague does at its own seat in a pose. */
function decideHomeAction(pose: Pose, seat: Seat["kind"]): Action {
  if (seat === "standing") return pose === "waiting" ? "raise-hand" : "stand";
  switch (pose) {
    case "working":
      return seat === "armchair" ? "read" : "type";
    case "idle":
      return "sip";
    case "asleep":
      return "sleep";
    case "waiting":
      return "raise-hand";
    case "away":
      return "stand";
    case "paused":
    case "failed":
    case "done":
      return "sit";
  }
}

/**
 * Rounds each inner corner of a polyline with a quadratic curve, so a walker
 * following it turns smoothly. The curve passes at most `CORNER_CUT` inside
 * the corner, because the corner of a path often sits as close to a wall or
 * a desk as a body may come, and the curve bends toward it.
 */
function roundCorners(points: ReadonlyArray<Vector3>): Vector3[] {
  if (points.length < 3) return points.map((point) => point.clone());
  const rounded = [points[0]!.clone()];
  const incoming = new Vector3();
  const outgoing = new Vector3();
  for (let index = 1; index < points.length - 1; index++) {
    const before = points[index - 1]!;
    const corner = points[index]!;
    const after = points[index + 1]!;
    incoming.subVectors(corner, before);
    outgoing.subVectors(after, corner);
    const longest = Math.min(incoming.length(), outgoing.length()) * 0.45;
    incoming.normalize();
    outgoing.normalize();
    // The curve's middle sits a quarter of the radius times the length of
    // (outgoing - incoming) inside the corner.
    const bend = outgoing.distanceTo(incoming);
    const radius = Math.min(CORNER_RADIUS, (4 * CORNER_CUT) / Math.max(bend, 1e-6), longest);
    if (radius < 0.02 || incoming.dot(outgoing) > 0.995) {
      rounded.push(corner.clone());
      continue;
    }
    const start = corner.clone().addScaledVector(incoming, -radius);
    const end = corner.clone().addScaledVector(outgoing, radius);
    for (let sample = 0; sample <= CORNER_SAMPLES; sample++) {
      const t = sample / CORNER_SAMPLES;
      rounded.push(
        new Vector3()
          .addScaledVector(start, (1 - t) * (1 - t))
          .addScaledVector(corner, 2 * (1 - t) * t)
          .addScaledVector(end, t * t),
      );
    }
  }
  rounded.push(points[points.length - 1]!.clone());
  return rounded;
}

/** Builds a walk leg through points: rounded corners, and the distance to each point. */
function buildWalkLeg(points: ReadonlyArray<Vector3>): WalkLeg {
  const rounded = roundCorners(points);
  const distances = [0];
  for (let index = 1; index < rounded.length; index++) {
    distances.push(distances[index - 1]! + rounded[index]!.distanceTo(rounded[index - 1]!));
  }
  return { kind: "walk", points: rounded, distances, length: distances[distances.length - 1]! };
}

/** Writes into `target` the point a distance along a walk leg, and returns it. */
function sampleLeg(leg: WalkLeg, distance: number, target: Vector3): Vector3 {
  const { points, distances } = leg;
  let low = 0;
  let high = distances.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (distances[middle]! <= distance) low = middle;
    else high = middle;
  }
  const span = distances[high]! - distances[low]!;
  const t = span > 0 ? Math.min(1, Math.max(0, (distance - distances[low]!) / span)) : 0;
  return target.lerpVectors(points[low]!, points[high]!, t);
}

// ---------------------------------------------------------------------------
// The sim.

export const buildSim: BuildSim = (context) => createSim(context);

/** Builds the sim, with the inspector the lab draws walking paths from. */
export function createSim({ world, layout, rigs, stage }: SimContext): Sim & SimInspector {
  const { spots } = layout;
  const nav = layout.nav;
  const officeNav = isOfficeNavGraph(nav) ? nav : null;
  const actors = new Map<string, Actor>();
  const queue: Array<Actor | null> = spots.queue.map(() => null);
  const loungeTaken = new Map<Seat, Actor>();
  const timers = new Map<number, SimTimer>();
  let lastTimerId = 0;
  const warned = new Set<string>();
  let disposed = false;
  let liveliness: 0 | 1 | 2 = 0;
  let happeningTimer = 0;
  let glanceTimer = 0;
  let adaVisitScheduled = false;
  let adaVisitTimer = 0;
  let nextTicket = 0;
  // The colleagues' states the UI reads. The map is replaced on every change,
  // never edited, so a reader sees a change as a new map.
  let states: ReadonlyMap<string, ColleagueState> = new Map(
    world.colleagues.map((colleague) => [
      colleague.id,
      { pose: colleague.pose, request: colleague.request, stateLabel: colleague.stateLabel },
    ]),
  );
  const stateListeners = new Set<() => void>();
  // The colleagues the world seats in the Lounge. Client-core decides who
  // they are; the sim only walks them there and keeps them there.
  const loungeIds = new Set(world.lounge);
  let nextDepartureAt = 0;
  let teaTaken = false;
  let pinsWaiting = 0;
  const scratch = new Vector3();

  // -- Timers --------------------------------------------------------------
  //
  // The sim's timers count only the time the window is shown. While it is
  // hidden, no frames are drawn, so a walk stands still where it is; the
  // timers stand still with it, so no happening starts unseen and nothing
  // jumps ahead when the window is shown again.

  /** Starts the browser timer for the time `timer` has left. */
  const armTimer = (id: number, timer: SimTimer): void => {
    timer.startedAt = performance.now();
    timer.handle = window.setTimeout(() => {
      timers.delete(id);
      timer.callback();
    }, timer.remainingMs);
  };

  /** Runs `callback` once the window has been shown for `seconds`. Returns the timer's id. */
  const startTimer = (seconds: number, callback: () => void): number => {
    const id = ++lastTimerId;
    const timer: SimTimer = { callback, remainingMs: seconds * 1000, startedAt: 0, handle: 0 };
    timers.set(id, timer);
    if (!document.hidden) armTimer(id, timer);
    return id;
  };

  /** Stops a timer `startTimer` started. Does nothing when it already ran or was stopped. */
  const stopTimer = (id: number): void => {
    const timer = timers.get(id);
    if (timer === undefined) return;
    window.clearTimeout(timer.handle);
    timers.delete(id);
  };

  /** Holds every timer while the window is hidden, and starts them again for what they had left. */
  const onVisibilityChange = (): void => {
    for (const [id, timer] of timers) {
      window.clearTimeout(timer.handle);
      if (document.hidden) {
        timer.remainingMs = Math.max(0, timer.remainingMs - (performance.now() - timer.startedAt));
      } else {
        armTimer(id, timer);
      }
    }
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

  /** Runs `callback` after `seconds`, and draws a frame for what it changes. */
  const schedule = (seconds: number, callback: () => void): number =>
    startTimer(seconds, () => {
      if (disposed) return;
      callback();
      stage.requestRender();
    });

  // -- An actor's state ----------------------------------------------------

  const setAction = (actor: Actor, action: Action): void => {
    if (actor.action === action && action !== "hop") return;
    actor.action = action;
    actor.rig.setAction(action);
    stage.requestRender();
  };

  /**
   * Records a colleague's new pose in the states the UI reads, with the
   * label and request that go with it, and calls the state listeners. A
   * waiting colleague keeps its request, takes the world's, or gets one made
   * up; any other pose has none. Does nothing when the pose is unchanged.
   */
  const recordPose = (actor: Actor, pose: Pose): void => {
    const id = actor.colleague.id;
    const current = states.get(id);
    if (current?.pose === pose) return;
    const request =
      pose === "waiting"
        ? (current?.request ?? actor.colleague.request ?? buildRequest(actor.colleague))
        : null;
    const next = new Map(states);
    next.set(id, { pose, request, stateLabel: describePose(pose) });
    states = next;
    for (const listener of stateListeners) listener();
  };

  /**
   * Records a colleague's state in the states the UI reads, as the world
   * gives it, and calls the state listeners. Does nothing when the state is
   * the one recorded already.
   */
  const recordState = (id: string, state: ColleagueState): void => {
    const current = states.get(id);
    if (
      current?.pose === state.pose &&
      current.stateLabel === state.stateLabel &&
      current.request === state.request
    ) {
      return;
    }
    const next = new Map(states);
    next.set(id, state);
    states = next;
    for (const listener of stateListeners) listener();
  };

  /** Sets a colleague's pose: its face, the lamp and note on its desk, and its state for the UI. */
  const setPose = (actor: Actor, pose: Pose): void => {
    actor.pose = pose;
    actor.rig.setFace(pose);
    actor.home.desk?.setLamp(pose === "working");
    actor.home.desk?.setNote(pose === "waiting");
    recordPose(actor, pose);
    stage.requestRender();
  };

  const setCup = (actor: Actor, on: boolean): void => {
    actor.home.desk?.setCup(on);
  };

  /** Puts a colleague on a spot at once, facing `facing`. */
  const placeAt = (actor: Actor, position: Vector3, floor: number, facing: number): void => {
    actor.rig.object.position.copy(position);
    actor.floor = floor;
    actor.yaw = wrapAngle(facing);
    actor.rig.object.rotation.y = actor.yaw;
  };

  /** Returns the point a colleague looks from, about where its eyes are. */
  const findEyePoint = (actor: Actor): Vector3 =>
    actor.rig.object.position
      .clone()
      .setY(actor.rig.object.position.y + actor.rig.headHeight * 0.75);

  const isWalkable = (position: Vector3, floor: number): boolean =>
    officeNav?.isWalkable({ position, facing: 0, floor }) ?? true;

  /** Returns true when a colleague rests with nothing to do, free for a happening. */
  const isSettled = (actor: Actor): boolean =>
    actor.errand === null && actor.motion === null && !actor.hosting;

  // -- Scripts -------------------------------------------------------------

  /** Cancels a colleague's script: its timers stop and every step it awaits fails. */
  const cancelScript = (actor: Actor): void => {
    for (const timer of actor.timers) stopTimer(timer);
    actor.timers.clear();
    actor.motion = null;
    const pending = [...actor.pending];
    actor.pending.clear();
    for (const reject of pending) reject(new ScriptCancelled());
  };

  /**
   * Starts a script for a colleague, cancelling the one it runs. A script
   * that is not about the queue takes the colleague out of it first, and
   * every script gives up the lounge armchair or tea trolley it held.
   */
  const run = (actor: Actor, errand: Errand, script: () => Promise<void>): void => {
    if (disposed) return;
    cancelScript(actor);
    if (errand !== "queue") leaveQueue(actor, 0.6);
    if (actor.loungeSeat !== null) {
      loungeTaken.delete(actor.loungeSeat);
      actor.loungeSeat = null;
    }
    if (actor.place === "lounge") actor.place = "elsewhere";
    const id = ++actor.script;
    actor.errand = errand;
    script()
      .catch((error: unknown) => {
        // Cancelling a script rejects its waits with ScriptCancelled, which
        // ends the script as planned. Any other error is a bug in the script:
        // the colleague stops where it was, and the console is the only place
        // the error shows.
        if (!(error instanceof ScriptCancelled)) console.error(error);
      })
      .finally(() => {
        if (actor.script === id) actor.errand = null;
      });
    stage.requestRender();
  };

  /** Waits `seconds` within a colleague's script. */
  const wait = (actor: Actor, seconds: number): Promise<void> =>
    new Promise((resolve, reject) => {
      if (disposed) {
        reject(new ScriptCancelled());
        return;
      }
      const timer = startTimer(seconds, () => {
        actor.timers.delete(timer);
        actor.pending.delete(reject);
        stage.requestRender();
        resolve();
      });
      actor.timers.add(timer);
      actor.pending.add(reject);
    });

  /** Starts a walk that the frames advance, and returns the promise it fulfils on arrival. */
  const startWalk = (actor: Actor, build: (finish: () => void) => Walk): Promise<void> =>
    new Promise((resolve, reject) => {
      if (disposed) {
        reject(new ScriptCancelled());
        return;
      }
      actor.pending.add(reject);
      actor.motion = build(() => {
        actor.motion = null;
        actor.pending.delete(reject);
        resolve();
      });
      stage.requestRender();
    });

  /**
   * Walks a colleague to a spot along the nav graph's path, and turns it to
   * the spot's facing. A seated colleague gets up first. With `sitAction`,
   * the colleague sits down on the spot at the end and does that action.
   * When the graph finds no path, the console says so and the colleague walks
   * straight, so a gap in a layout shows instead of freezing someone.
   *
   * Getting up and sitting down are slides, not steps. A desk's chair has the
   * desk in front of it and its back behind it, so a colleague slides off it
   * to the place beside it, and onto it from there. Any other seat inside an
   * obstacle is left and entered by the nearest place to stand, which for an
   * armchair is in front of it.
   */
  const walkTo = (actor: Actor, to: Spot, sitAction: Action | null = null): Promise<void> => {
    const start = actor.rig.object.position.clone();
    const seated = SEATED.has(actor.action);
    const exit =
      seated && actor.place === "home" && actor.home.kind === "desk"
        ? findBesideSeat(actor.home, to.position)
        : null;
    const entry = sitAction !== null && isDeskSeat(to) ? findBesideSeat(to, exit ?? start) : null;
    const from: Spot = { position: exit ?? start, facing: actor.yaw, floor: actor.floor };
    const goal: Spot =
      entry === null ? to : { position: entry, facing: to.facing, floor: to.floor };
    let path = nav.findPath(from, goal);
    if (path === null) {
      const key = `${actor.colleague.id}>${to.position.x.toFixed(1)},${to.position.z.toFixed(1)}`;
      if (!warned.has(key)) {
        warned.add(key);
        console.warn(
          `The nav graph has no path for ${actor.colleague.name} to (${to.position.x.toFixed(2)}, ${to.position.z.toFixed(2)}) on floor ${String(to.floor)}; it walks straight.`,
        );
      }
      path = [
        { position: from.position, floor: from.floor },
        { position: goal.position.clone(), floor: goal.floor },
      ];
    }
    // Any other seat inside an obstacle is the path's own first or last step,
    // from or to the nearest place to stand; that step is slid, not walked.
    const legs: Leg[] = [];
    let first = 0;
    let last = path.length;
    if (seated) {
      let end = exit ?? start;
      const out = path[1]?.position;
      if (
        exit === null &&
        out !== undefined &&
        !isWalkable(start, actor.floor) &&
        start.distanceTo(out) <= MAX_GLIDE
      ) {
        first = 1;
        end = out;
      }
      legs.push({
        kind: "glide",
        from: start,
        to: end,
        seconds: Math.max(STAND_UP_SECONDS, start.distanceTo(end) / GLIDE_SPEED),
        facing: null,
        action: "stand",
      });
    }
    let sitDown: GlideLeg | null = null;
    if (sitAction !== null) {
      let begin = entry ?? to.position;
      const enter = path[last - 2]?.position;
      if (
        entry === null &&
        enter !== undefined &&
        last - first >= 2 &&
        !isWalkable(to.position, to.floor) &&
        enter.distanceTo(to.position) <= MAX_GLIDE
      ) {
        last--;
        begin = enter;
      }
      sitDown = {
        kind: "glide",
        from: begin,
        to: to.position,
        seconds: Math.max(SIT_DOWN_SECONDS, begin.distanceTo(to.position) / GLIDE_SPEED),
        facing: to.facing,
        action: sitAction,
      };
    }
    // A walk that starts where it ends, as from a desk's chair to the place
    // beside it, has no steps to take.
    if (last > first) {
      const walk = buildWalkLeg(path.slice(first, last).map((waypoint) => waypoint.position));
      if (walk.length > 0.01) legs.push(walk);
    }
    if (sitDown !== null) legs.push(sitDown);
    actor.place = "elsewhere";
    const route = [start, ...legs.flatMap((leg) => (leg.kind === "walk" ? leg.points : [leg.to]))];
    return startWalk(actor, (finish) => ({
      legs,
      route,
      leg: 0,
      progress: 0,
      speed: 0,
      facing: to.facing,
      finish,
    }));
  };

  /** Holds a colleague back until no one else has set off within `DEPARTURE_GAP_SECONDS`. */
  const awaitDeparture = async (actor: Actor): Promise<void> => {
    const now = performance.now() / 1000;
    const at = Math.max(now, nextDepartureAt);
    nextDepartureAt = at + DEPARTURE_GAP_SECONDS;
    if (at > now) await wait(actor, at - now);
  };

  /** Walks a colleague to its own seat and sits it down to `action`. */
  const walkHome = async (
    actor: Actor,
    action: Action = decideHomeAction(actor.pose, actor.home.kind),
  ): Promise<void> => {
    await walkTo(actor, actor.home, SEATED.has(action) ? action : null);
    actor.place = "home";
    setAction(actor, action);
    setCup(actor, action === "sip");
  };

  // -- Frames --------------------------------------------------------------

  /**
   * Turns a colleague's heading toward `yaw` for one frame, quickly at first
   * and gently at the end. Returns the angle still to turn.
   */
  const turnToward = (actor: Actor, yaw: number, dt: number): number => {
    const difference = wrapAngle(yaw - actor.yaw);
    const limit = MAX_TURN_SPEED * dt;
    const step = Math.max(-limit, Math.min(limit, difference * (1 - Math.exp(-TURN_RATE * dt))));
    const rest = Math.abs(difference - step) < SETTLED_ANGLE ? 0 : difference - step;
    actor.yaw = wrapAngle(yaw - rest);
    actor.rig.object.rotation.y = actor.yaw;
    return rest;
  };

  const setCadence = (actor: Actor, speed: number): void => {
    if (Math.abs(speed - actor.walkCadence) < 0.02) return;
    actor.walkCadence = speed;
    actor.rig.setWalkSpeed(speed);
  };

  /** Advances a walk by one frame. */
  const advanceWalk = (actor: Actor, walk: Walk, dt: number): void => {
    const position = actor.rig.object.position;
    const leg = walk.legs[walk.leg];
    if (leg === undefined) {
      // Arrived: settle into the spot's facing, then the walk is done.
      if (turnToward(actor, walk.facing, dt) === 0) walk.finish();
      return;
    }
    if (leg.kind === "glide") {
      // Turns to the seat's facing on its feet first, then slides and sits.
      if (walk.progress === 0 && leg.facing !== null) {
        if (Math.abs(turnToward(actor, leg.facing, dt)) > 0.2) {
          setAction(actor, "walk");
          setCadence(actor, TURNING_CADENCE);
          return;
        }
      }
      setAction(actor, leg.action);
      walk.progress = Math.min(leg.seconds, walk.progress + dt);
      const t = walk.progress / leg.seconds;
      position.lerpVectors(leg.from, leg.to, t * t * (3 - 2 * t));
      if (leg.facing !== null) turnToward(actor, leg.facing, dt);
      if (walk.progress < leg.seconds) return;
      walk.leg++;
      walk.progress = 0;
      return;
    }
    setAction(actor, "walk");
    const next = walk.legs[walk.leg + 1];
    const remaining = leg.length - walk.progress;
    sampleLeg(leg, Math.min(leg.length, walk.progress + LOOK_AHEAD), scratch).sub(position);
    const heading =
      scratch.x * scratch.x + scratch.z * scratch.z > 1e-6
        ? Math.atan2(scratch.x, scratch.z)
        : actor.yaw;
    const misalignment = Math.abs(turnToward(actor, heading, dt));
    // Full speed while the body points along the path; on the spot while it
    // still faces away, as when it gets up from a desk.
    let target = WALK_SPEED * Math.min(1, Math.max(0, 1 - (misalignment - 0.3) / 0.9));
    if (next?.kind !== "walk") {
      target = Math.min(target, Math.sqrt(2 * BRAKING * remaining) + ARRIVAL_SPEED);
    }
    walk.speed =
      target > walk.speed
        ? Math.min(target, walk.speed + ACCELERATION * dt)
        : Math.max(target, walk.speed - ACCELERATION * 2 * dt);
    walk.progress = Math.min(leg.length, walk.progress + walk.speed * dt);
    sampleLeg(leg, walk.progress, position);
    setCadence(actor, Math.max(walk.speed, TURNING_CADENCE));
    if (walk.progress < leg.length) return;
    walk.leg++;
    walk.progress = 0;
    walk.speed = 0;
    if (next === undefined) setAction(actor, "stand");
  };

  /** Advances a colleague's walk by one frame. Returns true while it walks. */
  const advanceMotion = (actor: Actor, dt: number): boolean => {
    if (actor.motion === null) return false;
    advanceWalk(actor, actor.motion, dt);
    return true;
  };

  // -- Places --------------------------------------------------------------

  /**
   * Returns a free place to stand beside a seat, nearest to `near` among the
   * best that are walkable: level with the sitter at the desk's end first,
   * then a step behind, then right behind the chair. Returns null when
   * furniture or walls crowd every one of them.
   */
  const findBesideSeat = (seat: Seat, near: Vector3): Vector3 | null => {
    const forwardX = Math.sin(seat.facing);
    const forwardZ = Math.cos(seat.facing);
    for (const tier of BESIDE_SEAT) {
      const candidates = tier
        .map(
          ([sideways, forward]) =>
            new Vector3(
              seat.position.x + forwardZ * sideways + forwardX * forward,
              seat.position.y,
              seat.position.z - forwardX * sideways + forwardZ * forward,
            ),
        )
        .filter((position) => isWalkable(position, seat.floor))
        .sort((a, b) => a.distanceTo(near) - b.distanceTo(near));
      if (candidates[0] !== undefined) return candidates[0];
    }
    return null;
  };

  /** Returns the spots near the entrance where colleagues who are away stand, nearest first. */
  const listEntranceSpots = (): Vector3[] => {
    const { position, facing, floor } = spots.entrance;
    const forwardX = Math.sin(facing);
    const forwardZ = Math.cos(facing);
    const found: Vector3[] = [];
    for (const forward of [0.9, 1.6]) {
      for (const sideways of [0.65, -0.65, 1.3, -1.3, 1.95, -1.95]) {
        const candidate = new Vector3(
          position.x + forwardZ * sideways + forwardX * forward,
          position.y,
          position.z - forwardX * sideways + forwardZ * forward,
        );
        if (isWalkable(candidate, floor)) found.push(candidate);
      }
    }
    return found;
  };

  /** Returns the free lounge armchairs, the ones on `floor` first, nearest to `near` first. */
  const listFreeLoungeSeats = (floor: number, near: Vector3): Seat[] =>
    spots.lounge
      .filter((seat) => !loungeTaken.has(seat))
      .sort(
        (a, b) =>
          Number(a.floor !== floor) - Number(b.floor !== floor) ||
          a.position.distanceTo(near) - b.position.distanceTo(near),
      );

  const takeLoungeSeat = (actor: Actor, seat: Seat): void => {
    loungeTaken.set(seat, actor);
    actor.loungeSeat = seat;
  };

  // -- The queue -----------------------------------------------------------

  /** Settles a colleague into its place in the queue: it holds its disc, and the head raises a hand. */
  const settleInQueue = (actor: Actor, slot: number): void => {
    actor.place = "queue";
    actor.releaseDisc?.();
    actor.releaseDisc =
      officeNav?.occupy(actor.floor, actor.rig.object.position, QUEUE_DISC_RADIUS) ?? null;
    setAction(actor, slot === 0 ? "raise-hand" : "stand");
  };

  /** Walks a colleague to a place in the queue, after `delay` seconds. */
  const walkToQueue = (actor: Actor, slot: number, delay: number): void => {
    run(actor, "queue", async () => {
      // Someone already standing in the queue waits its turn to step up;
      // someone still on the way changes course at once.
      if (actor.releaseDisc !== null && delay > 0) await wait(actor, delay);
      actor.releaseDisc?.();
      actor.releaseDisc = null;
      await walkTo(actor, spots.queue[slot]!);
      settleInQueue(actor, slot);
    });
  };

  /** Returns the colleagues who wait on the user away from the queue, the longest waiting first. */
  const listDeskWaiters = (): Actor[] =>
    [...actors.values()]
      .filter((actor) => actor.pose === "waiting" && !queue.includes(actor))
      .sort((a, b) => a.ticket - b.ticket);

  /** Stands a waiting colleague beside its desk with a raised hand: the queue is full. */
  const waitAtDesk = (actor: Actor): void => {
    run(actor, "desk-wait", async () => {
      await walkTo(actor, {
        position:
          findBesideSeat(actor.home, actor.rig.object.position) ?? actor.home.position.clone(),
        facing: TOWARD_USER,
        floor: actor.home.floor,
      });
      actor.place = "desk-side";
      setAction(actor, "raise-hand");
    });
  };

  /** Sends a colleague who now waits on the user to the back of the queue, or to its desk when it is full. */
  const joinQueue = (actor: Actor): void => {
    const slot = queue.indexOf(null);
    if (slot === -1) {
      waitAtDesk(actor);
      return;
    }
    queue[slot] = actor;
    walkToQueue(actor, slot, 0);
  };

  /**
   * Takes a colleague out of the queue. After `delay` seconds, the ones
   * behind it step up one place each, front first and a moment apart, and
   * the longest-waiting colleague at a desk walks in to fill the back.
   */
  const leaveQueue = (actor: Actor, delay: number): void => {
    const slot = queue.indexOf(actor);
    if (slot === -1) return;
    actor.releaseDisc?.();
    actor.releaseDisc = null;
    queue[slot] = null;
    let stepping = 0;
    for (let index = slot + 1; index < queue.length; index++) {
      const member = queue[index];
      if (member == null) continue;
      const free = queue.indexOf(null);
      queue[index] = null;
      queue[free] = member;
      walkToQueue(member, free, delay + stepping * QUEUE_STEP_SECONDS);
      stepping++;
    }
    const back = queue.indexOf(null);
    const next = listDeskWaiters().find((waiter) => waiter !== actor);
    if (back === -1 || next === undefined) return;
    queue[back] = next;
    run(next, "queue", async () => {
      await wait(next, delay + stepping * QUEUE_STEP_SECONDS + 0.3);
      await walkTo(next, spots.queue[back]!);
      settleInQueue(next, back);
    });
  };

  /** Glances now and then from someone in the queue at its head, while the office is lively. */
  const scheduleGlance = (): void => {
    if (liveliness === 0) return;
    glanceTimer = schedule(pickRandomBetween(...GLANCE_GAP_SECONDS), () => {
      const head = queue[0];
      const glancer = pickRandom(
        queue.filter(
          (member): member is Actor =>
            member !== null &&
            member !== head &&
            member.place === "queue" &&
            member.motion === null,
        ),
      );
      if (head != null && glancer !== undefined && head.place === "queue") {
        glancer.rig.lookAt(findEyePoint(head));
        schedule(GLANCE_SECONDS, () => {
          if (glancer.place === "queue") glancer.rig.lookAt(null);
        });
      }
      scheduleGlance();
    });
  };

  // -- Behaviours ----------------------------------------------------------

  /** Picks a random settled colleague that `accept` takes. */
  const pickSettled = (accept: (actor: Actor) => boolean): Actor | undefined =>
    pickRandom([...actors.values()].filter((actor) => isSettled(actor) && accept(actor)));

  /**
   * Sends `visitor` to `host`'s desk: the visitor stands beside it, and the
   * two talk for a few seconds, looking at each other; then the visitor walks
   * back. The host stays seated: it stops what it does and turns its head.
   */
  const visit = (visitor: Actor, host: Actor): void => {
    if (visitor === host) return;
    run(visitor, "visit", async () => {
      await awaitDeparture(visitor);
      const position =
        findBesideSeat(host.home, visitor.rig.object.position) ?? host.home.position.clone();
      await walkTo(visitor, {
        position,
        facing: computeYawToward(position, host.home.position),
        floor: host.home.floor,
      });
      const hostAtHome = isSettled(host) && host.place === "home";
      const hostAction = host.action;
      if (hostAtHome) {
        host.hosting = true;
        if (SEATED.has(hostAction)) setAction(host, "sit");
      }
      try {
        visitor.rig.lookAt(findEyePoint(host));
        host.rig.lookAt(findEyePoint(visitor));
        setAction(visitor, "talk");
        await wait(visitor, VISIT_SECONDS[0]);
        setAction(visitor, "listen");
        await wait(visitor, VISIT_SECONDS[1]);
        setAction(visitor, "talk");
        await wait(visitor, VISIT_SECONDS[2]);
      } finally {
        visitor.rig.lookAt(null);
        if (hostAtHome) {
          host.hosting = false;
          host.rig.lookAt(null);
          if (host.errand === null && host.place === "home") setAction(host, hostAction);
          stage.requestRender();
        }
      }
      setAction(visitor, "stand");
      await wait(visitor, 0.3);
      await walkHome(visitor);
    });
  };

  /** Finds the scripted visit's pair: Ada, and the colleague investigating the backup timeouts. */
  const findScriptedVisit = (): readonly [Actor, Actor] | null => {
    const all = [...actors.values()];
    const ada = all.find(
      ({ colleague }) => colleague.role === "assistant" && colleague.name === "Ada",
    );
    const host = all.find(({ colleague }) => colleague.title === "Investigate backup timeouts");
    return ada !== undefined && host !== undefined ? [ada, host] : null;
  };

  /** Plays a visit: the scripted one, or else two settled colleagues of one room. */
  const triggerVisit = (): void => {
    const scripted = findScriptedVisit();
    if (scripted !== null) {
      visit(...scripted);
      return;
    }
    visitWithinRoom();
  };

  /**
   * Sends a settled colleague to visit another one in the same room. Returns
   * false when no pair is free.
   */
  const visitWithinRoom = (): boolean => {
    const visitor = pickSettled(
      (actor) => actor.place === "home" && (actor.pose === "working" || actor.pose === "idle"),
    );
    if (visitor === undefined) return false;
    const host = pickSettled(
      (actor) =>
        actor !== visitor &&
        actor.place === "home" &&
        actor.home.roomId === visitor.home.roomId &&
        actor.pose !== "asleep",
    );
    if (host === undefined) return false;
    visit(visitor, host);
    return true;
  };

  /**
   * Sends Triage to the case board to pin every Proposal waiting for it, and
   * back. Without a board, the cards are pinned at once.
   */
  const pinProposals = (): void => {
    const triage = [...actors.values()].find((actor) => actor.colleague.role === "triage");
    const board = spots.caseBoard;
    if (triage === undefined || board === null) {
      for (; pinsWaiting > 0; pinsWaiting--) layout.pinProposal?.();
      return;
    }
    if (triage.errand === "pin") return;
    run(triage, "pin", async () => {
      await walkTo(triage, board);
      while (pinsWaiting > 0) {
        setAction(triage, "pin");
        await wait(triage, PIN_SECONDS * 0.6);
        layout.pinProposal?.();
        pinsWaiting--;
        await wait(triage, PIN_SECONDS * 0.4);
      }
      setAction(triage, "stand");
      await wait(triage, 0.4);
      await walkHome(triage);
    });
  };

  /**
   * Plays an event arriving: its capsule runs through the tubes, and Triage
   * pins a Proposal when it lands.
   */
  const receiveEvent = (): void => {
    const seconds = layout.sendCapsule?.() ?? 0;
    schedule(seconds, () => {
      pinsWaiting++;
      pinProposals();
    });
  };

  /**
   * Sends a colleague to fetch tea from the trolley and sip it at its desk.
   * Returns false when no one can.
   */
  const fetchTea = (): boolean => {
    const tea = spots.tea;
    if (tea === null || teaTaken) return false;
    const actor = pickSettled(
      (candidate) =>
        candidate.place === "home" &&
        candidate.home.kind === "desk" &&
        (candidate.pose === "idle" || candidate.pose === "working"),
    );
    if (actor === undefined) return false;
    teaTaken = true;
    run(actor, "tea", async () => {
      try {
        await awaitDeparture(actor);
        setCup(actor, false);
        await walkTo(actor, tea);
        setAction(actor, "stand");
        await wait(actor, TEA_SECONDS);
      } finally {
        teaTaken = false;
      }
      await walkHome(actor, "sip");
      if (actor.pose !== "working") return;
      await wait(actor, TEA_BREAK_SECONDS);
      setCup(actor, false);
      setAction(actor, "type");
    });
    return true;
  };

  /** Walks an idle colleague to `seat`, a free Lounge armchair, and sits it down. */
  const walkToLounge = (actor: Actor, seat: Seat): void => {
    run(actor, "lounge", async () => {
      takeLoungeSeat(actor, seat);
      await awaitDeparture(actor);
      setCup(actor, false);
      await walkTo(actor, seat, Math.random() < 0.5 ? "sit" : "read");
      actor.place = "lounge";
    });
  };

  /**
   * Moves a colleague the world seats in the Lounge from its desk to an
   * armchair that came free. It sat at its desk because the Lounge was full
   * when it went idle. Returns false when no one can move.
   */
  const fillFreeLoungeSeat = (): boolean => {
    const leaving = pickSettled(
      (actor) =>
        loungeIds.has(actor.colleague.id) && actor.place === "home" && actor.pose === "idle",
    );
    if (leaving === undefined) return false;
    const seat = listFreeLoungeSeats(leaving.floor, leaving.rig.object.position)[0];
    if (seat === undefined) return false;
    walkToLounge(leaving, seat);
    return true;
  };

  /** Counts the colleagues out on an errand of their own, not counting the queue. */
  const countErrands = (): number => {
    let count = 0;
    for (const actor of actors.values()) {
      if (actor.errand === "visit" || actor.errand === "tea" || actor.errand === "lounge") count++;
    }
    return count;
  };

  /** Starts one small happening, if the office has room for another errand. */
  const startHappening = (): void => {
    if (countErrands() >= ERRAND_LIMIT[liveliness]) return;
    const happenings: Array<readonly [() => boolean, number]> = [
      [fetchTea, 3],
      [visitWithinRoom, 3],
      [fillFreeLoungeSeat, 2],
      [
        () => {
          if (spots.caseBoard === null) return false;
          receiveEvent();
          return true;
        },
        1,
      ],
    ];
    // Tries the happenings in a weighted random order until one can happen.
    const order = happenings
      .map(([happen, weight]) => ({ happen, key: Math.random() ** (1 / weight) }))
      .sort((a, b) => b.key - a.key);
    for (const { happen } of order) if (happen()) return;
  };

  const scheduleHappening = (): void => {
    if (liveliness === 0) return;
    happeningTimer = schedule(pickRandomBetween(...HAPPENING_GAP_SECONDS[liveliness]), () => {
      startHappening();
      scheduleHappening();
    });
  };

  // -- The office as it opens ----------------------------------------------

  for (const colleague of world.colleagues) {
    const rig = rigs.get(colleague.id);
    const home = layout.homes.get(colleague.id);
    if (rig === undefined || home === undefined) continue;
    actors.set(colleague.id, {
      colleague,
      rig,
      home,
      pose: colleague.pose,
      action: "stand",
      place: "home",
      floor: home.floor,
      yaw: home.facing,
      motion: null,
      errand: null,
      script: 0,
      hosting: false,
      ticket: 0,
      loungeSeat: null,
      releaseDisc: null,
      timers: new Set(),
      pending: new Set(),
      walkCadence: -1,
    });
  }

  /** Seats every colleague where its pose puts it when the office opens. */
  const placeEveryone = (): void => {
    const all = [...actors.values()];
    // The world's queue holds the waiting colleagues, the longest waiting first.
    const places = new Map(world.queue.map((id, place) => [id, place]));
    const findPlace = (actor: Actor): number => places.get(actor.colleague.id) ?? places.size;
    const waiting = all
      .filter((actor) => actor.pose === "waiting")
      .sort((a, b) => findPlace(a) - findPlace(b));
    waiting.forEach((actor) => (actor.ticket = nextTicket++));
    const sleepers = all.filter((actor) => actor.pose === "asleep");
    const entranceSpots = listEntranceSpots();

    for (const actor of all) {
      const { rig, home } = actor;
      setPose(actor, actor.pose);
      placeAt(actor, home.position, home.floor, home.facing);
      actor.place = "home";
      if (actor.pose === "waiting") {
        const slot = waiting.indexOf(actor);
        const spot = spots.queue[slot];
        if (spot !== undefined) {
          queue[slot] = actor;
          placeAt(actor, spot.position, spot.floor, spot.facing);
          settleInQueue(actor, slot);
        } else {
          const position = findBesideSeat(home, home.position) ?? home.position.clone();
          placeAt(actor, position, home.floor, TOWARD_USER);
          actor.place = "desk-side";
          setAction(actor, "raise-hand");
        }
        continue;
      }
      if (actor.pose === "away") {
        const position = entranceSpots.shift() ?? spots.entrance.position;
        placeAt(actor, position, spots.entrance.floor, spots.entrance.facing);
        actor.place = "entrance";
        setAction(actor, "stand");
        continue;
      }
      // The colleagues the world seats in the Lounge sit there while it has
      // armchairs; the rest sit at their desks until one comes free.
      if (sleepers.includes(actor) || loungeIds.has(actor.colleague.id)) {
        const seat = listFreeLoungeSeats(home.floor, home.position)[0];
        if (seat !== undefined) {
          takeLoungeSeat(actor, seat);
          placeAt(actor, seat.position, seat.floor, seat.facing);
          actor.place = "lounge";
          setAction(actor, actor.pose === "asleep" ? "sleep" : "sit");
          continue;
        }
      }
      const action = decideHomeAction(actor.pose, home.kind);
      setAction(actor, action);
      setCup(actor, action === "sip");
      // The rig's own transition into its first action is not shown: the
      // office opens with everyone already in place.
      void rig;
    }
  };

  placeEveryone();

  // -- Changes the world makes ----------------------------------------------

  /** Takes a colleague out of the queue: it hops, and walks back to its desk. */
  const walkBackFromQueue = (actor: Actor): void => {
    leaveQueue(actor, QUEUE_CLOSE_SECONDS);
    run(actor, "answer", async () => {
      setAction(actor, "hop");
      await wait(actor, HOP_SECONDS);
      setAction(actor, "stand");
      await walkHome(actor);
    });
  };

  /**
   * Sends a colleague to its own seat to do what its pose does there. A
   * colleague already sitting there only changes what it does, without
   * getting up.
   */
  const sendHome = (actor: Actor): void => {
    if (actor.place === "home" && actor.errand === null) {
      const action = decideHomeAction(actor.pose, actor.home.kind);
      setAction(actor, action);
      setCup(actor, action === "sip");
      return;
    }
    run(actor, "home", () => walkHome(actor));
  };

  const setColleagueState = (colleagueId: string, state: ColleagueState, inLounge: boolean) => {
    const actor = actors.get(colleagueId);
    if (actor === undefined) return;
    if (inLounge) loungeIds.add(colleagueId);
    else loungeIds.delete(colleagueId);
    const from = actor.pose;
    // The state goes in first, so the pose set below keeps the world's
    // request and label instead of making its own.
    recordState(colleagueId, state);
    if (state.pose === from) return;
    setPose(actor, state.pose);
    if (state.pose === "waiting") {
      actor.ticket = nextTicket++;
      setCup(actor, false);
      joinQueue(actor);
    } else if (from === "waiting" && state.pose === "working") {
      walkBackFromQueue(actor);
    } else {
      const seat =
        state.pose === "idle" && inLounge
          ? listFreeLoungeSeats(actor.floor, actor.rig.object.position)[0]
          : undefined;
      if (seat === undefined) sendHome(actor);
      else walkToLounge(actor, seat);
    }
    stage.requestRender();
  };

  // -- The contract ----------------------------------------------------------

  return {
    update(frame: Frame) {
      let moving = false;
      for (const actor of actors.values()) moving = advanceMotion(actor, frame.dt) || moving;
      for (const rig of rigs.values()) moving = rig.update(frame) || moving;
      return moving;
    },

    setColleagueState,

    setLiveliness(level) {
      liveliness = level;
      stopTimer(happeningTimer);
      stopTimer(glanceTimer);
      scheduleHappening();
      scheduleGlance();
      // Ada's scripted visit is ambient life too: an office that stands still
      // does not send her, and sends her later if it comes to life again.
      if (level === 0 && adaVisitTimer !== 0) {
        stopTimer(adaVisitTimer);
        adaVisitTimer = 0;
        adaVisitScheduled = false;
      }
      if (level > 0 && !adaVisitScheduled) {
        adaVisitScheduled = true;
        adaVisitTimer = schedule(ADA_VISIT_DELAY_SECONDS, () => {
          adaVisitTimer = 0;
          triggerVisit();
        });
      }
    },

    readStates() {
      return states;
    },

    readFloor(colleagueId) {
      return actors.get(colleagueId)?.floor ?? null;
    },

    subscribeStates(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },

    readWalkPaths() {
      const paths = new Map<string, ReadonlyArray<Vector3>>();
      for (const actor of actors.values()) {
        if (actor.motion !== null) paths.set(actor.colleague.id, actor.motion.route);
      }
      return paths;
    },

    listWaitingColleagues() {
      return [
        ...queue.filter((member): member is Actor => member !== null),
        ...listDeskWaiters(),
      ].map((actor) => actor.colleague.id);
    },

    dispose() {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      for (const timer of timers.values()) window.clearTimeout(timer.handle);
      timers.clear();
      for (const actor of actors.values()) {
        cancelScript(actor);
        actor.releaseDisc?.();
        actor.releaseDisc = null;
      }
      stateListeners.clear();
    },
  };
}
