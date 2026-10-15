/**
 * Tests for the sim, run on the real Bureau map: the office is built as the
 * Office screen builds it, with stand-in rigs that record each colleague's
 * action, and a stage that only counts as one. Time moves with fake timers
 * and synthetic frames, and `Math.random` is seeded, so every run walks the
 * same way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Object3D, Vector3 } from "three";
import type { OpenRequest, Session } from "@hercule/contract";
import type { AssistantRow, OfficePose, SessionPose } from "@hercule/client-core";
import {
  MOSS,
  WEBSHOP_PROJECT,
  buildProject,
  buildSession,
} from "@hercule/client-core/threads/testing";
import { buildBureau } from "../maps/bureau";
import { buildWorld, computeDeskKey, keepColleagues } from "../world/build-world";
import type { World } from "../world/types";
import {
  ARRIVAL_WALK_SPEED,
  WALK_SPEED,
  type Action,
  type BuiltOffice,
  type ColleagueRig,
  type Sim,
  type Spot,
} from "./contracts";
import { createNavBuilder } from "./nav";
import { buildSim } from "./sim";
import type { Stage } from "./stage";

/** A rig that draws nothing and records the actions and faces the sim gave it. */
interface RecordingRig extends ColleagueRig {
  readonly actions: Action[];
  readonly faces: OfficePose[];
  /** Every cadence the sim set, in m/s. */
  readonly walkSpeeds: number[];
}

/** Returns a rig that records its actions, faces and walking speeds. */
const buildRecordingRig = (): RecordingRig => {
  const actions: Action[] = [];
  const faces: OfficePose[] = [];
  const walkSpeeds: number[] = [];
  return {
    object: new Object3D(),
    headHeight: 1.6,
    actions,
    faces,
    walkSpeeds,
    setAction: (action) => void actions.push(action),
    setFace: (pose) => void faces.push(pose),
    setWalkSpeed: (speed) => void walkSpeeds.push(speed),
    lookAt: () => {},
    setHovered: () => {},
    setSelected: () => {},
    update: () => false,
    dispose: () => {},
  };
};

/** Returns the last action the sim gave `rig`. */
const readAction = (rig: RecordingRig): Action | undefined => rig.actions[rig.actions.length - 1];

/**
 * Returns a canvas 2D context that draws nothing and reads every pixel as
 * mid grey. jsdom has no 2D canvas, and the map draws its signs on one and
 * reads the theme's colours through one.
 */
const createBlankContext = (): CanvasRenderingContext2D =>
  new Proxy<Record<string | symbol, unknown>>(
    {},
    {
      get(target, key) {
        if (key in target) return target[key];
        if (key === "getImageData")
          return () => ({ data: new Uint8ClampedArray([128, 128, 128, 255]) });
        if (key === "measureText")
          return () => ({ width: 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
        if (key === "createLinearGradient" || key === "createRadialGradient")
          return () => ({ addColorStop: () => {} });
        return () => {};
      },
      set(target, key, value) {
        target[key] = value;
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;

/** Returns a `Math.random` stand-in that gives the same numbers on every run (mulberry32). */
const seedRandom = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

interface OpenOffice {
  /** The building standing now: it changes when `play` rebuilds it. */
  readonly office: BuiltOffice;
  readonly sim: Sim;
  /** The rigs of the colleagues in the scene: `play` adds one per arrival, and a departure removes its. */
  readonly rigs: ReadonlyMap<string, RecordingRig>;
  /** The ids `onDeparted` reported, in order. */
  readonly departed: readonly string[];
  /**
   * Moves time on by `seconds`, in frames of 50 ms. Each frame also runs the
   * promise callbacks due, as a real frame would: the colleagues' scripts
   * wait on promises. `onFrame` is called after each frame with the seconds
   * passed since the office opened.
   */
  readonly advance: (seconds: number, onFrame?: (time: number) => void) => Promise<void>;
  /**
   * Plays the world of `sessions` and `assistants` as the Office's director
   * does: colleagues who left keep their desks while they walk out, the
   * building is rebuilt only when its desks changed, and each arrival gets a
   * rig first.
   */
  readonly play: (
    sessions: ReadonlyArray<Session>,
    assistants?: ReadonlyArray<AssistantRow>,
  ) => void;
  /** Checks whether the colleague with id `id` stands or sits in the Lounge. */
  readonly isInLounge: (id: string) => boolean;
}

const opened: Sim[] = [];

/** The project the new-project tests add, apart from webshop. */
const SHOP_PROJECT = buildProject("p-bakery", "bakery");

/**
 * Builds the Bureau office for `sessions` and `assistants` on moss, and
 * starts its sim. The sessions belong to the project webshop, unless they say
 * otherwise, so they rest in the Lounge rather than in the café.
 */
const openOffice = (
  firstSessions: ReadonlyArray<Session>,
  firstAssistants: ReadonlyArray<AssistantRow> = [],
): OpenOffice => {
  const buildWorldOf = (
    sessions: ReadonlyArray<Session>,
    assistants: ReadonlyArray<AssistantRow>,
  ): World =>
    buildWorld({
      liveRuns: [],
      resources: [],
      sessions,
      projects: [WEBSHOP_PROJECT, SHOP_PROJECT],
      workspaces: [],
      runners: [MOSS],
      assistants,
      localRunnerId: MOSS.id,
    });
  const world = buildWorldOf(firstSessions, firstAssistants);
  let drawn = world;
  let deskKey = computeDeskKey(world);
  let office = buildBureau({ world, nav: createNavBuilder() });
  const rigs = new Map(world.colleagues.map((colleague) => [colleague.id, buildRecordingRig()]));
  const departed: string[] = [];
  const stage = { requestRender: () => {} } as unknown as Stage;
  const sim = buildSim({
    world,
    office,
    rigs,
    stage,
    onDeparted: (id) => {
      departed.push(id);
      rigs.delete(id);
    },
  });
  opened.push(sim);
  let time = 0;
  return {
    get office() {
      return office;
    },
    sim,
    rigs,
    departed,
    async advance(seconds, onFrame) {
      for (let step = 0; step < seconds * 20; step++) {
        await vi.advanceTimersByTimeAsync(50);
        time += 0.05;
        sim.update({ dt: 0.05, time });
        onFrame?.(time);
      }
    },
    play(sessions, assistants = []) {
      const latest = buildWorldOf(sessions, assistants);
      const next = keepColleagues(latest, drawn, new Set(rigs.keys()));
      for (const colleague of latest.colleagues) {
        if (!rigs.has(colleague.id)) rigs.set(colleague.id, buildRecordingRig());
      }
      const nextKey = computeDeskKey(next);
      if (nextKey !== deskKey) {
        office = buildBureau({ world: next, nav: createNavBuilder() });
        deskKey = nextKey;
      }
      drawn = next;
      sim.setWorld(latest, office);
    },
    isInLounge: (id) =>
      office.rooms
        .find((room) => room.kind === "lounge")!
        .bounds.containsPoint(rigs.get(id)!.object.position),
  };
};

/** The ways the tests put a thread: at its desk, waiting on the user, and idle. */
type ThreadState = "working" | "waiting" | "idle";

/** Returns a thread on moss with id and title `id` in `state`, in webshop, or in no project. */
const buildThread = (
  id: string,
  state: ThreadState,
  projectId: string | null = WEBSHOP_PROJECT.id,
): Session =>
  buildSession({
    id,
    title: id,
    runnerId: MOSS.id,
    projectId,
    status: state === "idle" ? "idle" : "busy",
    openRequests: state === "waiting" ? [REQUEST] : [],
  });

/** Returns `count` threads on moss in `status`, with ids `t0`, `t1`, and so on. */
const buildThreads = (
  count: number,
  status: Session["status"],
  projectId: string | null = WEBSHOP_PROJECT.id,
): Session[] =>
  Array.from({ length: count }, (_, index) =>
    buildSession({
      id: `t${index}`,
      title: `t${index}`,
      runnerId: MOSS.id,
      projectId,
      status,
    }),
  );

const REQUEST: OpenRequest = {
  requestId: "req-1",
  itemId: "tool-1",
  kind: "command_approval",
  decisions: ["allow", "deny"],
  detail: { command: "git push" },
};

/**
 * Returns the sidebar row of an assistant with id `id` in `pose`. A waiting
 * assistant has a current session with an open Request, which is what queues
 * it; the others need none for the sim.
 */
const buildAssistant = (id: string, pose: SessionPose): AssistantRow => ({
  id,
  name: id,
  pose,
  session:
    pose === "waiting"
      ? buildSession({
          id: `s-${id}`,
          agentId: id,
          conversationId: `c-${id}`,
          status: "busy",
          runnerId: MOSS.id,
          openRequests: [REQUEST],
        })
      : null,
});

/** Checks whether the colleague with rig `rig` stands or sits on `spot`. */
const isOn = (rig: RecordingRig, spot: Spot): boolean =>
  rig.object.position.distanceTo(spot.position) < 1e-3;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockImplementation(seedRandom(332));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(createBlankContext);
  vi.spyOn(document, "fonts", "get").mockReturnValue({
    ready: Promise.resolve(),
    check: () => true,
    load: () => Promise.resolve([]),
  } as unknown as FontFaceSet);
});

afterEach(() => {
  for (const sim of opened.splice(0)) sim.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the Lounge", () => {
  it.each([1, 8, 9, 16, 25, 60])("has an armchair for each of %i colleagues", (count) => {
    const { office } = openOffice(buildThreads(count, "idle"));

    expect(office.spots.lounge.length).toBeGreaterThanOrEqual(count);
  });

  it("seats every idle colleague when the office opens", () => {
    const { rigs, isInLounge } = openOffice(buildThreads(16, "idle"));

    expect([...rigs.keys()].filter(isInLounge)).toHaveLength(16);
  });

  it("seats a colleague who goes idle while every other colleague sits there", async () => {
    const threads = buildThreads(16, "idle");
    threads[0] = buildSession({
      id: "t0",
      title: "t0",
      runnerId: MOSS.id,
      projectId: WEBSHOP_PROJECT.id,
      status: "busy",
    });
    const { play, advance, isInLounge } = openOffice(threads);
    expect(isInLounge("t0")).toBe(false);

    play(buildThreads(16, "idle"));
    await advance(60);

    expect(isInLounge("t0")).toBe(true);
  });
});

describe("a visit", () => {
  it("leaves the host doing what its pose does now, after its pose changed during the visit", async () => {
    // Four colleagues share the room, so most of the time one is free to
    // visit another while a third fetches tea. They sit in the café: an idle
    // thread of a project would walk to the Lounge, and this checks what a
    // host does back at its own desk.
    const { sim, rigs, play, advance } = openOffice(buildThreads(4, "busy", null));
    sim.setLiveliness(2);
    // Only a host sits back from its keyboard: every colleague here works.
    const findHost = () => [...rigs.values()].find((rig) => readAction(rig) === "sit");
    let host: RecordingRig | undefined;
    for (let second = 0; second < 600 && host === undefined; second++) {
      await advance(1);
      host = findHost();
    }
    if (host === undefined)
      throw new Error("No colleague visited another at its desk in ten minutes.");
    // Nothing new starts, so the host's action after the visit is the visit's doing.
    sim.setLiveliness(0);

    const hostId = [...rigs].find(([, rig]) => rig === host)![0];
    play(
      buildThreads(4, "busy", null).map((thread) =>
        thread.id === hostId ? { ...thread, status: "idle" } : thread,
      ),
    );
    await advance(30);

    expect(readAction(host)).toBe("sip");
  });
});

describe("an assistant", () => {
  it("is where its pose puts it when the office opens, doing what its pose does", () => {
    const { office, rigs } = openOffice(
      [],
      [
        buildAssistant("a-working", "working"),
        buildAssistant("a-idle", "idle"),
        buildAssistant("a-asleep", "asleep"),
        buildAssistant("a-away", "away"),
        buildAssistant("a-waiting", "waiting"),
      ],
    );
    const at = (id: string) => {
      const rig = rigs.get(id)!;
      return {
        action: readAction(rig),
        atDesk: isOn(rig, office.homes.get(id)!),
        inArmchair: isOn(rig, office.armchairs.get(id)!),
      };
    };

    expect(at("a-working")).toEqual({ action: "type", atDesk: true, inArmchair: false });
    expect(at("a-idle")).toEqual({ action: "sip", atDesk: true, inArmchair: false });
    expect(at("a-asleep")).toEqual({ action: "doze", atDesk: false, inArmchair: true });
    expect(at("a-away")).toEqual({ action: "doze", atDesk: false, inArmchair: true });
    expect(isOn(rigs.get("a-waiting")!, office.spots.queue[0]!)).toBe(true);
    expect(readAction(rigs.get("a-waiting")!)).toBe("raise-hand");
  });

  it("wakes by standing up and stretching, then walks to its desk and writes", async () => {
    const { office, play, rigs, advance } = openOffice([], [buildAssistant("a", "asleep")]);
    const rig = rigs.get("a")!;
    const before = rig.actions.length;

    play([], [buildAssistant("a", "working")]);
    await advance(30);

    const actions = rig.actions.slice(before);
    const stretch = actions.indexOf("stretch");
    expect(actions.indexOf("stand")).toBeGreaterThanOrEqual(0);
    expect(actions.indexOf("stand")).toBeLessThan(stretch);
    expect(actions.indexOf("walk", stretch)).toBeGreaterThan(stretch);
    expect(isOn(rig, office.homes.get("a")!)).toBe(true);
    expect(readAction(rig)).toBe("type");
  });

  it("falls asleep by walking to its armchair and dozing there", async () => {
    const { office, play, rigs, advance } = openOffice([], [buildAssistant("a", "working")]);
    const rig = rigs.get("a")!;

    play([], [buildAssistant("a", "asleep")]);
    await advance(30);

    expect(rig.actions).not.toContain("stretch");
    expect(isOn(rig, office.armchairs.get("a")!)).toBe(true);
    expect(readAction(rig)).toBe("doze");
  });

  it("stays dozing in its armchair as it goes from asleep to away, with the away face", async () => {
    const { office, play, rigs, advance } = openOffice([], [buildAssistant("a", "asleep")]);
    const rig = rigs.get("a")!;
    const before = rig.actions.length;

    play([], [buildAssistant("a", "away")]);
    await advance(10);

    expect(rig.actions.length).toBe(before);
    expect(isOn(rig, office.armchairs.get("a")!)).toBe(true);
    expect(rig.faces.at(-1)).toBe("away");
  });

  it("queues while it waits, and walks back to its desk once answered", async () => {
    const { office, play, rigs, advance } = openOffice([], [buildAssistant("a", "working")]);
    const rig = rigs.get("a")!;

    play([], [buildAssistant("a", "waiting")]);
    await advance(60);
    expect(isOn(rig, office.spots.queue[0]!)).toBe(true);
    expect(readAction(rig)).toBe("raise-hand");

    play([], [buildAssistant("a", "working")]);
    await advance(60);
    expect(isOn(rig, office.homes.get("a")!)).toBe(true);
    expect(readAction(rig)).toBe("type");
  });
});

describe("an idle colleague at its desk", () => {
  it("shows the cup only while an assistant sips, and leaves the newspaper to assistants", async () => {
    // The thread sits in the café, where an idle thread stays at its desk.
    const { office, sim, rigs, play, advance } = openOffice(buildThreads(1, "busy", null), [
      buildAssistant("a", "idle"),
    ]);
    play(buildThreads(1, "idle", null), [buildAssistant("a", "idle")]);
    await advance(30);
    const assistant = rigs.get("a")!;
    const home = office.homes.get("a")!;
    // An idle assistant opens the office sipping, with its cup on the desk.
    let cupShown = true;
    vi.spyOn(home.desk!, "setCup").mockImplementation((on) => void (cupShown = on));
    const thread = rigs.get("t0")!;
    const threadActionsBefore = thread.actions.length;
    sim.setLiveliness(2);

    const assistantActions = new Set<Action>();
    let settledAs: Action | null = null;
    for (let second = 0; second < 600; second++) {
      await advance(1);
      const action = readAction(assistant)!;
      assistantActions.add(action);
      // The check waits until the assistant has sat at its desk doing the
      // same thing for a whole second: it sits down to sip with the fetched
      // tea in hand, and the cup goes on the desk once it has sat down.
      const seated = isOn(assistant, home) && (action === "read" || action === "sip");
      if (seated && settledAs === action) expect(cupShown).toBe(action === "sip");
      settledAs = seated ? action : null;
    }

    expect(assistantActions).toContain("read");
    expect(assistantActions).toContain("sip");
    expect(thread.actions.slice(threadActionsBefore)).not.toContain("read");
  });
});

describe("a still office", () => {
  it("starts no happening, doze or stretch, and keeps no timer", async () => {
    const { sim, rigs, advance } = openOffice(buildThreads(4, "busy"), [
      buildAssistant("a-working", "working"),
      buildAssistant("a-idle", "idle"),
      buildAssistant("a-asleep", "asleep"),
    ]);
    sim.setLiveliness(0);
    const counts = new Map([...rigs].map(([id, rig]) => [id, rig.actions.length]));

    await advance(600);

    expect(new Map([...rigs].map(([id, rig]) => [id, rig.actions.length]))).toEqual(counts);
    expect(vi.getTimerCount()).toBe(0);
  });
});

/** The seconds a thread needs to walk in from the street, or out to it, with time to spare. */
const WALK_LIMIT = 90;

/** Returns the first room of `kind` in `office`. */
const findRoom = (office: BuiltOffice, kind: string) =>
  office.rooms.find((room) => room.kind === kind)!;

describe("a thread that joins while the office is open", () => {
  it.each<{ state: ThreadState; check: (open: OpenOffice, id: string) => void }>([
    {
      state: "working",
      check: ({ office, rigs }, id) => {
        expect(isOn(rigs.get(id)!, office.homes.get(id)!)).toBe(true);
        expect(readAction(rigs.get(id)!)).toBe("type");
      },
    },
    {
      state: "waiting",
      check: ({ office, rigs }, id) => {
        expect(isOn(rigs.get(id)!, office.spots.queue[0]!)).toBe(true);
        expect(readAction(rigs.get(id)!)).toBe("raise-hand");
      },
    },
    {
      state: "idle",
      check: (open, id) => {
        expect(open.isInLounge(id)).toBe(true);
        expect(open.office.spots.lounge.some((seat) => isOn(open.rigs.get(id)!, seat))).toBe(true);
      },
    },
  ])("comes in from the street and ends $state", async ({ state, check }) => {
    const open = openOffice([buildThread("t0", "working")]);

    open.play([buildThread("t0", "working"), buildThread("t1", state)]);
    const rig = open.rigs.get("t1")!;
    // It is on the pavement, out of sight until its turn to set off.
    expect(isOn(rig, open.office.spots.street)).toBe(true);
    expect(rig.object.visible).toBe(false);
    await open.advance(0.1);
    expect(rig.object.visible).toBe(true);
    await open.advance(WALK_LIMIT);

    check(open, "t1");
  });

  it("walks in briskly, and walks at the ordinary pace afterwards", async () => {
    const open = openOffice([buildThread("t0", "working")]);
    open.play([buildThread("t0", "working"), buildThread("t1", "working")]);
    const rig = open.rigs.get("t1")!;

    await open.advance(WALK_LIMIT);

    expect(Math.max(...rig.walkSpeeds)).toBeGreaterThan(WALK_SPEED);
    expect(Math.max(...rig.walkSpeeds)).toBeLessThanOrEqual(ARRIVAL_WALK_SPEED);

    const speedsBefore = rig.walkSpeeds.length;
    open.play([buildThread("t0", "working"), buildThread("t1", "waiting")]);
    await open.advance(WALK_LIMIT);

    expect(isOn(rig, open.office.spots.queue[0]!)).toBe(true);
    expect(rig.walkSpeeds.length).toBeGreaterThan(speedsBefore);
    expect(Math.max(...rig.walkSpeeds.slice(speedsBefore))).toBeLessThanOrEqual(WALK_SPEED);
  });

  it("sets off after the colleagues who joined with it, one at a time, hidden until its turn", async () => {
    const open = openOffice([buildThread("t0", "working")]);
    const joiners = ["t1", "t2", "t3"];
    open.play([buildThread("t0", "working"), ...joiners.map((id) => buildThread(id, "working"))]);
    const setOff = new Map<string, number>();
    const atStreet = (id: string) => isOn(open.rigs.get(id)!, open.office.spots.street);
    expect(joiners.filter((id) => open.rigs.get(id)!.object.visible)).toEqual([]);

    await open.advance(10, (time) => {
      // Two joiners standing visible on the pavement at once would be one on top of the other.
      expect(
        joiners.filter((id) => open.rigs.get(id)!.object.visible && atStreet(id)).length,
      ).toBeLessThanOrEqual(1);
      for (const id of joiners) if (!atStreet(id) && !setOff.has(id)) setOff.set(id, time);
    });

    const times = [...setOff.values()].sort((a, b) => a - b);
    expect(times).toHaveLength(3);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(0.6);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(0.6);
  });
});

describe("a thread that leaves", () => {
  it("stands up and walks to the street, where it is reported departed and removed", async () => {
    const open = openOffice(buildThreads(2, "busy"));
    const rig = open.rigs.get("t1")!;
    const before = rig.actions.length;

    open.play(buildThreads(1, "busy"));

    // Its desk stays while it walks out.
    expect(open.office.homes.has("t1")).toBe(true);
    expect(open.sim.readStates().has("t1")).toBe(true);
    expect(open.departed).toEqual([]);
    for (let second = 0; second < WALK_LIMIT && open.departed.length === 0; second++) {
      await open.advance(1);
    }

    expect(open.departed).toEqual(["t1"]);
    const actions = rig.actions.slice(before);
    expect(actions.indexOf("stand")).toBeGreaterThanOrEqual(0);
    expect(actions.indexOf("walk")).toBeGreaterThan(actions.indexOf("stand"));
    expect(rig.object.position.distanceTo(open.office.spots.street.position)).toBeLessThan(0.05);
    expect(rig.object.visible).toBe(false);
    expect([...open.sim.readStates().keys()]).toEqual(["t0"]);
    await open.advance(5);
    expect(open.departed).toEqual(["t1"]);
  });

  it("turns back to its seat when it comes back before it reaches the street", async () => {
    const open = openOffice(buildThreads(2, "busy"));
    const rig = open.rigs.get("t1")!;
    open.play(buildThreads(1, "busy"));
    await open.advance(1.5);
    expect(isOn(rig, open.office.homes.get("t1")!)).toBe(false);

    open.play(buildThreads(2, "busy"));
    await open.advance(WALK_LIMIT);

    expect(open.departed).toEqual([]);
    expect(open.sim.readStates().has("t1")).toBe(true);
    expect(rig.object.visible).toBe(true);
    expect(isOn(rig, open.office.homes.get("t1")!)).toBe(true);
    expect(readAction(rig)).toBe("type");
  });
});

describe("a thread of the café that joins", () => {
  it("walks along the pavement and over the crossing, never through the Lobby, and sits in the café", async () => {
    const open = openOffice([buildThread("t0", "working")]);
    open.play([buildThread("t0", "working"), buildThread("c1", "working", null)]);
    const { office } = open;
    const lobby = findRoom(office, "lobby").bounds;
    const cafe = findRoom(office, "cafe").bounds;
    const rig = open.rigs.get("c1")!;
    const street = office.spots.street.position;
    const samples: Vector3[] = [];

    await open.advance(WALK_LIMIT, () => samples.push(rig.object.position.clone()));

    // The street spot is the middle of the pavement, so the pavement's far edge
    // is as far beyond it as the building's front is before it.
    const pavementFar = 2 * street.z - lobby.max.z;
    const crossing = samples.filter(({ x }) => x > lobby.max.x && x < cafe.min.x);
    expect(crossing.length).toBeGreaterThan(0);
    for (const { z } of crossing) {
      expect(z).toBeGreaterThanOrEqual(lobby.max.z);
      expect(z).toBeLessThanOrEqual(pavementFar);
    }
    expect(samples.filter((point) => lobby.containsPoint(point))).toEqual([]);
    expect(cafe.containsPoint(rig.object.position)).toBe(true);
    expect(isOn(rig, office.homes.get("c1")!)).toBe(true);
    expect(readAction(rig)).toBe("type");
  });
});

describe("a rebuild of the building", () => {
  /** Opens webshop with two working threads, one waiting and one idle, all at rest. */
  const openAtRest = () => {
    const sessions = [
      buildThread("t0", "working"),
      buildThread("t1", "working"),
      buildThread("t2", "waiting"),
      buildThread("t3", "idle"),
    ];
    return { open: openOffice(sessions), sessions };
  };
  /** Returns a working thread of the project bakery, which adds a room to the building. */
  const buildNewcomer = () => buildThread("n0", "working", SHOP_PROJECT.id);

  it("puts every colleague at rest straight on its seat in the new building, with no walk", async () => {
    const { open, sessions } = openAtRest();
    const before = open.office;
    const homeBefore = before.homes.get("t0")!.position.clone();
    const actionCounts = new Map([...open.rigs].map(([id, rig]) => [id, rig.actions.length]));

    open.play([...sessions, buildNewcomer()]);

    const { office, rigs } = open;
    expect(office).not.toBe(before);
    // The building moved other rooms, so staying put would leave a colleague at a stale spot.
    expect(office.homes.get("t0")!.position.distanceTo(homeBefore)).toBeGreaterThan(0.5);
    expect(isOn(rigs.get("t0")!, office.homes.get("t0")!)).toBe(true);
    expect(isOn(rigs.get("t1")!, office.homes.get("t1")!)).toBe(true);
    expect(isOn(rigs.get("t2")!, office.spots.queue[0]!)).toBe(true);
    expect(open.isInLounge("t3")).toBe(true);
    expect(office.spots.lounge.some((seat) => isOn(rigs.get("t3")!, seat))).toBe(true);

    await open.advance(30);

    for (const id of ["t0", "t1", "t2", "t3"]) {
      expect(rigs.get(id)!.actions.slice(actionCounts.get(id))).not.toContain("walk");
    }
  });

  it("keeps a colleague on its way walking from the same spot in its room, on to the queue", async () => {
    const { open, sessions } = openAtRest();
    const sessionsNow = sessions.map((thread) =>
      thread.id === "t1" ? buildThread("t1", "waiting") : thread,
    );
    open.play(sessionsNow);
    await open.advance(2);
    const rig = open.rigs.get("t1")!;
    expect(readAction(rig)).toBe("walk");
    const spot = rig.object.position.clone();
    const roomBefore = open.office.rooms.find((room) => room.bounds.containsPoint(spot))!;
    const centreBefore = roomBefore.bounds.getCenter(new Vector3());

    open.play([...sessionsNow, buildNewcomer()]);

    // The room moved with the new building, and the colleague moved with it.
    const centreNow = open.office.rooms
      .find((room) => room.id === roomBefore.id)!
      .bounds.getCenter(new Vector3());
    const shift = centreNow.clone().sub(centreBefore);
    expect(shift.length()).toBeGreaterThan(0.5);
    expect(rig.object.position.distanceTo(spot.clone().add(shift))).toBeLessThan(0.01);

    await open.advance(WALK_LIMIT);

    // The colleague at rest in the first place keeps it, so the walker takes the second.
    expect(isOn(rig, open.office.spots.queue[1]!)).toBe(true);
    expect(readAction(rig)).toBe("stand");
  });
});

describe("many joins and leaves", () => {
  it("leave the sim with the colleagues of the last world and no timers", async () => {
    const base = buildThread("base", "working");
    const open = openOffice([base]);
    const ids: string[] = [];

    for (let index = 0; index < 50; index++) {
      const id = `visitor-${index}`;
      ids.push(id);
      open.play([base, buildThread(id, "working", index % 2 === 0 ? WEBSHOP_PROJECT.id : null)]);
      await open.advance(index % 4);
      open.play([base]);
      for (let second = 0; second < WALK_LIMIT && !open.departed.includes(id); second++) {
        await open.advance(1);
      }
    }
    await open.advance(60);

    expect([...open.sim.readStates().keys()]).toEqual(["base"]);
    expect(open.departed).toEqual(ids);
    expect([...open.rigs.keys()]).toEqual(["base"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
