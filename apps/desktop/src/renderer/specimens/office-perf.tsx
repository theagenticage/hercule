/**
 * The Office drawn from a fixture world, for `pnpm --filter @hercule/desktop
 * perf:office` (scripts/perf-office.ts), which reads what it costs. It is not
 * a reference sheet: nothing is compared with the book.
 *
 * The page takes its world from its URL:
 * - `?runs=<n>` puts n live runs of three sessions each in webshop's room;
 * - `?threads=<n>` puts n working threads in three projects, and in the café;
 * - `?theme=` as every sheet takes it.
 * - `?clock=fast` runs the page on a virtual clock, many times faster than
 *   real time (see `installFastClock`);
 *
 * Once the office is built, the page sets `data-ready`, and answers on
 * `window.officePerf`:
 * - `buildMs`: how long building the first office took, rigs included;
 * - `rebuild()`: builds the office again for the world with one more run,
 *   and returns how long that took, in ms;
 * - `readDrawCalls()`: how many WebGL draw calls the page has made so far;
 * - `measureStart(count)`, `measurePose()` and `measureActivity()`: play a
 *   world in which a run of `count` sessions starts, or in which one thread
 *   only changes its pose, or only its last activity, and return the frames
 *   drawn and the seconds taken until the colleagues concerned stand still;
 * - `measureJoinsAndLeaves(rounds)`: in each round, ten threads join and
 *   then leave, and returns the live WebGL objects and the colleagues'
 *   bodies in the scene before, after the first round, and at the end.
 *
 * The capture window is hidden, and the Office draws nothing while the
 * document is hidden. The page reports itself visible, so the Office draws
 * as it does on screen.
 */
import "../styles/base-layer.css";
import "../office/ui/office.css";
import type { RunSummary, Session } from "@hercule/contract";
import {
  INFRA,
  MOSS,
  OPS_PROJECT,
  RUNBOOKS,
  WEBSHOP,
  WEBSHOP_PROJECT,
  buildProject,
  buildSession,
} from "@hercule/client-core/threads/testing";
import type { Object3D } from "three";
import { mountOfficeScene } from "../office/office-scene";
import { buildWorld } from "../office/world/build-world";
import { applySheetTheme, markSheetReady } from "./sheet-page";

Object.defineProperty(document, "hidden", { get: () => false });
Object.defineProperty(document, "visibilityState", { get: () => "visible" });

/** The length of one frame on the fast clock, in ms: the 30 fps the stage's ambient life runs at. */
const FAST_FRAME_MS = 1000 / 30;

/**
 * Replaces the page's clock with a virtual one, so the Office runs many
 * times faster than real time and still draws every frame. Must run before
 * the scene is mounted.
 *
 * - `performance.now()` returns the virtual time.
 * - `requestAnimationFrame` callbacks run back to back, each round advancing
 *   the virtual time by `FAST_FRAME_MS`. The stage then draws a frame of
 *   1/30 s every round: it caps a frame's length at 1/20 s and its own frame
 *   limiter reads the same virtual time.
 * - `setTimeout` callbacks run when the virtual time reaches their deadline.
 *   When no frame is waiting, the time jumps to the next deadline.
 *
 * Rounds are paced by a MessageChannel, which the clock does not replace.
 */
function installFastClock(): void {
  let now = 0;
  let nextId = 1;
  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, { at: number; run: () => void }>();
  const channel = new MessageChannel();
  let pending = false;
  const schedule = (): void => {
    if (pending) return;
    pending = true;
    channel.port2.postMessage(null);
  };
  channel.port1.onmessage = () => {
    pending = false;
    const next = Math.min(...Array.from(timers.values(), ({ at }) => at));
    now = frames.size > 0 ? now + FAST_FRAME_MS : Math.max(now, next);
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > now) continue;
      timers.delete(id);
      timer.run();
    }
    const due = [...frames];
    frames.clear();
    for (const [, callback] of due) callback(now);
    if (frames.size > 0 || timers.size > 0) schedule();
  };
  performance.now = () => now;
  window.requestAnimationFrame = (callback) => {
    frames.set(nextId, callback);
    schedule();
    return nextId++;
  };
  window.cancelAnimationFrame = (id) => void frames.delete(id);
  Reflect.set(window, "setTimeout", (callback: () => void, ms = 0) => {
    timers.set(nextId, { at: now + ms, run: callback });
    schedule();
    return nextId++;
  });
  Reflect.set(window, "clearTimeout", (id: number) => void timers.delete(id));
}

const params = new URLSearchParams(location.search);
if (params.get("clock") === "fast") installFastClock();

let drawCalls = 0;
for (const method of ["drawElements", "drawArrays", "drawElementsInstanced"]) {
  const draw: unknown = Reflect.get(WebGL2RenderingContext.prototype, method);
  if (typeof draw !== "function") continue;
  Reflect.set(
    WebGL2RenderingContext.prototype,
    method,
    function (this: unknown, ...args: unknown[]) {
      drawCalls += 1;
      return Reflect.apply(draw, this, args) as unknown;
    },
  );
}

/**
 * How many frames the page has drawn. The stage draws a frame in an
 * animation frame callback, through several passes, so counting draw calls
 * or clears would count a frame many times. A callback that made at least one
 * draw call is one frame.
 */
let framesDrawn = 0;
const requestFrame = window.requestAnimationFrame.bind(window);
window.requestAnimationFrame = (callback) =>
  requestFrame((time) => {
    const before = drawCalls;
    callback(time);
    if (drawCalls > before) framesDrawn += 1;
  });

/** The WebGL objects alive now, by kind: created and not yet deleted. */
const liveObjects = { buffers: 0, textures: 0, vertexArrays: 0 };
for (const [kind, create, remove] of [
  ["buffers", "createBuffer", "deleteBuffer"],
  ["textures", "createTexture", "deleteTexture"],
  ["vertexArrays", "createVertexArray", "deleteVertexArray"],
] as const) {
  const proto = WebGL2RenderingContext.prototype;
  const created: unknown = Reflect.get(proto, create);
  const deleted: unknown = Reflect.get(proto, remove);
  if (typeof created !== "function" || typeof deleted !== "function") continue;
  Reflect.set(proto, create, function (this: unknown, ...args: unknown[]) {
    liveObjects[kind] += 1;
    return Reflect.apply(created, this, args) as unknown;
  });
  Reflect.set(proto, remove, function (this: unknown, ...args: unknown[]) {
    if (args[0] !== null) liveObjects[kind] -= 1;
    return Reflect.apply(deleted, this, args) as unknown;
  });
}

const runCount = Number(params.get("runs") ?? "0");
const threadCount = Number(params.get("threads") ?? "0");
const PAYMENTS_PROJECT = buildProject("p-payments", "payments");
const PROJECTS = [WEBSHOP_PROJECT, OPS_PROJECT, PAYMENTS_PROJECT];

/** Returns a running run, started `index` minutes past nine. */
const buildRun = (index: number): RunSummary => ({
  id: `run-${String(index)}`,
  workflowId: null,
  workflowName: "Review",
  origin: { kind: "manual", actor: "user" },
  createdAt: new Date(Date.UTC(2026, 8, 10, 9, index)).toISOString(),
  status: "running",
  startedAt: new Date(Date.UTC(2026, 8, 10, 9, index)).toISOString(),
  activeStepIds: [],
  awaitedSignalIds: [],
});

/** A live run in webshop's room: how many sessions it has, and how many of them are done. */
interface RunPlan {
  readonly index: number;
  readonly size: number;
  readonly done: number;
}

/** Returns the sessions of `run` in webshop's room: the first `run.done` exited, the rest working. */
const buildRunSessions = (run: RunPlan): Session[] =>
  Array.from({ length: run.size }, (_, number) =>
    buildSession({
      id: `s-run-${String(run.index)}-${String(number)}`,
      title: `Review · step ${String(number + 1)}`,
      agentId: "a-reviewer",
      runId: `run-${String(run.index)}`,
      stepId: `step-${String(number)}`,
      projectId: WEBSHOP_PROJECT.id,
      runnerId: MOSS.id,
      status: number < run.done ? "exited" : "busy",
    }),
  );

/**
 * Returns `count` working threads, a quarter in each project and a quarter
 * with no project, which sit in the café.
 */
const buildThreads = (count: number): Session[] =>
  Array.from({ length: count }, (_, index) =>
    buildSession({
      id: `s-thread-${String(index)}`,
      title: `Thread ${String(index)}`,
      projectId: index % 4 === 3 ? null : PROJECTS[index % 4]!.id,
      runnerId: MOSS.id,
      status: index % 5 === 0 ? "idle" : "busy",
    }),
  );

/** Returns a working thread in `projectId`, or in the café when that is null. */
const buildThread = (id: string, title: string, projectId: string | null): Session =>
  buildSession({ id, title, projectId, runnerId: MOSS.id, status: "busy" });

/** What the world holds now. The page changes it, and plays the result. */
const fixture: { threads: Session[]; runs: RunPlan[] } = {
  threads: buildThreads(threadCount),
  runs: Array.from({ length: runCount }, (_, index) => ({ index, size: 3, done: 1 })),
};

/** Returns the world of the fixture's threads and live runs. */
const buildFixtureWorld = () =>
  buildWorld({
    sessions: [...fixture.threads, ...fixture.runs.flatMap(buildRunSessions)],
    liveRuns: fixture.runs.map(({ index }) => buildRun(index)),
    projects: PROJECTS,
    workspaces: [],
    resources: [WEBSHOP, INFRA, RUNBOOKS],
    runners: [MOSS],
    assistants: [],
    localRunnerId: MOSS.id,
  });

applySheetTheme();
const root = document.getElementById("root")!;
root.style.cssText = "position:fixed;inset:0";
const stage = document.createElement("div");
stage.style.cssText = "position:absolute;inset:0";
const deck = document.createElement("div");
root.append(stage, deck);

/** The Three.js scene the office is in: the parent of the built office's root. Set at every build. */
let threeScene: Object3D | null = null;
const started = performance.now();
const scene = mountOfficeScene(stage, deck, buildFixtureWorld(), (office) => {
  threeScene = office.root.parent;
});
const buildMs = performance.now() - started;

/** Returns the bodies of the colleagues in the scene, by the id of the colleague. */
const listBodies = (): Map<string, Object3D> =>
  new Map(
    (threeScene?.children ?? [])
      .filter((child) => child.name.startsWith("colleague "))
      .map((child) => [child.name.slice("colleague ".length), child]),
  );

/** Plays the fixture's world on the scene. */
const play = (): void => scene.setWorld(buildFixtureWorld());

/** Resolves after `ms` milliseconds of the page's clock. */
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** How long the bodies must stand where they are before they count as still. */
const STILL_MS = 1_000;
/** How long to wait for a body to settle or to leave before giving up, on the page's clock. */
const TIMEOUT_MS = 120_000;
/** How many colleagues join together, and then leave together, in one round of the leak check. */
const JOIN_BATCH = 10;

/** What a wait for stillness read: the frames drawn and the seconds taken until the last body moved. */
interface Settling {
  readonly frames: number;
  readonly seconds: number;
}

/**
 * Waits until every colleague in `ids` has a visible body that has not moved
 * for `STILL_MS`, and returns the frames drawn and the seconds taken from the
 * call until the last of them moved. Fails when they do not settle in time.
 */
async function waitUntilStill(ids: readonly string[]): Promise<Settling> {
  const begun = performance.now();
  const framesBegun = framesDrawn;
  const last = new Map<string, string>();
  const seen = new Set<string>();
  let movedAt = begun;
  let framesAtMove = framesBegun;
  while (performance.now() - movedAt < STILL_MS) {
    if (performance.now() - begun > TIMEOUT_MS)
      throw new Error("The colleagues did not stand still in time.");
    await wait(50);
    const bodies = listBodies();
    for (const id of ids) {
      const body = bodies.get(id);
      const place =
        body === undefined || !body.visible ? "not drawn" : body.position.toArray().join();
      // A colleague whose turn to walk in has not come is not drawn yet, and is not still.
      if (place !== "not drawn") seen.add(id);
      if (last.get(id) === place && seen.has(id)) continue;
      last.set(id, place);
      movedAt = performance.now();
      framesAtMove = framesDrawn;
    }
  }
  return { frames: framesAtMove - framesBegun, seconds: (movedAt - begun) / 1000 };
}

/** Waits until the bodies of the colleagues in `ids` are out of the scene, and the building is rebuilt. */
async function waitUntilGone(ids: readonly string[]): Promise<void> {
  const begun = performance.now();
  while (ids.some((id) => listBodies().has(id))) {
    if (performance.now() - begun > TIMEOUT_MS)
      throw new Error("The colleagues did not walk out in time.");
    await wait(50);
  }
  await wait(200);
}

/** Returns the WebGL objects alive and the colleagues' bodies in the scene now. */
const readScene = () => ({ ...liveObjects, bodies: listBodies().size });

/** Replaces the thread `id` in the fixture with itself changed by `change`, and plays the world. */
const changeThread = (id: string, change: Partial<Session>): void => {
  fixture.threads = fixture.threads.map((each) => (each.id === id ? { ...each, ...change } : each));
  play();
};

let nextRun = runCount;

Object.assign(window, {
  officePerf: {
    buildMs,
    rebuild: (): number => {
      fixture.runs.push({ index: nextRun++, size: 3, done: 1 });
      const begun = performance.now();
      play();
      return performance.now() - begun;
    },
    readDrawCalls: (): number => drawCalls,
    measureStart: async (count: number): Promise<Settling> => {
      const run: RunPlan = { index: nextRun++, size: count, done: 0 };
      fixture.runs.push(run);
      play();
      return waitUntilStill(buildRunSessions(run).map(({ id }) => id));
    },
    measurePose: async (): Promise<Settling> => {
      const thread = fixture.threads.find(({ status }) => status === "busy")!;
      changeThread(thread.id, { status: "idle" });
      return waitUntilStill([thread.id]);
    },
    /**
     * Returns the frames drawn in 3 s with the world unchanged, and in the 3 s
     * after a thread's last activity changed. The Office's ambient life draws
     * frames in both, so only the difference is the change's.
     */
    measureActivity: async (): Promise<{ unchanged: number; changed: number }> => {
      const thread = fixture.threads.find(({ status }) => status === "busy")!;
      const countFrames = async (): Promise<number> => {
        const framesBegun = framesDrawn;
        await wait(3_000);
        return framesDrawn - framesBegun;
      };
      const unchanged = await countFrames();
      changeThread(thread.id, { lastActivityAt: new Date(Date.now() + 60_000).toISOString() });
      return { unchanged, changed: await countFrames() };
    },
    measureJoinsAndLeaves: async (rounds: number) => {
      const joiners = Array.from({ length: JOIN_BATCH }, (_, index) =>
        buildThread(`s-joiner-${String(index)}`, `Joiner ${String(index)}`, WEBSHOP_PROJECT.id),
      );
      const ids = joiners.map(({ id }) => id);
      const round = async (): Promise<void> => {
        fixture.threads = [...fixture.threads, ...joiners];
        play();
        await waitUntilStill(ids);
        fixture.threads = fixture.threads.filter(({ id }) => !ids.includes(id));
        play();
        await waitUntilGone(ids);
      };
      const before = readScene();
      await round();
      const warm = readScene();
      for (let index = 1; index < rounds; index++) await round();
      return { before, warm, after: readScene() };
    },
  },
});
void markSheetReady();
