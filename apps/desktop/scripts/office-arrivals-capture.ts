/**
 * Electron's main process for scripts/perf-office-arrivals.ts, which starts
 * it through scripts/sheet-server.ts. Each reading opens the Office
 * performance page (specimens/office-perf.tsx) on a world of 16 threads, in a
 * hidden window, and prints two tables:
 *
 * - on the real clock, because frames are what is measured: the frames
 *   drawn, the seconds taken and the frames a second from the moment a run of
 *   10 sessions starts until its colleagues have walked in and stand still;
 *   the same for one thread that only changes its pose; and the frames drawn
 *   in 3 s with nothing changed and in 3 s after a thread's last activity
 *   changes, which must be the same;
 * - on the page's fast clock (`?clock=fast`), because walks take most of
 *   the time: the WebGL buffers, textures and vertex arrays alive and the
 *   colleagues' bodies in the scene, before, after the first of five rounds in
 *   which ten colleagues join and leave, and after the last. The fast clock
 *   also reports how many times faster than real time it ran.
 *
 * It logs the seconds each reading took on stderr, prints the tables and
 * exits with 0. It fails no budget.
 *
 * Electron loads this file as TypeScript by stripping its types, so it uses
 * only syntax that stripping can erase: no enums, namespaces or parameter
 * properties.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { openSheet, startCaptureApp } from "./sheet-window.ts";

/** How many rounds of ten colleagues joining and leaving the leak check plays: 50 joins and leaves. */
const ROUNDS = 5;
/** The sessions of the run whose start is measured. */
const RUN_SIZE = 10;
/** The world every reading is made on. */
const WORLD = "threads=16";
/** How long a reading may take before it fails, in ms. */
const READING_TIMEOUT_MS = 90_000;

/** What the page's `measureStart` and `measurePose` return. */
interface Settling {
  readonly frames: number;
  readonly seconds: number;
}

/** What the page reads of the scene at one moment. */
interface SceneReading {
  readonly buffers: number;
  readonly textures: number;
  readonly vertexArrays: number;
  readonly bodies: number;
}

/**
 * Runs `script`, which returns a promise, in a fresh page of the world and
 * returns what it resolves to. Logs, under `name`, the seconds the page took
 * to load and the seconds the script took, on stderr. Fails when the script
 * takes too long.
 */
async function runInPage<T>(
  sheetsUrl: string,
  name: string,
  query: string,
  script: string,
): Promise<T> {
  const begun = Date.now();
  const window = await openSheet(`${sheetsUrl}office-perf.html?${WORLD}${query}`);
  try {
    // Lets the first frames and the fonts finish, so they are not counted.
    await sleep(3_000);
    const loaded = Date.now();
    const timeout = sleep(READING_TIMEOUT_MS).then(() => {
      throw new Error(`The page took over ${String(READING_TIMEOUT_MS / 1000)} s for ${name}.`);
    });
    const result = (await Promise.race([
      window.webContents.executeJavaScript(script),
      timeout,
    ])) as T;
    const seconds = (from: number, to: number) => ((to - from) / 1000).toFixed(1);
    process.stderr.write(
      `${name}: load ${seconds(begun, loaded)} s, run ${seconds(loaded, Date.now())} s\n`,
    );
    return result;
  } finally {
    window.destroy();
  }
}

startCaptureApp(async (sheetsUrl) => {
  const started = Date.now();
  // One page for the three readings, one after the other: each waits until the colleagues stand still.
  const { start, pose, activity } = await runInPage<{
    start: Settling;
    pose: Settling;
    activity: { unchanged: number; changed: number };
  }>(
    sheetsUrl,
    "the real clock's readings",
    "",
    `(async () => ({
      start: await window.officePerf.measureStart(${RUN_SIZE}),
      pose: await window.officePerf.measurePose(),
      activity: await window.officePerf.measureActivity(),
    }))()`,
  );
  const fastStarted = Date.now();
  const leak = await runInPage<{
    before: SceneReading;
    warm: SceneReading;
    after: SceneReading;
    virtualSeconds: number;
  }>(
    sheetsUrl,
    "the leak check on the fast clock",
    "&clock=fast",
    `(async () => {
      const begun = performance.now();
      const readings = await window.officePerf.measureJoinsAndLeaves(${ROUNDS});
      return { ...readings, virtualSeconds: (performance.now() - begun) / 1000 };
    })()`,
  );
  const fastSeconds = (Date.now() - fastStarted) / 1000;
  const row = (name: string, { frames, seconds }: Settling) =>
    `| ${[name, frames, seconds.toFixed(1), (frames / seconds).toFixed(1)].join(" | ")} |`;
  const leakRow = (name: string, reading: SceneReading) =>
    `| ${[name, reading.buffers, reading.textures, reading.vertexArrays, reading.bodies].join(" | ")} |`;
  const lines = [
    "| change | frames | seconds | frames/s |",
    "|---|---|---|---|",
    row(`run of ${String(RUN_SIZE)} starts`, start),
    row("one pose changes", pose),
    `| nothing changes, 3 s | ${String(activity.unchanged)} | 3.0 | ${(activity.unchanged / 3).toFixed(1)} |`,
    `| only last activity changes, 3 s | ${String(activity.changed)} | 3.0 | ${(activity.changed / 3).toFixed(1)} |`,
    "",
    `| ${String(ROUNDS * 10)} joins and leaves | buffers | textures | vertex arrays | bodies |`,
    "|---|---|---|---|---|",
    leakRow("before", leak.before),
    leakRow("after the first round", leak.warm),
    leakRow("after all", leak.after),
    "",
    `fast clock: ${leak.virtualSeconds.toFixed(0)} s of page time in ${fastSeconds.toFixed(1)} s, ${(leak.virtualSeconds / fastSeconds).toFixed(1)}x`,
    `total: ${((Date.now() - started) / 1000).toFixed(1)} s`,
  ];
  return { report: `${lines.join("\n")}\n`, passed: true };
});
