/**
 * Tests for the sim, run on the real Bureau map: the office is built as the
 * Office screen builds it, with stand-in rigs that record each colleague's
 * action, and a stage that only counts as one. Time moves with fake timers
 * and synthetic frames, and `Math.random` is seeded, so every run walks the
 * same way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Object3D } from "three";
import type { Session } from "@hercule/contract";
import { MOSS, buildSession } from "@hercule/client-core/threads/testing";
import { buildBureau } from "../maps/bureau";
import { buildWorld } from "../world/build-world";
import type { Action, BuiltOffice, ColleagueRig, Sim } from "./contracts";
import { createNavBuilder } from "./nav";
import { buildSim } from "./sim";
import type { Stage } from "./stage";

/** A rig that draws nothing and records the last action the sim gave it. */
interface RecordingRig extends ColleagueRig {
  readonly actions: Action[];
}

/** Returns a rig for `colleague` that records its actions. */
const buildRecordingRig = (colleague: ColleagueRig["colleague"]): RecordingRig => {
  const actions: Action[] = [];
  return {
    colleague,
    object: new Object3D(),
    headHeight: 1.6,
    actions,
    setAction: (action) => void actions.push(action),
    setFace: () => {},
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
}

const opened: Sim[] = [];

/** Builds the Bureau office for `sessions` on moss, and starts its sim. */
const openOffice = (sessions: ReadonlyArray<Session>): OpenOffice => {
  const world = buildWorld({
    sessions,
    projects: [],
    workspaces: [],
    runners: [MOSS],
    localRunnerId: MOSS.id,
  });
  const office = buildBureau({ world, nav: createNavBuilder() });
  const rigs = new Map(
    world.colleagues.map((colleague) => [colleague.id, buildRecordingRig(colleague)]),
  );
  const stage = { requestRender: () => {} } as unknown as Stage;
  const sim = buildSim({ world, office, rigs, stage });
  opened.push(sim);
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
  };
};

/** Returns `count` threads on moss in `status`, with ids `t0`, `t1`, and so on. */
const buildThreads = (count: number, status: Session["status"]): Session[] =>
  Array.from({ length: count }, (_, index) =>
    buildSession({ id: `t${index}`, title: `t${index}`, runnerId: MOSS.id, status }),
  );

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
