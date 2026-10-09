/**
 * Tests for the sim, run on the real Bureau map: the office is built as the
 * Office screen builds it, with stand-in rigs that record each colleague's
 * action, and a stage that only counts as one. Time moves with fake timers
 * and synthetic frames, and `Math.random` is seeded, so every run walks the
 * same way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Object3D } from "three";
import type { OpenRequest, Session } from "@hercule/contract";
import type { AssistantRow, SessionPose } from "@hercule/client-core";
import { MOSS, buildSession } from "@hercule/client-core/threads/testing";
import { buildBureau } from "../maps/bureau";
import { buildWorld } from "../world/build-world";
import type { Action, BuiltOffice, ColleagueRig, Sim, Spot } from "./contracts";
import { createNavBuilder } from "./nav";
import { buildSim } from "./sim";
import type { Stage } from "./stage";

/** A rig that draws nothing and records the actions and faces the sim gave it. */
interface RecordingRig extends ColleagueRig {
  readonly actions: Action[];
  readonly faces: SessionPose[];
}

/** Returns a rig for `colleague` that records its actions and faces. */
const buildRecordingRig = (colleague: ColleagueRig["colleague"]): RecordingRig => {
  const actions: Action[] = [];
  const faces: SessionPose[] = [];
  return {
    colleague,
    object: new Object3D(),
    headHeight: 1.6,
    actions,
    faces,
    setAction: (action) => void actions.push(action),
    setFace: (pose) => void faces.push(pose),
    setWalkSpeed: () => {},
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
  readonly office: BuiltOffice;
  readonly sim: Sim;
  readonly rigs: ReadonlyMap<string, RecordingRig>;
  /**
   * Moves time on by `seconds`, in frames of 50 ms. Each frame also runs the
   * promise callbacks due, as a real frame would: the colleagues' scripts
   * wait on promises.
   */
  readonly advance: (seconds: number) => Promise<void>;
  /** Checks whether the colleague with id `id` stands or sits in the Lounge. */
  readonly isInLounge: (id: string) => boolean;
}

const opened: Sim[] = [];

/** Builds the Bureau office for `sessions` and `assistants` on moss, and starts its sim. */
const openOffice = (
  sessions: ReadonlyArray<Session>,
  assistants: ReadonlyArray<AssistantRow> = [],
): OpenOffice => {
  const world = buildWorld({
    sessions,
    projects: [],
    workspaces: [],
    runners: [MOSS],
    assistants,
    localRunnerId: MOSS.id,
  });
  const office = buildBureau({ world, nav: createNavBuilder() });
  const rigs = new Map(
    world.colleagues.map((colleague) => [colleague.id, buildRecordingRig(colleague)]),
  );
  const stage = { requestRender: () => {} } as unknown as Stage;
  const sim = buildSim({ world, office, rigs, stage });
  opened.push(sim);
  const lounge = office.rooms.find((room) => room.kind === "lounge")!;
  let time = 0;
  return {
    office,
    sim,
    rigs,
    async advance(seconds) {
      for (let step = 0; step < seconds * 20; step++) {
        await vi.advanceTimersByTimeAsync(50);
        time += 0.05;
        sim.update({ dt: 0.05, time });
      }
    },
    isInLounge: (id) => lounge.bounds.containsPoint(rigs.get(id)!.object.position),
  };
};

/** Returns `count` threads on moss in `status`, with ids `t0`, `t1`, and so on. */
const buildThreads = (count: number, status: Session["status"]): Session[] =>
  Array.from({ length: count }, (_, index) =>
    buildSession({ id: `t${index}`, title: `t${index}`, runnerId: MOSS.id, status }),
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

/** Returns the state the director gives a colleague that moves to `pose`. */
const buildState = (pose: SessionPose) => ({ pose, request: null, stateLabel: pose });

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
    threads[0] = buildSession({ id: "t0", title: "t0", runnerId: MOSS.id, status: "busy" });
    const { sim, advance, isInLounge } = openOffice(threads);
    expect(isInLounge("t0")).toBe(false);

    sim.setColleagueState("t0", { pose: "idle", request: null, stateLabel: "idle" }, true);
    await advance(60);

    expect(isInLounge("t0")).toBe(true);
  });
});

describe("a visit", () => {
  it("leaves the host doing what its pose does now, after its pose changed during the visit", async () => {
    // Four colleagues share the room, so most of the time one is free to
    // visit another while a third fetches tea.
    const { sim, rigs, advance } = openOffice(buildThreads(4, "busy"));
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

    sim.setColleagueState(
      host.colleague.id,
      { pose: "idle", request: null, stateLabel: "idle" },
      false,
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
    const { office, sim, rigs, advance } = openOffice([], [buildAssistant("a", "asleep")]);
    const rig = rigs.get("a")!;
    const before = rig.actions.length;

    sim.setColleagueState("a", buildState("working"), false);
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
    const { office, sim, rigs, advance } = openOffice([], [buildAssistant("a", "working")]);
    const rig = rigs.get("a")!;

    sim.setColleagueState("a", buildState("asleep"), false);
    await advance(30);

    expect(rig.actions).not.toContain("stretch");
    expect(isOn(rig, office.armchairs.get("a")!)).toBe(true);
    expect(readAction(rig)).toBe("doze");
  });

  it("stays dozing in its armchair as it goes from asleep to away, with the away face", async () => {
    const { office, sim, rigs, advance } = openOffice([], [buildAssistant("a", "asleep")]);
    const rig = rigs.get("a")!;
    const before = rig.actions.length;

    sim.setColleagueState("a", buildState("away"), false);
    await advance(10);

    expect(rig.actions.length).toBe(before);
    expect(isOn(rig, office.armchairs.get("a")!)).toBe(true);
    expect(rig.faces.at(-1)).toBe("away");
  });

  it("queues while it waits, and walks back to its desk once answered", async () => {
    const { office, sim, rigs, advance } = openOffice([], [buildAssistant("a", "working")]);
    const rig = rigs.get("a")!;

    sim.setColleagueState("a", buildState("waiting"), false);
    await advance(60);
    expect(isOn(rig, office.spots.queue[0]!)).toBe(true);
    expect(readAction(rig)).toBe("raise-hand");

    sim.setColleagueState("a", buildState("working"), false);
    await advance(60);
    expect(isOn(rig, office.homes.get("a")!)).toBe(true);
    expect(readAction(rig)).toBe("type");
  });
});

describe("an idle colleague at its desk", () => {
  it("shows the cup only while an assistant sips, and leaves the newspaper to assistants", async () => {
    const { office, sim, rigs, advance } = openOffice(buildThreads(1, "busy"), [
      buildAssistant("a", "idle"),
    ]);
    sim.setColleagueState("t0", buildState("idle"), false);
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
    for (let second = 0; second < 600; second++) {
      await advance(1);
      const action = readAction(assistant)!;
      assistantActions.add(action);
      // The check waits until the assistant sits at its desk: it sits down
      // to sip with the fetched tea in hand, and the cup goes on the desk after.
      if (isOn(assistant, home) && (action === "read" || action === "sip"))
        expect(cupShown).toBe(action === "sip");
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
