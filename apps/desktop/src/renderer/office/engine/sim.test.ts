/**
 * Tests for the sim, run on the real Bureau map: the office is built as the
 * Office screen builds it, with stand-in rigs that record each colleague's
 * action, and a stage that only counts as one. Time moves with fake timers
 * and synthetic frames, and `Math.random` is seeded, so every run walks the
 * same way.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { Object3D, Vector3 } from "three";
import type { OpenRequest, Session } from "@hercule/contract";
import {
  listEndedWork,
  type AssistantRow,
  type OfficePose,
  type SessionPose,
} from "@hercule/client-core";
import {
  MOSS,
  WEBSHOP_PROJECT,
  buildProject,
  buildSession,
} from "@hercule/client-core/threads/testing";
import { buildBureau } from "../maps/bureau";
import {
  buildOpeningWorld,
  buildWorld,
  computeDeskKey,
  keepColleagues,
} from "../world/build-world";
import type { World } from "../world/types";
import {
  ARRIVAL_WALK_SPEED,
  WALK_CATCH_UP_SECONDS,
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
  /** The ids of each `onDeparted` call, in order. */
  readonly reports: ReadonlyArray<readonly string[]>;
  /** The spy the sim calls to ask the stage for a frame. */
  readonly requestRender: Mock<() => void>;
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
   * rig first. Returns what `Sim.setWorld` returns: whether the world changed
   * anything to draw.
   */
  readonly play: (
    sessions: ReadonlyArray<Session>,
    assistants?: ReadonlyArray<AssistantRow>,
  ) => boolean;
  /** Checks whether the colleague with id `id` stands or sits in the Lounge. */
  readonly isInLounge: (id: string) => boolean;
}

const opened: Sim[] = [];

/** The project the new-project tests add, apart from webshop. */
const SHOP_PROJECT = buildProject("p-bakery", "bakery");

/** The time the tests' office opens at, unless a test says otherwise: long after every fixture session was created. */
const OPENED_AT = Date.parse("2026-10-17T12:00:00.000Z");

/**
 * Builds the Bureau office for `sessions` and `assistants` on moss, and
 * starts its sim, as the Office's director does when it opens at
 * `openedAt`: on the opening world, which also holds the threads marked
 * Done in the last minute, and then at once on the world of now. The
 * sessions belong to the project webshop, unless they say otherwise, so they
 * rest in the Lounge rather than in the café.
 */
const openOffice = (
  firstSessions: ReadonlyArray<Session>,
  firstAssistants: ReadonlyArray<AssistantRow> = [],
  openedAt = OPENED_AT,
): OpenOffice => {
  const buildRecords = (
    sessions: ReadonlyArray<Session>,
    assistants: ReadonlyArray<AssistantRow>,
  ) => ({
    liveRuns: [],
    resources: [],
    sessions,
    projects: [WEBSHOP_PROJECT, SHOP_PROJECT],
    workspaces: [],
    runners: [MOSS],
    assistants,
    localRunnerId: MOSS.id,
  });
  const buildWorldOf = (
    sessions: ReadonlyArray<Session>,
    assistants: ReadonlyArray<AssistantRow>,
  ): World => buildWorld(buildRecords(sessions, assistants));
  const firstRecords = buildRecords(firstSessions, firstAssistants);
  const world = buildOpeningWorld(
    firstRecords,
    listEndedWork({
      ...firstRecords,
      runs: [],
      since: new Date(openedAt - WALK_CATCH_UP_SECONDS * 1000).toISOString(),
    }),
  );
  let drawn = world;
  let deskKey = computeDeskKey(world);
  let office = buildBureau({ world, nav: createNavBuilder() });
  const rigs = new Map(world.colleagues.map((colleague) => [colleague.id, buildRecordingRig()]));
  const departed: string[] = [];
  const reports: string[][] = [];
  const requestRender = vi.fn<() => void>();
  const stage = { requestRender } as unknown as Stage;
  const sim = buildSim({
    world,
    openedAt,
    office,
    rigs,
    stage,
    onDeparted: (ids) => {
      reports.push([...ids]);
      for (const id of ids) {
        departed.push(id);
        rigs.delete(id);
      }
    },
  });
  opened.push(sim);
  let time = 0;
  const open: OpenOffice = {
    get office() {
      return office;
    },
    sim,
    rigs,
    departed,
    reports,
    requestRender,
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
      const present = new Set(latest.colleagues.map(({ id }) => id));
      const leaving = new Set([...rigs.keys()].filter((id) => !present.has(id)));
      const next = keepColleagues(latest, drawn, leaving);
      for (const colleague of latest.colleagues) {
        if (!rigs.has(colleague.id)) rigs.set(colleague.id, buildRecordingRig());
      }
      const nextKey = computeDeskKey(next);
      if (nextKey !== deskKey) {
        office = buildBureau({ world: next, nav: createNavBuilder() });
        deskKey = nextKey;
      }
      drawn = next;
      return sim.setWorld(latest, office);
    },
    isInLounge: (id) =>
      office.rooms
        .find((room) => room.kind === "lounge")!
        .bounds.containsPoint(rigs.get(id)!.object.position),
  };
  open.play(firstSessions, firstAssistants);
  requestRender.mockClear();
  return open;
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

  it("seats an asleep and an away colleague of a project room there, dozing", () => {
    const { rigs, isInLounge } = openOffice([
      { ...buildThread("t0", "idle"), status: "exited", resumable: true },
      { ...buildThread("t1", "idle"), status: "exited" },
    ]);

    expect(["t0", "t1"].filter(isInLounge)).toEqual(["t0", "t1"]);
    expect(["t0", "t1"].map((id) => readAction(rigs.get(id)!))).toEqual(["doze", "doze"]);
  });

  it("keeps an idle colleague in its armchair when it falls asleep, and it dozes there", async () => {
    const { rigs, play, advance, isInLounge } = openOffice([buildThread("t0", "idle")]);
    const rig = rigs.get("t0")!;
    const before = rig.object.position.clone();

    play([{ ...buildThread("t0", "idle"), status: "exited", resumable: true }]);
    await advance(WALK_LIMIT);

    expect(isInLounge("t0")).toBe(true);
    expect(rig.object.position.distanceTo(before)).toBe(0);
    expect(readAction(rig)).toBe("doze");
  });

  it("keeps the armchair a colleague walks to in a full Lounge when it falls asleep on the way", async () => {
    // Every armchair is taken once t0 sets off, so the one it holds is the
    // only one it can have.
    const count = 8;
    const resting = buildThreads(count, "idle");
    const { office, rigs, play, advance, isInLounge } = openOffice([
      buildThread("t0", "working"),
      ...resting.slice(1),
    ]);
    expect(office.spots.lounge).toHaveLength(count);
    play(resting);
    await advance(1.5);
    expect(readAction(rigs.get("t0")!)).toBe("walk");

    play(
      resting.map((thread) =>
        thread.id === "t0" ? { ...thread, status: "exited", resumable: true } : thread,
      ),
    );
    await advance(WALK_LIMIT);

    expect(isInLounge("t0")).toBe(true);
    expect(readAction(rigs.get("t0")!)).toBe("doze");
  });

  it("moves an idle colleague to the café when its project is gone, though its pose stays the same", async () => {
    const open = openOffice([buildThread("t0", "idle")]);
    expect(open.isInLounge("t0")).toBe(true);

    open.play([buildThread("t0", "idle", null)]);
    await open.advance(WALK_LIMIT);

    const rig = open.rigs.get("t0")!;
    expect(findRoom(open.office, "cafe").bounds.containsPoint(rig.object.position)).toBe(true);
    expect(isOn(rig, open.office.homes.get("t0")!)).toBe(true);
    expect(readAction(rig)).toBe("sip");
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

  it("walks back without a word when its host falls asleep before it arrives", async () => {
    // Two working threads in the café: each can only visit the other.
    const threads = buildThreads(2, "busy", null);
    const { sim, rigs, play, advance } = openOffice(threads);
    sim.setLiveliness(2);
    let visitorId: string | undefined;
    for (let step = 0; step < 12_000 && visitorId === undefined; step++) {
      await advance(0.05);
      visitorId = [...rigs].find(([, rig]) => readAction(rig) === "walk")?.[0];
    }
    if (visitorId === undefined) throw new Error("No colleague set off in ten minutes.");
    sim.setLiveliness(0);
    const [hostId, host] = [...rigs].find(([id]) => id !== visitorId)!;
    const hostLooks = vi.fn<ColleagueRig["lookAt"]>();
    host.lookAt = (target) => hostLooks(target);

    play(
      threads.map((thread) =>
        thread.id === hostId ? { ...thread, status: "exited", resumable: true } : thread,
      ),
    );
    await advance(WALK_LIMIT);

    expect(rigs.get(visitorId)!.actions).not.toContain("talk");
    expect(hostLooks.mock.calls.filter(([target]) => target !== null)).toEqual([]);
    expect(readAction(host)).toBe("doze");
  });

  it.each(["asleep", "away"] as const)(
    "ends a visit at once when the host becomes %s during it, and both turn their heads back",
    async (pose) => {
      // Four working threads in the café, where an absent host stays at its table.
      const threads = buildThreads(4, "busy", null);
      const { sim, rigs, play, advance } = openOffice(threads);
      const looks = new Map(
        [...rigs].map(([id, rig]) => {
          const look = vi.fn<ColleagueRig["lookAt"]>();
          rig.lookAt = (target) => look(target);
          return [id, look] as const;
        }),
      );
      sim.setLiveliness(2);
      let hostId: string | undefined;
      for (let step = 0; step < 12_000 && hostId === undefined; step++) {
        await advance(0.05);
        hostId = [...rigs].find(([, rig]) => readAction(rig) === "sit")?.[0];
      }
      if (hostId === undefined) throw new Error("No colleague hosted a visit in ten minutes.");
      const [visitorId, visitor] = [...rigs].find(([, rig]) => readAction(rig) === "talk")!;
      sim.setLiveliness(0);

      play(
        threads.map((thread) =>
          thread.id === hostId
            ? { ...thread, status: "exited", resumable: pose === "asleep" }
            : thread,
        ),
      );
      await advance(0.5);

      expect(readAction(rigs.get(hostId)!)).toBe("doze");
      expect(["talk", "listen"]).not.toContain(readAction(visitor));
      expect(looks.get(hostId)!.mock.calls.at(-1)).toEqual([null]);
      expect(looks.get(visitorId)!.mock.calls.at(-1)).toEqual([null]);
    },
  );

  it("never makes an asleep or away colleague its host, so it keeps dozing", async () => {
    // Two working threads can visit; every other colleague in the café is
    // asleep or away, so a visit to one of them would wake it.
    const absent = [
      ...buildThreads(3, "exited", null).map((thread) => ({ ...thread, resumable: true })),
      ...buildThreads(3, "exited", null).map((thread, index) => ({ ...thread, id: `x${index}` })),
    ];
    const { sim, rigs, advance } = openOffice([
      ...absent,
      ...buildThreads(2, "busy", null).map((thread, index) => ({ ...thread, id: `w${index}` })),
    ]);
    const absentRigs = absent.map(({ id }) => rigs.get(id)!);
    const seen = absentRigs.map((rig) => rig.actions.length);
    sim.setLiveliness(2);

    await advance(600);

    absentRigs.forEach((rig, index) => {
      expect(readAction(rig)).toBe("doze");
      expect(rig.actions.slice(seen[index]).filter((action) => action !== "doze")).toEqual([]);
    });
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

/**
 * Watches the front pavement while the colleagues `ids` walk in. `observe` is
 * called once per frame: it records when each one first stands off the
 * pavement (set off), and the times when two stood on it in view at once.
 */
const watchDoor = (open: OpenOffice, ids: ReadonlyArray<string>) => {
  const setOff = new Map<string, number>();
  const crowdedAt: number[] = [];
  const observe = (time: number): void => {
    const onPavement = ids.filter((id) => {
      const rig = open.rigs.get(id);
      return rig !== undefined && isOn(rig, open.office.spots.frontPavement);
    });
    for (const id of ids) if (!onPavement.includes(id) && !setOff.has(id)) setOff.set(id, time);
    if (onPavement.filter((id) => open.rigs.get(id)!.object.visible).length > 1) {
      crowdedAt.push(time);
    }
  };
  return { setOff, crowdedAt, observe };
};

/** The seconds between two colleagues setting off, at the least, as the sim reserves them. */
const TURN_SECONDS = 0.7;
/** How late a colleague may set off past its turn: a frame or two, and the walk's first steps. */
const TURN_TOLERANCE_SECONDS = 0.3;

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
    // Nobody else is setting off, so it sets off from the pavement on the first frame.
    expect(isOn(rig, open.office.spots.frontPavement)).toBe(true);
    await open.advance(0.05);
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

  it.each<ThreadState>(["working", "idle"])(
    "sets off after the colleagues who joined with it, one at a time, hidden until its turn, when it ends %s",
    async (state) => {
      const open = openOffice([buildThread("t0", "working")]);
      const joiners = ["t1", "t2", "t3"];
      open.play([buildThread("t0", "working"), ...joiners.map((id) => buildThread(id, state))]);
      const { setOff, crowdedAt, observe } = watchDoor(open, joiners);
      // The first sets off on the first frame; the others wait out of sight for their turn.
      observe(0);
      await open.advance(0.05, observe);
      expect(joiners.filter((id) => open.rigs.get(id)!.object.visible)).toEqual(["t1"]);

      await open.advance(10, observe);

      // Two joiners standing visible on the pavement at once would be one on top of the other.
      expect(crowdedAt).toEqual([]);
      const times = [...setOff.values()].sort((a, b) => a - b);
      expect(times).toHaveLength(3);
      expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(0.6);
      expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(0.6);
    },
  );

  it("never shows a thread that leaves before its turn to walk in, and does not hold up the others", async () => {
    const open = openOffice([buildThread("t0", "working")]);
    const [t1, t2, t3, t4] = ["t1", "t2", "t3", "t4"].map((id) => buildThread(id, "working"));
    open.play([buildThread("t0", "working"), t1!, t2!, t3!, t4!]);
    // t2 and t4 wait out of sight for their turns.
    const unseen = [open.rigs.get("t2")!, open.rigs.get("t4")!];
    const isAnySeen = () => unseen.some((rig) => rig.object.visible);
    const { setOff, observe } = watchDoor(open, ["t3"]);

    open.play([buildThread("t0", "working"), t1!, t3!]);

    expect(isAnySeen()).toBe(false);
    expect(open.departed).toEqual(["t2", "t4"]);
    let wasSeen = false;
    await open.advance(WALK_LIMIT, (time) => {
      wasSeen ||= isAnySeen();
      observe(time);
    });

    expect(wasSeen).toBe(false);
    expect(open.departed).toEqual(["t2", "t4"]);
    // t3's turn was the third: t2's leaving frees nothing to wait for, and costs nothing.
    expect(setOff.get("t3")!).toBeLessThanOrEqual(2 * TURN_SECONDS + TURN_TOLERANCE_SECONDS);
    for (const id of ["t1", "t3"]) {
      expect(isOn(open.rigs.get(id)!, open.office.homes.get(id)!)).toBe(true);
      expect(readAction(open.rigs.get(id)!)).toBe("type");
    }
  });

  it("keeps the turns of the colleagues who wait to walk in through rebuilds of the building", async () => {
    const open = openOffice([buildThread("t0", "working")]);
    const joiners = ["t1", "t2", "t3"];
    // The title is part of what the building is made of, so each one rebuilds it.
    const buildWorldThreads = (title: string) => [
      { ...buildThread("t0", "working"), title },
      ...joiners.map((id) => buildThread(id, "working")),
    ];
    open.play(buildWorldThreads("t0"));
    const { setOff, observe } = watchDoor(open, joiners);
    observe(0);
    let waitersChecked = 0;

    for (let rebuild = 0; rebuild < 10; rebuild++) {
      await open.advance(0.1, observe);
      const before = open.office;
      open.play(buildWorldThreads(`t0 v${rebuild}`));
      expect(open.office).not.toBe(before);
      for (const id of joiners) {
        const rig = open.rigs.get(id)!;
        if (rig.object.visible) continue;
        waitersChecked++;
        expect(isOn(rig, open.office.spots.frontPavement)).toBe(true);
      }
    }
    await open.advance(5, observe);

    expect(waitersChecked).toBeGreaterThanOrEqual(10);
    joiners.forEach((id, index) => {
      expect(setOff.get(id)!).toBeLessThanOrEqual(index * TURN_SECONDS + TURN_TOLERANCE_SECONDS);
    });
  });

  it("does not release the waiting arrivals together after the window was hidden", async () => {
    const open = openOffice([buildThread("t0", "working")]);
    const joiners = ["t1", "t2", "t3"];
    const buildWorldThreads = (title: string) => [
      { ...buildThread("t0", "working"), title },
      ...joiners.map((id) => buildThread(id, "working")),
    ];
    open.play(buildWorldThreads("t0"));
    const { setOff, crowdedAt, observe } = watchDoor(open, joiners);
    observe(0);
    await open.advance(0.1, observe);

    const hiddenBefore = Object.getOwnPropertyDescriptor(document, "hidden");
    const stateBefore = Object.getOwnPropertyDescriptor(document, "visibilityState");
    const setVisible = (visible: boolean): void => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => !visible });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => (visible ? "visible" : "hidden"),
      });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    try {
      setVisible(false);
      await open.advance(60, observe);
      setVisible(true);
      // The rebuild puts every waiting colleague back in line.
      open.play(buildWorldThreads("t0 renamed"));
      await open.advance(10, observe);
    } finally {
      for (const [name, before] of [
        ["hidden", hiddenBefore],
        ["visibilityState", stateBefore],
      ] as const) {
        if (before === undefined) Reflect.deleteProperty(document, name);
        else Object.defineProperty(document, name, before);
      }
    }

    // On a clock of absolute reservations (a global next set-off time in
    // `performance.now()` seconds), the 60 hidden seconds would have used up
    // every reservation, so the waiting arrivals would all be due at the
    // moment the window is shown, and would stand on the pavement together.
    expect(crowdedAt).toEqual([]);
    const times = [...setOff.values()].sort((a, b) => a - b);
    expect(times).toHaveLength(3);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(0.6);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(0.6);
  });

  it("keeps the turn of an arrival the door already let through, when the building is rebuilt in the same tick", async () => {
    const open = openOffice([buildThread("t0", "working")]);
    const joiners = ["t1", "t2", "t3"];
    const buildWorldThreads = (title: string) => [
      { ...buildThread("t0", "working"), title },
      ...joiners.map((id) => buildThread(id, "working")),
    ];
    const { setOff, observe } = watchDoor(open, joiners);

    // The door lets t1 through at once; the rename rebuilds before t1 takes its first step.
    open.play(buildWorldThreads("t0"));
    open.play(buildWorldThreads("t0 renamed"));
    observe(0);
    await open.advance(10, observe);

    expect([...setOff].sort((a, b) => a[1] - b[1]).map(([id]) => id)).toEqual(joiners);
  });

  it.each<{ leaver: ThreadState; rebuild: boolean }>([
    { leaver: "idle", rebuild: false },
    { leaver: "waiting", rebuild: true },
  ])(
    "holds a $leaver colleague who leaves at the door while it is busy (rebuild: $rebuild)",
    async ({ leaver, rebuild }) => {
      const open = openOffice([buildThread("t0", "working"), buildThread("t1", leaver)]);
      await open.advance(1);
      const rig = open.rigs.get("t1")!;
      const restedAt = rig.object.position.clone();

      // A newcomer takes the door, so the leaver must wait a gap before it sets off.
      open.play([
        buildThread("t0", "working"),
        buildThread("t1", leaver),
        buildThread("t2", "working"),
      ]);
      open.play([buildThread("t0", "working"), buildThread("t2", "working")]);
      if (rebuild) {
        open.play([
          { ...buildThread("t0", "working"), title: "t0 renamed" },
          buildThread("t2", "working"),
        ]);
      }
      const startedAt = rig.object.position.clone();
      await open.advance(TURN_SECONDS - 0.2);

      expect(startedAt.distanceTo(restedAt)).toBeLessThan(rebuild ? Infinity : 1e-3);
      expect(rig.object.position.distanceTo(startedAt)).toBeLessThan(0.02);
    },
  );

  it("gives the places of arrivals that left before their turn back to the ones who come later", async () => {
    const open = openOffice([buildThread("t0", "working")]);
    const crowd = Array.from({ length: 20 }, (_, index) => buildThread(`c${index}`, "working"));
    open.play([buildThread("t0", "working"), ...crowd]);
    await open.advance(0.1);

    open.play([buildThread("t0", "working")]);
    await open.advance(2);
    const { setOff, observe } = watchDoor(open, ["late"]);
    open.play([buildThread("t0", "working"), buildThread("late", "working")]);
    // The frames count the seconds from when the office opened.
    const joinedAt = 2.1;
    observe(joinedAt);
    await open.advance(15, observe);

    // On a clock of absolute reservations, the twenty colleagues would have
    // reserved turns up to about fourteen seconds ahead, and a cancelled turn
    // would stay reserved, so "late" would set off after all of them.
    expect(setOff.get("late")! - joinedAt).toBeLessThan(1);
  });
});

describe("a walk under way as the office opens", () => {
  /** Returns the ISO 8601 time `seconds` before the tests' office opens; a negative number is after. */
  const buildTimeBeforeOpening = (seconds: number): string =>
    new Date(OPENED_AT - seconds * 1000).toISOString();

  /** Returns a working thread on moss in webshop with id `id`, created `seconds` before the office opens. */
  const buildThreadCreated = (id: string, seconds: number): Session => ({
    ...buildThread(id, "working"),
    createdAt: buildTimeBeforeOpening(seconds),
  });

  /** Returns an idle thread on moss in webshop with id `id`, marked Done `seconds` before the office opens. */
  const buildThreadDone = (id: string, seconds: number): Session => ({
    ...buildThread(id, "idle"),
    done: { at: buildTimeBeforeOpening(seconds), by: "user" },
  });

  it("shows a thread that came in a moment ago on its way in, as far as it has got, and seats it", async () => {
    const open = openOffice([buildThread("t0", "working"), buildThreadCreated("t1", 4)]);
    const rig = open.rigs.get("t1")!;
    const { frontPavement } = open.office.spots;

    // Four seconds at a brisk walk are metres past the door, and short of the desk.
    expect(rig.object.visible).toBe(true);
    expect(rig.object.position.distanceTo(frontPavement.position)).toBeGreaterThan(3);
    expect(isOn(rig, open.office.homes.get("t1")!)).toBe(false);
    await open.advance(WALK_LIMIT);

    expect(isOn(rig, open.office.homes.get("t1")!)).toBe(true);
    expect(readAction(rig)).toBe("type");
  });

  it("seats a thread whose walk in ended before the office opened, and never walks one that came in long ago", async () => {
    const open = openOffice([buildThreadCreated("t0", 50), buildThread("t1", "working")]);
    await open.advance(0.05);

    for (const id of ["t0", "t1"]) {
      expect(isOn(open.rigs.get(id)!, open.office.homes.get(id)!)).toBe(true);
      expect(readAction(open.rigs.get(id)!)).toBe("type");
    }
    expect(open.rigs.get("t1")!.actions).not.toContain("walk");
  });

  it("shows a thread marked Done a moment ago on its way out, and reports it departed outside", async () => {
    const open = openOffice([buildThread("t0", "working"), buildThreadDone("t1", 3)]);
    const rig = open.rigs.get("t1")!;

    expect(rig.object.visible).toBe(true);
    expect(rig.actions).toContain("walk");
    // Its desk stays while it walks out.
    expect(open.office.homes.has("t1")).toBe(true);
    expect(open.departed).toEqual([]);
    for (let second = 0; second < WALK_LIMIT && open.departed.length === 0; second++) {
      await open.advance(1);
    }

    expect(open.departed).toEqual(["t1"]);
    expect(rig.object.position.distanceTo(open.office.spots.frontPavement.position)).toBeLessThan(
      0.05,
    );
    expect(rig.object.visible).toBe(false);
  });

  it("reports a thread whose walk out ended before the office opened departed before any frame", async () => {
    const open = openOffice([buildThread("t0", "working"), buildThreadDone("t1", 55)]);
    const rig = open.rigs.get("t1")!;
    await Promise.resolve();
    await Promise.resolve();

    expect(open.departed).toEqual(["t1"]);
    expect(rig.object.visible).toBe(false);
  });

  it("leaves out a thread marked Done longer ago than any walk takes", () => {
    const open = openOffice([buildThread("t0", "working"), buildThreadDone("t1", 61)]);

    expect(open.rigs.has("t1")).toBe(false);
    expect(open.office.homes.has("t1")).toBe(false);
  });

  it("walks in from the street a thread created after the office opened, as when the controller's clock is ahead", async () => {
    const open = openOffice([buildThread("t0", "working"), buildThreadCreated("t1", -5)]);
    const rig = open.rigs.get("t1")!;

    expect(isOn(rig, open.office.spots.frontPavement)).toBe(true);
    await open.advance(WALK_LIMIT);

    expect(isOn(rig, open.office.homes.get("t1")!)).toBe(true);
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
    expect(rig.object.position.distanceTo(open.office.spots.frontPavement.position)).toBeLessThan(
      0.05,
    );
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

describe("threads that leave and come back or go together", () => {
  it("never lets a replaced walk out take another step, when the thread comes back in the same tick", async () => {
    const open = openOffice(buildThreads(3, "busy"));

    // t2 waits its turn to set off behind t1, then the world holds both again.
    open.play(buildThreads(1, "busy"));
    open.play(buildThreads(3, "busy"));
    await open.advance(WALK_LIMIT);

    expect(open.departed).toEqual([]);
    for (const id of ["t0", "t1", "t2"]) {
      expect(isOn(open.rigs.get(id)!, open.office.homes.get(id)!)).toBe(true);
      expect(readAction(open.rigs.get(id)!)).toBe("type");
    }
  });

  /**
   * Plays the world of `stayers`, which lacks `leavers`, and returns the ids of
   * each report of `onDeparted`, and which leavers were still in view at the first.
   */
  const watchDepartures = async (
    open: OpenOffice,
    stayers: ReadonlyArray<Session>,
    leavers: ReadonlyArray<string>,
  ) => {
    const rigs = leavers.map((id) => [id, open.rigs.get(id)!] as const);
    let inViewAtFirstReport: string[] | undefined;
    open.play(stayers);
    await open.advance(WALK_LIMIT, () => {
      if (open.reports.length === 0) return;
      inViewAtFirstReport ??= rigs.filter(([, rig]) => rig.object.visible).map(([id]) => id);
    });
    return { reports: open.reports.map((ids) => [...ids].sort()), inViewAtFirstReport };
  };

  it("reports two threads that leave from different rooms separately, each when it is out", async () => {
    const stayer = buildThread("t0", "working");
    const open = openOffice([
      stayer,
      buildThread("w1", "working"),
      buildThread("c1", "working", null),
    ]);

    const { reports, inViewAtFirstReport } = await watchDepartures(open, [stayer], ["w1", "c1"]);

    expect(reports.map((ids) => ids.length)).toEqual([1, 1]);
    expect(reports.flat().sort()).toEqual(["c1", "w1"]);
    // The first report came while the other was still on its way out.
    expect(inViewAtFirstReport).toEqual(["w1", "c1"].filter((id) => id !== reports[0]![0]));
  });

  it("reports two threads that leave from the same room together, once the second is out", async () => {
    const stayer = buildThread("t0", "working");
    const open = openOffice([stayer, buildThread("w1", "working"), buildThread("w2", "working")]);

    const { reports } = await watchDepartures(open, [stayer], ["w1", "w2"]);

    expect(reports).toEqual([["w1", "w2"]]);
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
    const street = office.spots.frontPavement.position;
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

  it("keeps each Lounge sitter on its own armchair through a rebuild, with no walk", async () => {
    const sitters = ["t1", "t2", "t3", "t4"].map((id) => buildThread(id, "idle"));
    const open = openOffice(sitters);
    const armchairs = new Map(
      sitters.map(({ id }) => [
        id,
        open.office.spots.lounge.findIndex((seat) => isOn(open.rigs.get(id)!, seat)),
      ]),
    );
    expect([...armchairs.values()].every((index) => index >= 0)).toBe(true);
    const before = open.office;
    const counts = new Map(sitters.map(({ id }) => [id, open.rigs.get(id)!.actions.length]));

    open.play([...sitters, buildNewcomer()]);

    expect(open.office).not.toBe(before);
    const check = () => {
      for (const [id, index] of armchairs) {
        const rig = open.rigs.get(id)!;
        expect(isOn(rig, open.office.spots.lounge[index]!), id).toBe(true);
        expect(rig.actions.slice(counts.get(id)), id).not.toContain("walk");
      }
    };
    check();
    await open.advance(WALK_LIMIT);
    check();
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

describe("a rebuild while colleagues walk", () => {
  it("lets a colleague who went for the Lounge go to the queue once it waits, with no armchair held twice", async () => {
    // Several colleagues sit in the Lounge, so the walker's nearest armchair is one of theirs.
    const sitters = ["t1", "t2", "t3", "t4"].map((id) => buildThread(id, "idle"));
    const open = openOffice([buildThread("t0", "working"), ...sitters]);
    open.play([buildThread("t0", "idle"), ...sitters]);
    await open.advance(1.5);
    expect(readAction(open.rigs.get("t0")!)).toBe("walk");

    // One world makes t0 wait and adds a thread, so the building is rebuilt in the same call.
    const before = open.office;
    open.play([buildThread("t0", "waiting"), ...sitters, buildThread("t5", "working")]);
    expect(open.office).not.toBe(before);
    await open.advance(WALK_LIMIT);

    const { office, rigs } = open;
    expect(isOn(rigs.get("t0")!, office.spots.queue[0]!)).toBe(true);
    expect(readAction(rigs.get("t0")!)).toBe("raise-hand");
    for (const seat of office.spots.lounge) {
      expect([...rigs.values()].filter((rig) => isOn(rig, seat)).length).toBeLessThanOrEqual(1);
    }
  });
});

describe("a room that gains or loses a desk", () => {
  /** Returns the actions each rig of `ids` has recorded so far. */
  const countActions = (open: OpenOffice, ids: ReadonlyArray<string>) =>
    new Map(ids.map((id) => [id, open.rigs.get(id)!.actions.length]));

  /** Checks that each of `ids` sits on its new home seat and has not walked or stood since `counts`. */
  const expectOnNewSeatsWithoutWalk = (
    open: OpenOffice,
    ids: ReadonlyArray<string>,
    counts: ReadonlyMap<string, number>,
  ) => {
    for (const id of ids) {
      const rig = open.rigs.get(id)!;
      expect(isOn(rig, open.office.homes.get(id)!), id).toBe(true);
      const since = rig.actions.slice(counts.get(id));
      expect(since, id).not.toContain("walk");
      expect(since, id).not.toContain("stand");
    }
  };

  it("puts the colleagues at their desks on their new seats with no walk, when a fourth joins a room of three", async () => {
    const ids = ["t0", "t1", "t2"];
    const open = openOffice(buildThreads(3, "busy"));
    const homesBefore = ids.map((id) => open.office.homes.get(id)!.position.clone());
    const counts = countActions(open, ids);

    open.play(buildThreads(4, "busy"));

    // The new desk moves at least one of the others, or the test proves nothing.
    expect(
      ids.some((id, i) => open.office.homes.get(id)!.position.distanceTo(homesBefore[i]!) > 0.1),
    ).toBe(true);
    expectOnNewSeatsWithoutWalk(open, ids, counts);
    await open.advance(WALK_LIMIT);
    expectOnNewSeatsWithoutWalk(open, ids, counts);
  });

  it("puts the colleagues who stay on their new seats with no walk, when one of four leaves and the building is rebuilt", async () => {
    const ids = ["t0", "t1", "t2"];
    const open = openOffice(buildThreads(4, "busy"));

    open.play(buildThreads(3, "busy"));
    for (let second = 0; second < WALK_LIMIT && open.departed.length === 0; second++) {
      await open.advance(1);
    }
    expect(open.departed).toEqual(["t3"]);
    const homesBefore = ids.map((id) => open.office.homes.get(id)!.position.clone());
    const counts = countActions(open, ids);

    // The leaver's desk goes only once it is reported, so this rebuilds the building.
    open.play(buildThreads(3, "busy"));

    expect(open.office.homes.has("t3")).toBe(false);
    expect(
      ids.some((id, i) => open.office.homes.get(id)!.position.distanceTo(homesBefore[i]!) > 0.1),
    ).toBe(true);
    expectOnNewSeatsWithoutWalk(open, ids, counts);
    await open.advance(WALK_LIMIT);
    expectOnNewSeatsWithoutWalk(open, ids, counts);
  });
});

describe("threads that leave, one of which comes back before it is reported", () => {
  it("reports only the one that went, and walks the returning one in to its desk", async () => {
    const stayer = buildThread("t0", "working");
    const open = openOffice([stayer, buildThread("w1", "working"), buildThread("w2", "working")]);
    const walkers = new Map(["w1", "w2"].map((id) => [id, open.rigs.get(id)!] as const));
    open.play([stayer]);

    // Wait until one is out of sight while the other still walks.
    let first: string | undefined;
    for (let frame = 0; frame < WALK_LIMIT * 20 && first === undefined; frame++) {
      await open.advance(0.05);
      first = [...walkers].find(([, rig]) => !rig.object.visible)?.[0];
    }
    expect(first).toBeDefined();
    const back = first!;
    const gone = back === "w1" ? "w2" : "w1";
    expect(walkers.get(gone)!.object.visible).toBe(true);
    expect(open.reports).toEqual([]);

    open.play([stayer, buildThread(back, "working")]);
    expect(open.sim.readStates().has(back)).toBe(true);
    await open.advance(WALK_LIMIT);

    expect(open.reports).toEqual([[gone]]);
    expect(open.sim.readStates().has(back)).toBe(true);
    const rig = open.rigs.get(back)!;
    expect(rig.object.visible).toBe(true);
    expect(isOn(rig, open.office.homes.get(back)!)).toBe(true);
    expect(readAction(rig)).toBe("type");
  });
});

describe("a world that changes nothing to draw", () => {
  it("asks for no frame when only a thread's last activity differs, and for one when a pose changes", () => {
    const thread = buildThread("t0", "working");
    const open = openOffice([thread]);
    const { requestRender } = open;
    const framesBefore = requestRender.mock.calls.length;

    const changedByActivity = open.play([
      { ...thread, lastActivityAt: "2030-01-01T00:00:00.000Z" },
    ]);

    expect(changedByActivity).toBe(false);
    expect(requestRender).toHaveBeenCalledTimes(framesBefore);

    const changedByPose = open.play([buildThread("t0", "idle")]);

    expect(changedByPose).toBe(true);
    expect(requestRender.mock.calls.length).toBeGreaterThan(framesBefore);
  });
});

describe("many joins and leaves", () => {
  it(
    "leave the sim with the colleagues of the last world and no timers",
    { timeout: 30_000 },
    async () => {
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
    },
  );
});
