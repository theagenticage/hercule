/**
 * Electron's main process for scripts/perf-office.ts, which starts it
 * through scripts/sheet-server.ts.
 *
 * For each scenario it opens the Office performance page
 * (specimens/office-perf.tsx) in a hidden 1440 × 900 window at 2x, lets the
 * office settle for `SETTLE_MS`, and reads:
 *
 * - the time the page took to build the first office;
 * - the CPU of the page's renderer and of the GPU process, as a share of one
 *   core: the growth of `cumulativeCPUUsage` from `app.getAppMetrics()` over
 *   `SAMPLE_MS`, divided by the seconds sampled (spec 17 §Measuring);
 * - the WebGL draw calls a second over the same sample;
 * - the working set of the renderer and of the GPU process, in MB, at the
 *   end of the sample. The working set counts the framework's shared pages
 *   once in each process, so it reads above the physical footprint the
 *   app's budget limits; compare it between scenarios, not with the budget;
 * - the median of `REBUILDS` rebuilds, each for the world with one more run.
 *
 * Then it prints one row per scenario and exits with 0. It fails no budget.
 *
 * Electron loads this file as TypeScript by stripping its types, so it uses
 * only syntax that stripping can erase: no enums, namespaces or parameter
 * properties.
 */
import { app, type BrowserWindow } from "electron";
import { setTimeout as sleep } from "node:timers/promises";
import { openSheet, startCaptureApp } from "./sheet-window.ts";

/** How long the office runs before it is measured, and how long the sample lasts. */
const SETTLE_MS = 8_000;
const SAMPLE_MS = 20_000;
/** How many rebuilds the median is taken over. */
const REBUILDS = 3;

/** The worlds measured: live runs of three sessions each, and working threads. */
const SCENARIOS: ReadonlyArray<{ readonly name: string; readonly query: string }> = [
  { name: "16 threads", query: "threads=16" },
  { name: "1 run x 3", query: "runs=1" },
  { name: "5 runs x 3", query: "runs=5" },
  { name: "20 runs x 3", query: "runs=20" },
  { name: "50 threads", query: "threads=50" },
  { name: "100 threads", query: "threads=100" },
];

/** What one process reads in `app.getAppMetrics()`: its CPU so far, in seconds, and its working set. */
interface ProcessReading {
  readonly cpuSeconds: number;
  readonly workingSetMb: number;
}

/** Returns the reading of the process `pid`, or of the GPU process when `pid` is null. */
function readProcess(pid: number | null): ProcessReading {
  const metric = app
    .getAppMetrics()
    .find((each) => (pid === null ? each.type === "GPU" : each.pid === pid));
  if (metric === undefined)
    throw new Error(`No process ${String(pid ?? "GPU")} in the app's metrics.`);
  return {
    cpuSeconds: metric.cpu.cumulativeCPUUsage ?? 0,
    workingSetMb: metric.memory.workingSetSize / 1024,
  };
}

/** Runs `script` in the page and returns its result as a number. */
async function readNumber(window: BrowserWindow, script: string): Promise<number> {
  return Number(await window.webContents.executeJavaScript(script));
}

/** Measures one scenario and returns its row of the report. */
async function measureScenario(sheetsUrl: string, query: string): Promise<string[]> {
  const window = await openSheet(`${sheetsUrl}office-perf.html?${query}`);
  try {
    const pid = window.webContents.getOSProcessId();
    await sleep(SETTLE_MS);
    const renderer0 = readProcess(pid);
    const gpu0 = readProcess(null);
    const draws0 = await readNumber(window, "window.officePerf.readDrawCalls()");
    await sleep(SAMPLE_MS);
    const renderer1 = readProcess(pid);
    const gpu1 = readProcess(null);
    const draws1 = await readNumber(window, "window.officePerf.readDrawCalls()");
    const seconds = SAMPLE_MS / 1000;
    const buildMs = await readNumber(window, "window.officePerf.buildMs");
    const rebuilds: number[] = [];
    for (let index = 0; index < REBUILDS; index++) {
      rebuilds.push(await readNumber(window, "window.officePerf.rebuild()"));
    }
    rebuilds.sort((a, b) => a - b);
    const percent = (from: ProcessReading, to: ProcessReading) =>
      `${(((to.cpuSeconds - from.cpuSeconds) / seconds) * 100).toFixed(1)}%`;
    return [
      buildMs.toFixed(0),
      rebuilds[Math.floor(REBUILDS / 2)]!.toFixed(0),
      percent(renderer0, renderer1),
      percent(gpu0, gpu1),
      ((draws1 - draws0) / seconds).toFixed(0),
      renderer1.workingSetMb.toFixed(0),
      gpu1.workingSetMb.toFixed(0),
    ];
  } finally {
    window.destroy();
  }
}

startCaptureApp(async (sheetsUrl) => {
  const header = [
    "world",
    "build ms",
    "rebuild ms",
    "renderer CPU",
    "GPU CPU",
    "draws/s",
    "renderer MB",
    "GPU MB",
  ];
  const lines = [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`];
  for (const scenario of SCENARIOS) {
    const row = await measureScenario(sheetsUrl, scenario.query);
    lines.push(`| ${[scenario.name, ...row].join(" | ")} |`);
  }
  return { report: `${lines.join("\n")}\n`, passed: true };
});
