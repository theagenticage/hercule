/**
 * The Office drawn from a fixture world, for `pnpm --filter @hercule/desktop
 * perf:office` (scripts/perf-office.ts), which reads what it costs. It is not
 * a reference sheet: nothing is compared with the book.
 *
 * The page takes its world from its URL:
 * - `?runs=<n>` puts n live runs of three sessions each in webshop's room;
 * - `?threads=<n>` puts n working threads in three projects, and in the café;
 * - `?asleep=<n>` adds n asleep threads, spread the same way, as a runner
 *   restart or an idle unload leaves them;
 * - `?theme=` as every sheet takes it.
 *
 * Once the office is built, the page sets `data-ready`, and answers on
 * `window.officePerf`:
 * - `buildMs`: how long building the first office took, rigs included;
 * - `rebuild()`: builds the office again for the world with one more run,
 *   and returns how long that took, in ms;
 * - `readDrawCalls()`: how many WebGL draw calls the page has made so far.
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
import { mountOfficeScene } from "../office/office-scene";
import { buildWorld } from "../office/world/build-world";
import { applySheetTheme, markSheetReady } from "./sheet-page";

Object.defineProperty(document, "hidden", { get: () => false });
Object.defineProperty(document, "visibilityState", { get: () => "visible" });

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

const params = new URLSearchParams(location.search);
const runCount = Number(params.get("runs") ?? "0");
const threadCount = Number(params.get("threads") ?? "0");
const asleepCount = Number(params.get("asleep") ?? "0");
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

/** Returns the three sessions of the run `index`, in webshop's room: two working, one done. */
const buildRunSessions = (index: number): Session[] =>
  ["plan", "build", "review"].map((step, number) =>
    buildSession({
      id: `s-run-${String(index)}-${step}`,
      title: `Review · ${step}`,
      agentId: "a-reviewer",
      runId: `run-${String(index)}`,
      stepId: step,
      projectId: WEBSHOP_PROJECT.id,
      runnerId: MOSS.id,
      status: number === 0 ? "exited" : "busy",
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

/** Returns `count` asleep threads: exited and resumable, spread as `buildThreads` spreads them. */
const buildAsleepThreads = (count: number): Session[] =>
  buildThreads(count).map((thread) => ({
    ...thread,
    id: `s-asleep-${thread.id}`,
    status: "exited",
    resumable: true,
  }));

/** Returns the world of `runs` live runs and the page's threads. */
const buildFixtureWorld = (runs: number) =>
  buildWorld({
    sessions: [
      ...buildThreads(threadCount),
      ...buildAsleepThreads(asleepCount),
      ...Array.from({ length: runs }, (_, index) => buildRunSessions(index)).flat(),
    ],
    liveRuns: Array.from({ length: runs }, (_, index) => buildRun(index)),
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

const started = performance.now();
const scene = mountOfficeScene(stage, deck, buildFixtureWorld(runCount), () => undefined);
const buildMs = performance.now() - started;
let worldRuns = runCount;

Object.assign(window, {
  officePerf: {
    buildMs,
    rebuild: (): number => {
      worldRuns += 1;
      const next = buildFixtureWorld(worldRuns);
      const begun = performance.now();
      scene.setWorld(next);
      return performance.now() - begun;
    },
    readDrawCalls: (): number => drawCalls,
  },
});
void markSheetReady();
