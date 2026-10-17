/**
 * The office's life: where every colleague is when the office
 * opens, and every walk after that, from the queue at the user's desk to a
 * cup of tea.
 *
 * Each colleague is an actor that runs one script at a time: a short
 * generator that walks, waits and changes actions ("stand up, walk to the
 * queue, raise a hand"). The script yields each walk or wait, and the sim
 * steps it on once that is done. A new script replaces the one before it
 * wherever it was, and starts from where the colleague stands; the old one
 * never takes another step, and its `finally` blocks run at once. Walking and turning
 * advance with the frames; every other wait is a timer that asks the stage
 * for a frame when it fires, so an office where nobody walks draws nothing
 * between happenings.
 */
import { Vector3 } from "three";
import type {
  Action,
  BuildSim,
  BuiltOffice,
  ColleagueRig,
  ColleagueState,
  RoomInfo,
  Seat,
  Spot,
} from "./contracts";
import { ARRIVAL_WALK_SPEED, HOP_SECONDS, STRETCH_SECONDS, WALK_SPEED } from "./contracts";
import { isOfficeNavGraph } from "./nav";
import type { Frame } from "./stage";
import { isAbsentPose, isRestingPose, type OfficePose } from "@hercule/client-core";
import { isSameColleagueState } from "../world/build-world";
import type { Colleague } from "../world/types";

// ---------------------------------------------------------------------------
// Timings, in seconds.

/** Getting up from a seat, at the least. */
const STAND_UP_SECONDS = 0.5;
/** Sitting down onto a seat, at the least. */
const SIT_DOWN_SECONDS = 0.55;
/**
 * How long an answered colleague stays on the spot before it walks home: its
 * hop, plus a beat to land and settle before the first step.
 */
const HOP_AND_SETTLE_SECONDS = HOP_SECONDS + 0.28;
/** Between two colleagues of the queue stepping forward. */
const QUEUE_STEP_SECONDS = 0.35;
/** Between an answered colleague's hop and the queue moving up behind it. */
const QUEUE_CLOSE_SECONDS = HOP_AND_SETTLE_SECONDS + 0.7;
/** The least time between two colleagues setting off on an errand, so no two start at once. */
const DEPARTURE_GAP_SECONDS = 0.7;
/** A visit's exchange: the visitor talks, listens, and talks again. */
const VISIT_SECONDS = [2.2, 1.8, 1.1] as const;
/** At the tea trolley. */
const TEA_SECONDS = 2.6;
/** Sipping the fetched tea before a working colleague types again. */
const TEA_BREAK_SECONDS = 16;
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
const SEATED: ReadonlySet<Action> = new Set<Action>(["sit", "type", "read", "sip", "doze"]);

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

/**
 * What an actor's script is doing, so the happenings leave busy colleagues
 * alone. An actor is hidden while its errand is `arrive`: it waits its turn
 * to walk in from the street.
 */
type Errand =
  | "queue"
  | "desk-wait"
  | "answer"
  | "visit"
  | "tea"
  | "lounge"
  | "home"
  | "arrive"
  | "leave";

/** Where an actor rests between scripts. */
type Place = "home" | "armchair" | "lounge" | "queue" | "desk-side" | "elsewhere";

/**
 * Where a colleague's state puts it at rest: its own seat (its desk, or its
 * armchair while it is asleep or away), a Lounge armchair, a place in the
 * queue, or beside its desk while it waits and the queue is full.
 */
type RestingPlace =
  | { readonly kind: "seat" }
  | { readonly kind: "lounge"; readonly seat: Seat }
  | { readonly kind: "queue"; readonly slot: number }
  | { readonly kind: "desk-side" };

/** Checks whether a colleague resting at `place` rests at a resting place of `kind`. */
function isPlaceOfKind(place: Place, kind: RestingPlace["kind"]): boolean {
  switch (kind) {
    case "seat":
      return place === "home" || place === "armchair";
    case "lounge":
      return place === "lounge";
    case "queue":
      return place === "queue";
    case "desk-side":
      return place === "desk-side";
  }
}

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
  leg: number;
  /** Metres along a walk leg, or seconds into a glide. */
  progress: number;
  speed: number;
  /** The speed it walks at once under way, m/s. */
  readonly topSpeed: number;
  /** The heading to settle into at the end. */
  readonly facing: number;
  readonly finish: () => void;
}

/** One colleague as the sim runs it. */
interface Actor {
  /** The colleague as the latest world holds it, or as the last one did while it walks out. */
  colleague: Colleague;
  readonly rig: ColleagueRig;
  /** Its seat in the building standing now. */
  home: Seat;
  /** Its own armchair, where it dozes while asleep or away. Only an assistant has one. */
  armchair: Seat | null;
  /** The world's `lounge` holds it: it rests in the Lounge rather than at its seat. */
  inLounge: boolean;
  /** The world no longer holds it: it walks out to the street, where it is removed. */
  leaving: boolean;
  /** Called when its turn comes to set off, while its script waits in line for it; else null. */
  onTurn: (() => void) | null;
  /**
   * It has set off and not yet arrived: the door let it through, or a walk
   * started. A newer script lets it carry on without waiting at the door again.
   */
  onItsWay: boolean;
  /** It walks in from the front pavement at the brisk speed, until its first walk ends. */
  walksInBriskly: boolean;
  pose: OfficePose;
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
  /** The script it runs, or null. */
  steps: Script | null;
  /** True while its script takes a step, which may start a newer script for it. */
  stepping: boolean;
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

/**
 * A colleague's script. It yields each step it waits on, a walk or a timer,
 * and the sim steps it on once the step is done.
 */
type Script = Generator<Promise<void>, void, void>;

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

/**
 * Returns what an awake colleague put straight into a Lounge armchair does:
 * what it already did, when that is done seated and is not a doze, and
 * otherwise it sits.
 */
function keepLoungeAction(action: Action): Action {
  return SEATED.has(action) && action !== "doze" ? action : "sit";
}

/** Returns the action a colleague does at its own seat in a pose. */
function decideHomeAction(pose: OfficePose, seat: Seat["kind"]): Action {
  if (seat === "standing") return pose === "waiting" ? "raise-hand" : "stand";
  switch (pose) {
    case "asleep":
    case "away":
      return "doze";
    case "working":
      return seat === "armchair" ? "read" : "type";
    case "idle":
    case "done":
      return "sip";
    case "waiting":
      return "raise-hand";
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

/**
 * Returns `colleagues` in the order `queue` holds their ids, the longest
 * waiting first, and then the colleagues `queue` lacks, in their own order.
 */
function sortByQueue(
  colleagues: ReadonlyArray<Colleague>,
  queue: ReadonlyArray<string>,
): Colleague[] {
  const places = new Map(queue.map((id, place) => [id, place]));
  const findPlace = ({ id }: Colleague): number => places.get(id) ?? places.size;
  return [...colleagues].sort((a, b) => findPlace(a) - findPlace(b));
}

/** Returns the state the sim holds for a colleague as the world gives it. */
function buildColleagueState({ pose, request, stateLabel }: Colleague): ColleagueState {
  return { pose, request, stateLabel };
}

/**
 * Returns the point of a new building at the same spot in its room as
 * `position` in the old one, whose rooms are `from`. The point moves as far
 * as the centre of its room moved between the two buildings. A point in no
 * room, such as in a corridor or on the pavement, moves with the nearest
 * room. A point whose room the new building lacks stays where it is.
 */
function findSameSpotInRoom(
  position: Vector3,
  from: ReadonlyArray<RoomInfo>,
  to: ReadonlyArray<RoomInfo>,
): Vector3 {
  let nearest: RoomInfo | undefined;
  let nearestDistance = Infinity;
  for (const room of from) {
    const distance = room.bounds.distanceToPoint(position);
    if (distance >= nearestDistance) continue;
    nearest = room;
    nearestDistance = distance;
  }
  const moved = to.find((room) => room.id === nearest?.id);
  if (nearest === undefined || moved === undefined) return position.clone();
  return position
    .clone()
    .add(moved.bounds.getCenter(new Vector3()))
    .sub(nearest.bounds.getCenter(new Vector3()))
    .setY(position.y);
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

/** Builds the sim that runs the office's colleagues. */
export const buildSim: BuildSim = ({ world, office: firstOffice, rigs, stage, onDeparted }) => {
  // The building the colleagues stand in now, and what the sim reads of it.
  let office = firstOffice;
  let spots = office.spots;
  let nav = office.nav;
  let officeNav = isOfficeNavGraph(nav) ? nav : null;
  const actors = new Map<string, Actor>();
  let queue: Array<Actor | null> = spots.queue.map(() => null);
  const loungeTaken = new Map<Seat, Actor>();
  const timers = new Map<number, SimTimer>();
  let lastTimerId = 0;
  const warned = new Set<string>();
  let disposed = false;
  let liveliness: 0 | 1 | 2 = 0;
  let happeningTimer = 0;
  let glanceTimer = 0;
  let nextTicket = 0;
  // The colleagues' states the UI reads. The map is replaced on every change,
  // never edited, so a reader sees a change as a new map.
  let states: ReadonlyMap<string, ColleagueState> = new Map(
    world.colleagues.map((colleague) => [colleague.id, buildColleagueState(colleague)]),
  );
  const stateListeners = new Set<() => void>();
  /**
   * The colleagues waiting in line for their turn to set off, the first in
   * line first, so no two set off at once.
   */
  const line: Actor[] = [];
  /** True for `DEPARTURE_GAP_SECONDS` after a colleague set off. */
  let doorBusy = false;
  let teaTaken = false;
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

  /** Removes a colleague's state from the states the UI reads, and calls the state listeners. */
  const forgetState = (id: string): void => {
    const next = new Map(states);
    next.delete(id);
    states = next;
    for (const listener of stateListeners) listener();
  };

  /** Sets a colleague's pose: its face, and the lamp and note on its desk. */
  const setPose = (actor: Actor, pose: OfficePose): void => {
    actor.pose = pose;
    actor.rig.setFace(pose);
    actor.home.desk?.setLamp(pose === "working");
    actor.home.desk?.setNote(pose === "waiting");
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

  /**
   * Stops a colleague's script: its timers and its walk stop, it never
   * takes another step, and its `finally` blocks run now. A script that
   * stops itself, by starting a newer one, finishes its step first; `run`
   * then ends it.
   */
  const stopScript = (actor: Actor): void => {
    for (const timer of actor.timers) stopTimer(timer);
    actor.timers.clear();
    actor.motion = null;
    leaveLine(actor);
    actor.script++;
    actor.errand = null;
    const steps = actor.steps;
    actor.steps = null;
    if (!actor.stepping) steps?.return();
  };

  /**
   * Starts a script for a colleague, cancelling the one it runs. A script
   * that is not about the queue takes the colleague out of it first, and
   * every script gives up the lounge armchair or tea trolley it held.
   */
  const run = (actor: Actor, errand: Errand, script: () => Script): void => {
    if (disposed) return;
    stopScript(actor);
    if (errand !== "queue") leaveQueue(actor, 0.6);
    if (actor.loungeSeat !== null) {
      loungeTaken.delete(actor.loungeSeat);
      actor.loungeSeat = null;
    }
    if (actor.place === "lounge") actor.place = "elsewhere";
    actor.rig.object.visible = errand !== "arrive";
    const id = actor.script;
    const steps = script();
    actor.errand = errand;
    actor.steps = steps;
    /** Steps the script on, unless a newer script replaced it. */
    const step = (): void => {
      if (actor.script !== id) return;
      let next: IteratorResult<Promise<void>>;
      actor.stepping = true;
      try {
        next = steps.next();
      } catch (error) {
        // A bug in the script: the colleague stops where it was, and the
        // console is the only place the error shows.
        console.error(error);
        next = { done: true, value: undefined };
      } finally {
        actor.stepping = false;
      }
      if (actor.script !== id) {
        // The step started a newer script for the colleague, so this one ends.
        steps.return();
        return;
      }
      if (next.done) {
        actor.errand = null;
        actor.steps = null;
        return;
      }
      void next.value.then(step);
    };
    step();
    stage.requestRender();
  };

  /**
   * Returns a step that is done after `seconds`, for a colleague's script to
   * yield. Stopping the script stops the timer, so the step is then never done.
   */
  const wait = (actor: Actor, seconds: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = startTimer(seconds, () => {
        actor.timers.delete(timer);
        stage.requestRender();
        resolve();
      });
      actor.timers.add(timer);
    });

  /**
   * Starts a walk that the frames advance, and returns the step that is done
   * on arrival. Stopping the script drops the walk, so the step is then never done.
   */
  const startWalk = (actor: Actor, build: (finish: () => void) => Walk): Promise<void> =>
    new Promise((resolve) => {
      actor.onItsWay = true;
      actor.motion = build(() => {
        actor.motion = null;
        actor.onItsWay = false;
        resolve();
      });
      stage.requestRender();
    });

  /**
   * Walks a colleague to a spot along the nav graph's path, and turns it to
   * the spot's facing. A seated colleague gets up first. With `sitAction`,
   * the colleague sits down on the spot at the end and does that action.
   * When the graph finds no path, the console says so and the colleague walks
   * straight, so a gap in a map shows instead of freezing someone.
   *
   * Getting up and sitting down are slides, not steps. A desk's chair has the
   * desk in front of it and its back behind it, so a colleague slides off it
   * to the place beside it, and onto it from there. Any other seat inside an
   * obstacle is left and entered by the nearest place to stand, which for an
   * armchair is in front of it.
   *
   * A colleague that dozed stretches once it stands, before it walks off:
   * it is waking up.
   */
  const walkTo = (actor: Actor, to: Spot, sitAction: Action | null = null): Promise<void> => {
    const start = actor.rig.object.position.clone();
    const seated = SEATED.has(actor.action);
    const waking = actor.action === "doze";
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
      // A slide from where it stands to the same spot holds the stretch for its time.
      if (waking) {
        legs.push({
          kind: "glide",
          from: end,
          to: end,
          seconds: STRETCH_SECONDS,
          facing: null,
          action: "stretch",
        });
      }
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
    return startWalk(actor, (finish) => ({
      legs,
      leg: 0,
      progress: 0,
      speed: 0,
      topSpeed: actor.walksInBriskly ? ARRIVAL_WALK_SPEED : WALK_SPEED,
      facing: to.facing,
      finish() {
        actor.walksInBriskly = false;
        finish();
      },
    }));
  };

  /**
   * Lets the first colleague in line set off, unless one set off less than
   * `DEPARTURE_GAP_SECONDS` ago. The gap is a sim timer, so it waits while
   * the window is hidden, as the walks do.
   */
  const openDoor = (): void => {
    if (doorBusy) return;
    const next = line.shift();
    if (next === undefined) return;
    doorBusy = true;
    startTimer(DEPARTURE_GAP_SECONDS, () => {
      doorBusy = false;
      openDoor();
    });
    next.onItsWay = true;
    next.onTurn?.();
  };

  /** Takes a colleague out of the line, so the ones behind it move up. */
  const leaveLine = (actor: Actor): void => {
    const at = line.indexOf(actor);
    if (at !== -1) line.splice(at, 1);
    actor.onTurn = null;
  };

  /**
   * Holds a colleague back, within its script, until its turn to set off. A
   * colleague already on its way goes on at once; one walking in waits its
   * turn at the door.
   */
  const awaitDeparture = function* (actor: Actor): Script {
    if (actor.onItsWay) return;
    line.push(actor);
    yield new Promise<void>((resolve) => {
      actor.onTurn = resolve;
      openDoor();
    });
    actor.onTurn = null;
  };

  /**
   * Returns the seat a colleague's pose puts it on: its armchair while it
   * is asleep or away, when it has one, and its home seat otherwise.
   */
  const findOwnSeat = (actor: Actor): Seat =>
    isAbsentPose(actor.pose) && actor.armchair !== null ? actor.armchair : actor.home;

  /** Returns the place a colleague rests at once it sits on `seat`, one of its own. */
  const decideSeatPlace = (actor: Actor, seat: Seat): Place =>
    seat === actor.home ? "home" : "armchair";

  /** Walks a colleague to the seat its pose puts it on, and sits it down to `action`. */
  const walkHome = function* (actor: Actor, action?: Action): Script {
    const seat = findOwnSeat(actor);
    const doing = action ?? decideHomeAction(actor.pose, seat.kind);
    yield walkTo(actor, seat, SEATED.has(doing) ? doing : null);
    actor.place = decideSeatPlace(actor, seat);
    setAction(actor, doing);
    setCup(actor, doing === "sip");
  };

  /**
   * Sends a colleague to the seat its pose puts it on, to do what its pose
   * does there. A colleague already sitting there only changes what it
   * does, without getting up, as an assistant that goes from asleep to away
   * in its armchair.
   */
  const sendHome = (actor: Actor): void => {
    const seat = findOwnSeat(actor);
    if (actor.place === decideSeatPlace(actor, seat) && actor.errand === null) {
      const action = decideHomeAction(actor.pose, seat.kind);
      setAction(actor, action);
      setCup(actor, action === "sip");
      return;
    }
    run(actor, "home", () => walkHome(actor));
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
    let target = walk.topSpeed * Math.min(1, Math.max(0, 1 - (misalignment - 0.3) / 0.9));
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
    run(actor, "queue", function* () {
      // Someone already standing in the queue waits its turn to step up;
      // someone still on the way changes course at once.
      if (actor.releaseDisc !== null && delay > 0) yield wait(actor, delay);
      actor.releaseDisc?.();
      actor.releaseDisc = null;
      yield walkTo(actor, spots.queue[slot]!);
      settleInQueue(actor, slot);
    });
  };

  /**
   * Returns the colleagues who wait on the user away from the queue, the
   * longest waiting first. A colleague still on its way in, or walking out,
   * is not one of them.
   */
  const listDeskWaiters = (): Actor[] =>
    [...actors.values()]
      .filter(
        (actor) =>
          actor.pose === "waiting" &&
          !queue.includes(actor) &&
          !actor.leaving &&
          actor.errand !== "arrive",
      )
      .sort((a, b) => a.ticket - b.ticket);

  /** Stands a waiting colleague beside its desk with a raised hand: the queue is full. */
  const waitAtDesk = (actor: Actor): void => {
    run(actor, "desk-wait", function* () {
      yield walkTo(actor, {
        position:
          findBesideSeat(actor.home, actor.rig.object.position) ?? actor.home.position.clone(),
        facing: TOWARD_USER,
        floor: actor.home.floor,
      });
      actor.place = "desk-side";
      setAction(actor, "raise-hand");
    });
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
    run(next, "queue", function* () {
      yield wait(next, delay + stepping * QUEUE_STEP_SECONDS + 0.3);
      yield walkTo(next, spots.queue[back]!);
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
   * A host that has fallen asleep or gone away by then keeps dozing.
   */
  const visit = (visitor: Actor, host: Actor): void => {
    if (visitor === host) return;
    run(visitor, "visit", function* () {
      yield* awaitDeparture(visitor);
      const position =
        findBesideSeat(host.home, visitor.rig.object.position) ?? host.home.position.clone();
      yield walkTo(visitor, {
        position,
        facing: computeYawToward(position, host.home.position),
        floor: host.home.floor,
      });
      const hostAtHome = isSettled(host) && host.place === "home" && !isAbsentPose(host.pose);
      if (hostAtHome) {
        host.hosting = true;
        if (SEATED.has(host.action)) setAction(host, "sit");
      }
      try {
        visitor.rig.lookAt(findEyePoint(host));
        host.rig.lookAt(findEyePoint(visitor));
        setAction(visitor, "talk");
        yield wait(visitor, VISIT_SECONDS[0]);
        setAction(visitor, "listen");
        yield wait(visitor, VISIT_SECONDS[1]);
        setAction(visitor, "talk");
        yield wait(visitor, VISIT_SECONDS[2]);
      } finally {
        visitor.rig.lookAt(null);
        if (hostAtHome) {
          host.hosting = false;
          host.rig.lookAt(null);
          // The host's pose may have changed during the visit, so it goes
          // back to what its pose does now, not to what it did before.
          if (host.errand === null && host.place === "home") sendHome(host);
          stage.requestRender();
        }
      }
      setAction(visitor, "stand");
      yield wait(visitor, 0.3);
      yield* walkHome(visitor);
    });
  };

  /**
   * Sends a settled thread to visit another colleague in the same room.
   * Returns false when no pair is free. An asleep or away colleague dozes at
   * its desk, so it is never visited. An assistant never visits: it keeps
   * to its own desk, where it reads and sips, and leaves it only for tea.
   * Its room holds only assistants, so it is never a host either.
   */
  const visitWithinRoom = (): boolean => {
    const visitor = pickSettled(
      (actor) =>
        actor.colleague.kind === "thread" &&
        actor.place === "home" &&
        (actor.pose === "working" || actor.pose === "idle"),
    );
    if (visitor === undefined) return false;
    const host = pickSettled(
      (actor) =>
        actor !== visitor &&
        actor.place === "home" &&
        !isAbsentPose(actor.pose) &&
        actor.home.roomId === visitor.home.roomId,
    );
    if (host === undefined) return false;
    visit(visitor, host);
    return true;
  };

  /**
   * Sends a colleague to fetch tea from the trolley and sip it at its desk.
   * Returns false when no one can. A working assistant stays at its writing
   * desk: only an idle one fetches tea.
   */
  const fetchTea = (): boolean => {
    const tea = spots.tea;
    if (tea === null || teaTaken) return false;
    const actor = pickSettled(
      (candidate) =>
        candidate.place === "home" &&
        candidate.home.kind === "desk" &&
        (candidate.pose === "idle" ||
          (candidate.pose === "working" && candidate.colleague.kind === "thread")),
    );
    if (actor === undefined) return false;
    teaTaken = true;
    run(actor, "tea", function* () {
      try {
        yield* awaitDeparture(actor);
        setCup(actor, false);
        yield walkTo(actor, tea);
        setAction(actor, "stand");
        yield wait(actor, TEA_SECONDS);
      } finally {
        teaTaken = false;
      }
      yield* walkHome(actor, "sip");
      if (actor.pose !== "working") return;
      yield wait(actor, TEA_BREAK_SECONDS);
      setCup(actor, false);
      setAction(actor, "type");
    });
    return true;
  };

  /**
   * Has an idle assistant at its desk put down its tea and pick up the
   * newspaper, or put the newspaper down and sip its tea again. The cup on
   * the desk shows only while it sips. Returns false when no assistant sits
   * idle at its desk. A thread idle at its desk only sips: the newspaper is
   * an assistant's.
   */
  const switchTeaAndNewspaper = (): boolean => {
    const actor = pickSettled(
      (candidate) =>
        candidate.colleague.kind === "assistant" &&
        candidate.place === "home" &&
        candidate.home.kind === "desk" &&
        candidate.pose === "idle",
    );
    if (actor === undefined) return false;
    const action = actor.action === "read" ? "sip" : "read";
    setAction(actor, action);
    setCup(actor, action === "sip");
    return true;
  };

  /**
   * Returns what a colleague does in a Lounge armchair: an asleep or away
   * one dozes, and any other sits or reads, at random.
   */
  const decideLoungeAction = (actor: Actor): Action => {
    if (isAbsentPose(actor.pose)) return "doze";
    return Math.random() < 0.5 ? "sit" : "read";
  };

  /**
   * Walks a resting colleague to `seat`, a Lounge armchair, and sits it
   * down. A colleague already sitting in `seat` only changes what it does,
   * as an idle one that falls asleep there.
   */
  const walkToLounge = (actor: Actor, seat: Seat): void => {
    if (actor.place === "lounge" && actor.loungeSeat === seat && actor.errand === null) {
      setAction(actor, decideLoungeAction(actor));
      return;
    }
    run(actor, "lounge", function* () {
      takeLoungeSeat(actor, seat);
      yield* awaitDeparture(actor);
      setCup(actor, false);
      yield walkTo(actor, seat, decideLoungeAction(actor));
      actor.place = "lounge";
    });
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
      [switchTeaAndNewspaper, 2],
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

  // -- Resting places ------------------------------------------------------

  /**
   * Returns where a colleague's state puts it at rest now, among the places
   * still free: the first free place in the queue while it waits, or beside
   * its desk when the queue is full; while the world rests it in the
   * Lounge, the armchair it already sits in, or else the free one nearest
   * `near`; and its own seat otherwise, or when no armchair is free.
   */
  const decideRestingPlace = (actor: Actor, near: Vector3): RestingPlace => {
    if (actor.pose === "waiting") {
      const slot = queue.indexOf(null);
      return slot === -1 ? { kind: "desk-side" } : { kind: "queue", slot };
    }
    if (isRestingPose(actor.pose) && actor.inLounge) {
      if (actor.place === "lounge" && actor.loungeSeat !== null && actor.errand === null) {
        return { kind: "lounge", seat: actor.loungeSeat };
      }
      const seat = listFreeLoungeSeats(actor.floor, near)[0];
      if (seat !== undefined) return { kind: "lounge", seat };
    }
    return { kind: "seat" };
  };

  /** Returns the spot where a colleague stands or sits at a resting place. */
  const findRestingSpot = (actor: Actor, place: RestingPlace): Spot => {
    switch (place.kind) {
      case "seat":
        return findOwnSeat(actor);
      case "lounge":
        return place.seat;
      case "queue":
        return spots.queue[place.slot]!;
      case "desk-side": {
        const { home } = actor;
        const position = findBesideSeat(home, home.position) ?? home.position.clone();
        return { position, facing: TOWARD_USER, floor: home.floor };
      }
    }
  };

  /**
   * Puts a colleague at rest at `place` at once, with no walk, doing what it
   * does there: as the office opens, and in a new building. A colleague
   * already seated in a Lounge armchair keeps what it does, and an asleep or
   * away one dozes there.
   */
  const restAt = (actor: Actor, place: RestingPlace): void => {
    actor.onItsWay = false;
    const spot = findRestingSpot(actor, place);
    placeAt(actor, spot.position, spot.floor, spot.facing);
    switch (place.kind) {
      case "seat": {
        const seat = findOwnSeat(actor);
        actor.place = decideSeatPlace(actor, seat);
        const action = decideHomeAction(actor.pose, seat.kind);
        setAction(actor, action);
        setCup(actor, action === "sip");
        return;
      }
      case "lounge":
        takeLoungeSeat(actor, place.seat);
        actor.place = "lounge";
        setAction(actor, isAbsentPose(actor.pose) ? "doze" : keepLoungeAction(actor.action));
        return;
      case "queue":
        queue[place.slot] = actor;
        settleInQueue(actor, place.slot);
        return;
      case "desk-side":
        actor.place = "desk-side";
        setAction(actor, "raise-hand");
        return;
    }
  };

  /** Walks a colleague from wherever it is to `place`, and settles it there. */
  const walkToRest = (actor: Actor, place: RestingPlace): void => {
    switch (place.kind) {
      case "seat":
        sendHome(actor);
        return;
      case "lounge":
        walkToLounge(actor, place.seat);
        return;
      case "queue":
        queue[place.slot] = actor;
        walkToQueue(actor, place.slot, 0);
        return;
      case "desk-side":
        waitAtDesk(actor);
        return;
    }
  };

  // -- The office as it opens ----------------------------------------------

  /** Adds an actor for `colleague`, which the caller then puts somewhere. */
  const createActor = (colleague: Colleague, lounge: ReadonlySet<string>): Actor => {
    const home = office.homes.get(colleague.id)!;
    const actor: Actor = {
      colleague,
      rig: rigs.get(colleague.id)!,
      home,
      armchair: office.armchairs.get(colleague.id) ?? null,
      inLounge: lounge.has(colleague.id),
      leaving: false,
      onTurn: null,
      onItsWay: false,
      walksInBriskly: false,
      pose: colleague.pose,
      action: "stand",
      place: "elsewhere",
      floor: home.floor,
      yaw: home.facing,
      motion: null,
      errand: null,
      script: 0,
      steps: null,
      stepping: false,
      hosting: false,
      ticket: 0,
      loungeSeat: null,
      releaseDisc: null,
      timers: new Set(),
      walkCadence: -1,
    };
    actors.set(colleague.id, actor);
    return actor;
  };

  /**
   * Puts every colleague of the world at rest where its state puts it, as
   * the office opens. The waiting ones queue in the world's order: the
   * longest waiting first.
   */
  const placeEveryone = (): void => {
    const lounge = new Set(world.lounge);
    const colleagues = sortByQueue(world.colleagues, world.queue);
    for (const actor of colleagues.map((colleague) => createActor(colleague, lounge))) {
      if (actor.pose === "waiting") actor.ticket = nextTicket++;
      setPose(actor, actor.pose);
      restAt(actor, decideRestingPlace(actor, actor.home.position));
    }
  };

  placeEveryone();

  // -- Coming and going ----------------------------------------------------

  /**
   * The colleagues who walked out, with the room each walked out of, whom
   * `onDeparted` has not reported yet.
   */
  let departed: Array<{ readonly id: string; readonly roomId: string }> = [];

  /** Reports through `onDeparted` the colleagues who walked out of rooms nobody else is walking out of. */
  const reportDepartures = (): void => {
    const busy = new Set(
      [...actors.values()].filter((actor) => actor.leaving).map((actor) => actor.home.roomId),
    );
    const done = departed.filter(({ roomId }) => !busy.has(roomId));
    if (done.length === 0) return;
    departed = departed.filter(({ roomId }) => busy.has(roomId));
    onDeparted(done.map(({ id }) => id));
  };

  /**
   * Stops whatever a colleague does: its script, and the place in the queue
   * and the Lounge armchair it holds, and a visit it hosts.
   */
  const stopActor = (actor: Actor): void => {
    stopScript(actor);
    actor.releaseDisc?.();
    actor.releaseDisc = null;
    if (actor.loungeSeat !== null) loungeTaken.delete(actor.loungeSeat);
    actor.loungeSeat = null;
    actor.hosting = false;
    actor.rig.lookAt(null);
  };

  /** Removes a colleague who has left: its rig hides, the sim forgets it, and `onDeparted` reports it in time. */
  const removeActor = (actor: Actor): void => {
    const { id } = actor.colleague;
    stopActor(actor);
    actors.delete(id);
    actor.rig.object.visible = false;
    forgetState(id);
    departed.push({ id, roomId: actor.home.roomId });
    reportDepartures();
  };

  /**
   * Walks a colleague out to the front pavement, once the colleagues before
   * it have set off, and removes it there. Its desk goes dark as it leaves.
   */
  const walkOut = (actor: Actor): void => {
    actor.leaving = true;
    run(actor, "leave", function* () {
      actor.home.desk?.setLamp(false);
      actor.home.desk?.setNote(false);
      setCup(actor, false);
      yield* awaitDeparture(actor);
      yield walkTo(actor, spots.frontPavement);
      removeActor(actor);
    });
  };

  /**
   * Sends a colleague where its state puts it, from wherever it is: out to
   * the front pavement when it leaves, and to its resting place otherwise.
   */
  const sendWhereStateTakes = (actor: Actor): void => {
    if (actor.leaving) walkOut(actor);
    else walkToRest(actor, decideRestingPlace(actor, actor.rig.object.position));
  };

  /**
   * Has a colleague walk in briskly from the front pavement, where it waits
   * hidden in line until its turn.
   */
  const walkIn = (actor: Actor): void => {
    actor.walksInBriskly = true;
    const { frontPavement } = spots;
    // It comes from the street, so it faces away from it.
    placeAt(actor, frontPavement.position, frontPavement.floor, frontPavement.facing + Math.PI);
    actor.place = "elsewhere";
    run(actor, "arrive", function* () {
      yield* awaitDeparture(actor);
      sendWhereStateTakes(actor);
    });
  };

  /** Adds a colleague who joins the Office, and has it walk in. */
  const addArrival = (colleague: Colleague, lounge: ReadonlySet<string>): void => {
    // One that walked out and comes back before it was reported is no departure.
    departed = departed.filter(({ id }) => id !== colleague.id);
    const actor = createActor(colleague, lounge);
    if (actor.pose === "waiting") actor.ticket = nextTicket++;
    setPose(actor, actor.pose);
    recordState(colleague.id, buildColleagueState(colleague));
    walkIn(actor);
  };

  /** Takes a colleague out of the queue: it hops, and walks back to its desk. */
  const walkBackFromQueue = (actor: Actor): void => {
    leaveQueue(actor, QUEUE_CLOSE_SECONDS);
    run(actor, "answer", function* () {
      setAction(actor, "hop");
      yield wait(actor, HOP_AND_SETTLE_SECONDS);
      setAction(actor, "stand");
      yield* walkHome(actor);
    });
  };

  /**
   * Moves a colleague into the state `colleague` holds, as `Sim.setWorld`
   * describes, and returns true when anything the Office shows changed. A
   * colleague walking out that the world holds again turns back. One still
   * waiting its turn to walk in only takes the new state: it walks in to
   * wherever that state puts it.
   */
  const changeState = (actor: Actor, colleague: Colleague, inLounge: boolean): boolean => {
    const from = actor.pose;
    const returning = actor.leaving;
    const loungeChanged = inLounge !== actor.inLounge && isRestingPose(colleague.pose);
    const previous = actor.colleague;
    actor.colleague = colleague;
    actor.inLounge = inLounge;
    if (!returning && !loungeChanged && isSameColleagueState(previous, colleague)) return false;
    recordState(colleague.id, buildColleagueState(colleague));
    if (colleague.pose === from && !loungeChanged && !returning) return true;
    actor.leaving = false;
    setPose(actor, colleague.pose);
    if (colleague.pose === "waiting" && from !== "waiting") {
      actor.ticket = nextTicket++;
      setCup(actor, false);
    }
    if (actor.errand === "arrive") return true;
    if (from === "waiting" && colleague.pose === "working" && !returning) walkBackFromQueue(actor);
    else sendWhereStateTakes(actor);
    return true;
  };

  /**
   * Moves everyone into `next`, a new building, so that nobody jumps:
   *
   * - A colleague at rest moves with its furniture: it is put at once on the
   *   same kind of resting place in the new building, as the building itself
   *   is redrawn at once. A Lounge sitter keeps its armchair, claimed before
   *   anyone else chooses one.
   * - A colleague on its way carries on from the same spot in its room, to
   *   where its state puts it, and so does one at rest whose state now puts
   *   it elsewhere. One still waiting its turn to walk in waits on, with its
   *   turn kept.
   * - Every script stops, so a visit or a cup of tea ends early, and a
   *   colleague at rest that was walking out sets off again.
   */
  const moveIntoBuilding = (next: BuiltOffice): void => {
    const previous = office;
    // In the order they queue, so the queue fills again in that order.
    const everyone = [...actors.values()].sort((a, b) => a.ticket - b.ticket);
    const atRest = new Set(
      everyone.filter((actor) => actor.motion === null && actor.place !== "elsewhere"),
    );
    const arriving = new Set(everyone.filter((actor) => actor.errand === "arrive"));
    // Stopping the scripts empties the line; it fills again in this order.
    const order = [...line];
    const armchairs = new Map(
      everyone.map((actor) => [
        actor,
        actor.loungeSeat === null ? -1 : previous.spots.lounge.indexOf(actor.loungeSeat),
      ]),
    );
    for (const actor of everyone) stopActor(actor);
    office = next;
    spots = next.spots;
    nav = next.nav;
    officeNav = isOfficeNavGraph(nav) ? nav : null;
    queue = spots.queue.map(() => null);
    loungeTaken.clear();
    teaTaken = false;
    const kept = new Map<Actor, RestingPlace>();
    for (const actor of everyone) {
      actor.home = next.homes.get(actor.colleague.id)!;
      actor.armchair = next.armchairs.get(actor.colleague.id) ?? null;
      // The new building's desks start dark, with nothing on them.
      setPose(actor, actor.pose);
      const seat = spots.lounge[armchairs.get(actor)!];
      if (atRest.has(actor) && actor.place === "lounge" && seat !== undefined && !actor.leaving) {
        takeLoungeSeat(actor, seat);
        kept.set(actor, { kind: "lounge", seat });
      }
    }
    // The door stays shut while the line fills again, so it keeps its order.
    const doorWasBusy = doorBusy;
    doorBusy = true;
    for (const actor of everyone) {
      if (arriving.has(actor)) {
        walkIn(actor);
        continue;
      }
      if (atRest.has(actor)) {
        // A colleague walking out stands up from its own seat.
        const place: RestingPlace =
          kept.get(actor) ??
          (actor.leaving
            ? { kind: "seat" }
            : decideRestingPlace(actor, findOwnSeat(actor).position));
        if (isPlaceOfKind(actor.place, place.kind)) {
          restAt(actor, place);
          if (actor.leaving) walkOut(actor);
          continue;
        }
      }
      const here = findSameSpotInRoom(actor.rig.object.position, previous.rooms, next.rooms);
      placeAt(actor, here, actor.floor, actor.yaw);
      actor.place = "elsewhere";
      sendWhereStateTakes(actor);
    }
    const findRank = (actor: Actor): number => {
      const rank = order.indexOf(actor);
      return rank === -1 ? order.length : rank;
    };
    line.sort((a, b) => findRank(a) - findRank(b));
    doorBusy = doorWasBusy;
    openDoor();
  };

  // -- The contract ----------------------------------------------------------

  return {
    update(frame: Frame) {
      let moving = false;
      for (const actor of actors.values()) {
        moving = advanceMotion(actor, frame.dt) || moving;
        // A colleague waiting hidden for its turn to walk in needs no animation.
        if (actor.rig.object.visible) moving = actor.rig.update(frame) || moving;
      }
      return moving;
    },

    setWorld(next, nextOffice) {
      let changed = nextOffice !== office;
      if (changed) moveIntoBuilding(nextOffice);
      const lounge = new Set(next.lounge);
      const present = new Set<string>();
      const arrivals: Colleague[] = [];
      for (const colleague of next.colleagues) {
        present.add(colleague.id);
        const actor = actors.get(colleague.id);
        if (actor === undefined) {
          arrivals.push(colleague);
          continue;
        }
        changed = changeState(actor, colleague, lounge.has(colleague.id)) || changed;
      }
      // Colleagues who arrive together set off in the order they queue.
      for (const colleague of sortByQueue(arrivals, next.queue)) addArrival(colleague, lounge);
      for (const actor of [...actors.values()]) {
        if (present.has(actor.colleague.id) || actor.leaving) continue;
        // One that has not set off yet was never seen, so it goes at once.
        if (actor.errand === "arrive") removeActor(actor);
        else walkOut(actor);
        changed = true;
      }
      // A colleague who turned back may leave a room nobody walks out of any more.
      reportDepartures();
      changed ||= arrivals.length > 0;
      if (changed) stage.requestRender();
      return changed;
    },

    setLiveliness(level) {
      liveliness = level;
      stopTimer(happeningTimer);
      stopTimer(glanceTimer);
      scheduleHappening();
      scheduleGlance();
    },

    readStates() {
      return states;
    },

    subscribeStates(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },

    dispose() {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      for (const timer of timers.values()) window.clearTimeout(timer.handle);
      timers.clear();
      for (const actor of actors.values()) stopActor(actor);
      stateListeners.clear();
    },
  };
};
