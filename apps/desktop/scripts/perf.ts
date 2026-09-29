/**
 * Measures the packaged desktop app and prints spec 17's budget table
 * (§Performance). Run it after `pnpm build:desktop`:
 *
 *     pnpm --filter @hercule/desktop perf
 *
 * It starts the test package twice, each time with a fresh user data
 * directory:
 *
 * 1. Through Playwright, to read each process's working set, CPU and idle
 *    wakeups a second from `app.getAppMetrics()`: with the window visible,
 *    after 3 s to settle, over 10 s; then the same with the window hidden.
 * 2. As a plain process, to measure launch: the time from spawn until the
 *    window is ready to show.
 *
 * Launch is measured without Playwright, because Playwright slows the launch
 * down: it holds each new renderer paused until it has attached to it, and it
 * connects to main through the inspector. The script notes the time, spawns
 * the app with `--remote-debugging-port=0`, and connects to the page over the
 * Chrome DevTools Protocol only once it is on screen. From the page it reads
 * when the page first painted, from the renderer's `first-paint` performance
 * entry, in milliseconds since the epoch like the time noted at spawn. Main
 * keeps no record of when `ready-to-show` fired. Electron emits
 * `ready-to-show` when the page first paints: on a copy of main that logged
 * the event, the `first-paint` entry came 4 to 18 ms after it, so the launch
 * time printed here is high by about that much. The launch is measured after
 * the Playwright run, so the app's files are already in the disk cache, as
 * the budget's warm launch assumes.
 *
 * The wakeups printed here are an upper bound. Started without Playwright and
 * sampled with `top`, the release package showed 0 wakeups a second in all
 * four processes, where this script shows about 1 for the browser process and
 * 3 to 4 for the GPU process. The difference is most likely Playwright's
 * connection to main through the inspector, which stays open while the script
 * samples.
 *
 * Launch time depends on how busy the machine is, so the script prints the
 * load average with the results.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium, type ElectronApplication } from "playwright";
// The extension is spelled out because Node runs this script as it is, and
// Node resolves no import without one.
import {
  buildAppArgs,
  buildAppEnv,
  findExecutable,
  isWindowVisible,
  launchTestPackage,
  quitApp,
} from "./packaged-app.ts";

/** The limits of spec 17's budget table that one launch of the app can check. */
const BUDGET = {
  launchMs: 500,
  processes: 4,
  summedWorkingSetMb: 420,
  rendererWorkingSetMb: 180,
  gpuWakeupsVisible: 12,
  // The budget is "no wakeups from the app". Chromium wakes an idle renderer
  // on its own, 0 to 2 times a second in the baseline, so that is the most a
  // renderer doing nothing for the app can show.
  rendererWakeups: 2,
} as const;

/** One process of the app, as `app.getAppMetrics()` reported it at the end of a 10 s sample. */
interface ProcessSample {
  readonly pid: number;
  /** The process type, with the service it runs when it has one, such as `Utility (Network Service)`. */
  readonly label: string;
  readonly type: string;
  readonly workingSetMb: number;
  /** The average CPU use over the sample, where 100 is one core. */
  readonly cpuPercent: number;
  readonly wakeupsPerSecond: number;
}

/**
 * Reads every process of the app from `app.getAppMetrics()`.
 *
 * CPU and wakeups are averages since the previous call, so a sample is two
 * calls: one to start the period, and one at its end.
 */
async function readProcesses(app: ElectronApplication): Promise<ProcessSample[]> {
  const metrics = await app.evaluate(({ app }) => app.getAppMetrics());
  return metrics.map((metric) => ({
    pid: metric.pid,
    label: metric.name === undefined ? metric.type : `${metric.type} (${metric.name})`,
    type: metric.type,
    workingSetMb: metric.memory.workingSetSize / 1024,
    cpuPercent: metric.cpu.percentCPUUsage,
    wakeupsPerSecond: metric.cpu.idleWakeupsPerSecond,
  }));
}

/** Waits 3 s for the app to settle, then returns each process's use over the next 10 s. */
async function sampleIdleUse(app: ElectronApplication): Promise<ProcessSample[]> {
  await sleep(3_000);
  await readProcesses(app);
  await sleep(10_000);
  return readProcesses(app);
}

/**
 * Creates a user data directory in the system's temporary folder, runs `use`
 * with it, and deletes it afterwards.
 */
async function runInScratchUserDataDir<T>(use: (userDataDir: string) => Promise<T>): Promise<T> {
  const userDataDir = mkdtempSync(join(tmpdir(), "hercule-desktop-perf-"));
  try {
    return await use(userDataDir);
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

/**
 * Starts the test package as a plain process and returns the milliseconds
 * from spawn to the page's first paint. Fails when the app does not open its
 * page within 10 s, or does not quit cleanly afterwards.
 */
async function measureLaunch(userDataDir: string): Promise<number> {
  const spawnedAt = Date.now();
  const child = spawn(
    findExecutable("test"),
    [...buildAppArgs(userDataDir), "--remote-debugging-port=0"],
    { env: buildAppEnv(), stdio: ["ignore", "ignore", "pipe"] },
  );
  try {
    // Chromium prints the address of its DevTools endpoint on stderr, as
    // `DevTools listening on ws://127.0.0.1:<port>/devtools/browser/<id>`.
    const endpoint = await new Promise<string>((resolve, reject) => {
      let output: string | null = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        // The stream is read to its end all the same, so that a full pipe
        // never blocks the app.
        if (output === null) return;
        output += chunk;
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
        if (match === null) return;
        output = null;
        resolve(match[1]!);
      });
      child.once("exit", () =>
        reject(new Error("the app exited before it opened its DevTools endpoint")),
      );
    });
    const { port } = new URL(endpoint);
    await waitForPageTarget(port);
    // The page is on screen by now. Waiting a little longer keeps the
    // connection below from landing while the page is still drawing.
    await sleep(1_000);

    const browser = await chromium.connectOverCDP(endpoint);
    try {
      const page = browser.contexts()[0]?.pages()[0];
      if (page === undefined) throw new Error("the app's page is not among the DevTools targets");
      await page.waitForFunction(
        () => performance.getEntriesByName("first-paint").length > 0,
        undefined,
        // Polling on a timer rather than on animation frames, because a
        // window that is not shown draws no animation frames.
        { polling: 100, timeout: 10_000 },
      );
      const firstPaint = await page.evaluate(
        () => performance.timeOrigin + performance.getEntriesByName("first-paint")[0]!.startTime,
      );
      return firstPaint - spawnedAt;
    } finally {
      await browser.close();
    }
  } finally {
    await stopApp(child);
  }
}

/**
 * Waits until the app's DevTools endpoint on `port` lists a page, and fails
 * after 10 s. It asks the endpoint's HTTP list of targets, which attaches to
 * nothing, so asking does not slow the page down.
 */
async function waitForPageTarget(port: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = (await response.json()) as { type: string; url: string }[];
    if (targets.some((target) => target.type === "page" && target.url === "app://hercule/")) return;
    await sleep(20);
  }
  throw new Error("the app did not open app://hercule/ within 10 s");
}

/**
 * Stops an app started as a plain process: sends it SIGTERM, which quits it
 * as `app.quit()` does, and waits for it to exit. Kills it after 10 s. Fails
 * unless it exits with code 0.
 */
async function stopApp(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(timer);
  }
  if (child.exitCode !== 0) {
    const ending = child.signalCode ?? `code ${String(child.exitCode)}`;
    throw new Error(`the app did not quit cleanly: its process ended with ${ending}`);
  }
}

/** Formats a Markdown table. */
function formatTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [header, header.map(() => "---"), ...rows]
    .map((cells) => `| ${cells.join(" | ")} |`)
    .join("\n");
}

/** Formats a process's working set, CPU and wakeups as table cells, or dashes when it was not running. */
function formatUse(sample: ProcessSample | undefined): string[] {
  if (sample === undefined) return ["-", "-", "-"];
  return [
    sample.workingSetMb.toFixed(1),
    sample.cpuPercent.toFixed(1),
    sample.wakeupsPerSecond.toFixed(1),
  ];
}

/** Sums the working set of every process, in MB. */
const sumWorkingSet = (samples: readonly ProcessSample[]) =>
  samples.reduce((sum, sample) => sum + sample.workingSetMb, 0);

/** Finds the process of one type, such as `Tab` for the renderer. */
const findProcess = (samples: readonly ProcessSample[], type: string) =>
  samples.find((sample) => sample.type === type);

const { visible, hidden } = await runInScratchUserDataDir(async (userDataDir) => {
  const app = await launchTestPackage(userDataDir);
  try {
    await app.firstWindow();
    const visible = await sampleIdleUse(app);
    if (!(await isWindowVisible(app))) throw new Error("the window was not visible while sampled");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide());
    const hidden = await sampleIdleUse(app);
    return { visible, hidden };
  } finally {
    await quitApp(app);
  }
});
const launchMs = await runInScratchUserDataDir(measureLaunch);

// A process that started or exited between the two samples is in one of
// them only, so the table lists every process either sample saw.
const seen = [...new Map([...visible, ...hidden].map((sample) => [sample.pid, sample.label]))];
const processRows = seen.map(([pid, label]) => [
  label,
  String(pid),
  ...formatUse(visible.find((sample) => sample.pid === pid)),
  ...formatUse(hidden.find((sample) => sample.pid === pid)),
]);
processRows.push([
  "Sum",
  "",
  sumWorkingSet(visible).toFixed(1),
  "",
  "",
  sumWorkingSet(hidden).toFixed(1),
  "",
  "",
]);

const summedMb = Math.max(sumWorkingSet(visible), sumWorkingSet(hidden));
const rendererMb = Math.max(
  findProcess(visible, "Tab")?.workingSetMb ?? 0,
  findProcess(hidden, "Tab")?.workingSetMb ?? 0,
);
const gpuWakeups = findProcess(visible, "GPU")?.wakeupsPerSecond ?? 0;
const rendererWakeupsVisible = findProcess(visible, "Tab")?.wakeupsPerSecond ?? 0;
const rendererWakeupsHidden = findProcess(hidden, "Tab")?.wakeupsPerSecond ?? 0;
const rendererLimit = `no wakeups from the app (at most ${BUDGET.rendererWakeups}/s)`;

// Budget, limit, measured, and whether the measurement is within the limit.
const budgets: [string, string, string, boolean][] = [
  [
    "Launch",
    `ready to show within ${BUDGET.launchMs} ms of spawn (warm)`,
    `${launchMs.toFixed(0)} ms`,
    launchMs <= BUDGET.launchMs,
  ],
  [
    "Processes",
    `${BUDGET.processes}: browser, GPU, network utility, renderer`,
    `${seen.length}: ${seen.map(([, label]) => label).join(", ")}`,
    seen.length <= BUDGET.processes,
  ],
  [
    "Memory, summed",
    `at most ${BUDGET.summedWorkingSetMb} MB`,
    `${summedMb.toFixed(0)} MB`,
    summedMb <= BUDGET.summedWorkingSetMb,
  ],
  [
    "Memory, renderer",
    `at most ${BUDGET.rendererWorkingSetMb} MB`,
    `${rendererMb.toFixed(0)} MB`,
    rendererMb <= BUDGET.rendererWorkingSetMb,
  ],
  [
    "Idle visible, GPU",
    `at most ${BUDGET.gpuWakeupsVisible} wakeups/s`,
    `${gpuWakeups.toFixed(1)}/s`,
    gpuWakeups <= BUDGET.gpuWakeupsVisible,
  ],
  [
    "Idle visible, renderer",
    rendererLimit,
    `${rendererWakeupsVisible.toFixed(1)}/s`,
    rendererWakeupsVisible <= BUDGET.rendererWakeups,
  ],
  [
    "Idle hidden, renderer",
    rendererLimit,
    `${rendererWakeupsHidden.toFixed(1)}/s`,
    rendererWakeupsHidden <= BUDGET.rendererWakeups,
  ],
];

const useHeader = ["Working set MB", "CPU %", "Wakeups/s"];
console.log(
  formatTable(
    [
      "Process",
      "PID",
      ...useHeader.map((cell) => `${cell}, visible`),
      ...useHeader.map((cell) => `${cell}, hidden`),
    ],
    processRows,
  ),
);
console.log();
console.log(
  formatTable(
    ["Budget", "Limit", "Measured", "Within"],
    budgets.map(([budget, limit, measured, within]) => [
      budget,
      limit,
      measured,
      within ? "yes" : "NO",
    ]),
  ),
);
console.log();
console.log(`Load average over the last minute: ${loadavg()[0]!.toFixed(2)}`);
if (budgets.some(([, , , within]) => !within)) process.exitCode = 1;
