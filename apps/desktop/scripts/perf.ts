/**
 * Measures the packaged desktop app, signed in to a controller, and prints
 * spec 17's budget table (§Performance). Run it after `pnpm build:desktop`
 * and `pnpm build:binary`:
 *
 *     pnpm --filter @hercule/desktop perf
 *
 * It starts a controller from the compiled binary, `./hercule`, in a scratch
 * Hercule Home, and completes its setup. Then it starts the test package
 * three times on one fresh user data directory, with that controller saved:
 *
 * 1. Through Playwright, to sign in on the sign-in screen, as a user does
 *    once. The app saves the token with the mock keychain, so the run never
 *    touches the real Keychain.
 * 2. Through Playwright again, signed in, to warm the app up (see
 *    `warmUpApp`).
 * 3. As a plain process, signed in. From this one launch the script reads,
 *    in this order:
 *    - the memory of each of the app's processes, 13 s after the page opens;
 *    - each process's CPU and wakeups over 10 s with the window visible,
 *      from 30 s after the page opens;
 *    - the same over 10 s with the window hidden, from 3 s after hiding it;
 *    - the launch times: how long from spawn until the window was shown,
 *      and until the page's paints that lead up to it.
 *
 * Nothing stays attached to the app while memory, CPU and wakeups are read,
 * because an attached tool changes what it measures: with Playwright
 * attached, the renderer's memory read 7 MB higher on slice 1's app and 14 MB
 * higher on slice 2's. Only the launch times need a connection to the page,
 * so they are read last.
 *
 * Memory is read from outside the app, by process ID. Two numbers are read
 * for each process:
 *
 * - The physical footprint, which the budget limits: the memory `footprint`
 *   reports and Activity Monitor shows for a process.
 * - The working set, the resident size `ps` reports, which is the number
 *   `app.getAppMetrics()` reports on macOS. It is printed for information
 *   only. It counts the Electron framework's pages, which all four processes
 *   share, once in each process. The sum then reads about 200 MB above the
 *   summed footprint, however little the app itself holds: 315 MB against
 *   119 MB for an empty Electron app.
 *
 * CPU and wakeups come from `app.getAppMetrics()`, which the script calls in
 * main through the Node inspector the launch opens (see below). It connects
 * for each call and closes the connection again at once. The wakeups are the
 * kernel's count of each process's interrupt wakeups, averaged over the
 * sample and rounded to a whole number a second. `top` cannot check them: its
 * idle wakeups column counts only the wakeups that bring the whole processor
 * out of idle, and those stay at 0 on a busy machine, for every process.
 *
 * While the app is measured, its own process holds the inspector and the
 * DevTools endpoint the launch opens, both idle between the script's calls.
 *
 * Launch is measured without Playwright, because Playwright slows the launch
 * down: it holds each new renderer paused until it has attached to it, and it
 * connects to main through the inspector. The script notes the time, spawns
 * the app with `--remote-debugging-port=0`, and reads the launch times only
 * after the idle samples, each in milliseconds since the epoch like the time
 * noted at spawn:
 *
 * - `window-shown`, the budgeted one: the mark main sets in its own
 *   performance timeline when it shows the window, read through the
 *   inspector. Main shows the window once the page reports that its first
 *   screen, fonts included, has reached the window. The run fails when main
 *   logs that it showed the window without that report, on its time limit
 *   or after a failure, because the time is then not the first screen's.
 * - From the page, over the Chrome DevTools Protocol, two entries that say
 *   where the time before the show went:
 *   - `first-paint`, when the page first painted, which is when Electron
 *     emits `ready-to-show`;
 *   - `first-screen`, the mark the page sets at the moment the frame that
 *     drew its first screen was presented; the page reports to main after
 *     that. The script checks that the screen is the shell, so the time is a
 *     signed-in launch's and not the connect screen's.
 *
 * The plain launch also passes `--inspect=0` and `--use-mock-keychain`. The
 * mock keychain lets the app read the token saved in step 1. While its Node
 * inspector is closed, a packaged app refuses every argument except those
 * `buildAppArgs` passes, and `--inspect=0` opens the inspector without
 * attaching to it; the test package's fuses allow it. Opening it barely
 * moves the launch: over six launches each, before the refusal existed, the
 * median was 248 ms without it and 250 ms with it.
 *
 * The third launch finds the app's files in the disk cache and its compiled
 * scripts in Chromium's code cache, as the budget's warm launch assumes.
 *
 * Launch time depends on how busy the machine is, so the script prints the
 * load average with the results.
 */
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { ProcessMetric } from "electron";
import { chromium } from "playwright";
// The extensions are spelled out because Node runs this script as it is, and
// Node resolves no import without one.
import {
  buildAppArgs,
  evaluateInMain,
  findExecutable,
  formatTable,
  launchTestPackage,
  MOCK_KEYCHAIN_SWITCH,
  quitApp,
  runWithScratchController,
  signInOnce,
  stopApp,
  writeSettings,
} from "./packaged-app.ts";
import { buildAppEnv } from "./processes.ts";
import { SHOWN_WITHOUT_FIRST_SCREEN_ERROR } from "../src/main/window-visibility.ts";

/** The limits of spec 17's budget table that one launch of the app can check. */
const BUDGET = {
  launchMs: 500,
  processes: 4,
  summedFootprintMb: 220,
  rendererFootprintMb: 100,
  gpuWakeupsVisible: 12,
  // The budget is "no wakeups from the app". Chromium wakes an idle renderer
  // on its own, 0 to 2 times a second in the baseline, so that is the most a
  // renderer doing nothing for the app can show.
  rendererWakeups: 2,
} as const;

/**
 * When memory is read, in milliseconds after the page opens. Slices 1 and 2
 * were measured at this moment. It is soon after load, while memory is still
 * near its highest: in a trace of slice 2's app, V8 ran its first idle
 * garbage collection about 30 s after launch. A later reading would come out
 * lower, so this one is the conservative choice.
 */
const MEMORY_READ_AT_MS = 13_000;

/**
 * When the visible idle sample starts, in milliseconds after the page opens.
 * In the first seconds after load, one-off timers still fire in the renderer,
 * some Chromium's and some the page's, such as a request's time limit. A
 * sample taken then counted them as idle wakeups, about 1 a second. By 30 s
 * they have fired, so the sample measures the app at rest.
 */
const VISIBLE_SAMPLE_AT_MS = 30_000;

/**
 * How long the window stays hidden before the hidden idle sample starts.
 * About 20 s after a window is hidden, Chromium starts purging its memory
 * allocator's caches in the renderer, about once a second for some 40 s. That
 * is Chromium's work, not the app's, and the sample ends before it starts.
 */
const HIDDEN_SETTLE_MS = 3_000;

/** How long an idle sample lasts. */
const SAMPLE_MS = 10_000;

/** One process of the app, as `app.getAppMetrics()` reported it at the end of a 10 s sample. */
interface ProcessUse {
  readonly pid: number;
  /** The process type, with the service it runs when it has one, such as `Utility (Network Service)`. */
  readonly label: string;
  readonly type: string;
  /** The average CPU use over the sample, where 100 is one core. */
  readonly cpuPercent: number;
  readonly wakeupsPerSecond: number;
}

/**
 * Reads the CPU and wakeups of every process of the app from
 * `app.getAppMetrics()`, called in main through its inspector at
 * `inspectorUrl`.
 *
 * Both are averages since the previous call, so a sample is two calls: one to
 * start the period, and one at its end.
 */
async function readProcessUse(inspectorUrl: string): Promise<ProcessUse[]> {
  const metrics = (await evaluateInMain(
    inspectorUrl,
    `require("electron").app.getAppMetrics()`,
  )) as ProcessMetric[];
  return metrics.map((metric) => ({
    pid: metric.pid,
    label: metric.name === undefined ? metric.type : `${metric.type} (${metric.name})`,
    type: metric.type,
    cpuPercent: metric.cpu.percentCPUUsage,
    wakeupsPerSecond: metric.cpu.idleWakeupsPerSecond,
  }));
}

/** Returns each process's use over the next 10 s, read through main's inspector at `inspectorUrl`. */
async function sampleIdleUse(inspectorUrl: string): Promise<ProcessUse[]> {
  await readProcessUse(inspectorUrl);
  await sleep(SAMPLE_MS);
  return readProcessUse(inspectorUrl);
}

/** One process of the app, with its memory as read from outside the app. */
interface ProcessMemory {
  readonly pid: number;
  /**
   * The process type, as `app.getAppMetrics()` names it: `Browser` for the
   * app's own process, and `GPU`, `Tab` or `Utility` for a helper. A utility
   * process has its service after it, such as `Utility (Network Service)`.
   */
  readonly label: string;
  /** The resident size, as `ps` reports it. */
  readonly workingSetMb: number;
  /** The physical footprint, as `footprint` reports it and Activity Monitor shows it. */
  readonly footprintMb: number;
}

/** The process types of Chromium's `--type` switch, by the name `app.getAppMetrics()` gives them. */
const PROCESS_TYPES: Readonly<Record<string, string>> = {
  "gpu-process": "GPU",
  renderer: "Tab",
  utility: "Utility",
};

/**
 * The names `app.getAppMetrics()` gives the services of Chromium's
 * `--utility-sub-type` switch, so a process has one label in both tables.
 * A service missing here keeps its switch value.
 */
const SERVICE_NAMES: Readonly<Record<string, string>> = {
  "network.mojom.NetworkService": "Network Service",
};

const runFile = promisify(execFile);

/**
 * Reads the memory of the app's process `pid` and of each of its children
 * with `ps` and `footprint`. Fails when either command fails.
 *
 * A helper's type comes from the `--type` switch on its command line. The
 * app's own process has none.
 */
async function readProcessMemory(pid: number): Promise<ProcessMemory[]> {
  const { stdout } = await runFile("ps", ["-A", "-o", "pid=,ppid=,rss=,command="]);
  const found = stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) return [];
    const [, ownPid, parentPid, rssKb, command] = match;
    if (Number(ownPid) !== pid && Number(parentPid) !== pid) return [];
    const type = /--type=(\S+)/.exec(command!)?.[1];
    const service = /--utility-sub-type=(\S+)/.exec(command!)?.[1];
    const name = type === undefined ? "Browser" : (PROCESS_TYPES[type] ?? type);
    return [
      {
        pid: Number(ownPid),
        label: service === undefined ? name : `${name} (${SERVICE_NAMES[service] ?? service})`,
        workingSetMb: Number(rssKb) / 1024,
      },
    ];
  });

  // `footprint` writes JSON only to a file, not to its standard output.
  const folder = mkdtempSync(join(tmpdir(), "hercule-desktop-perf-footprint-"));
  try {
    const file = join(folder, "footprint.json");
    await runFile("footprint", [
      "--noCategories",
      "--json",
      file,
      ...found.flatMap((sample) => ["--pid", String(sample.pid)]),
    ]);
    const report = JSON.parse(readFileSync(file, "utf8")) as {
      processes: { pid: number; auxiliary: { phys_footprint: number } }[];
    };
    return found.map((sample) => {
      const bytes = report.processes.find((entry) => entry.pid === sample.pid)?.auxiliary
        .phys_footprint;
      if (bytes === undefined) throw new Error(`footprint did not report process ${sample.pid}`);
      return { ...sample, footprintMb: bytes / 1024 / 1024 };
    });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
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
 * Starts the signed-in app on `userDataDir`, waits for the shell, and quits.
 *
 * The measured launch must not be the app's second. On the second launch
 * Chromium writes the renderer's compiled scripts to its code cache (the
 * `Code Cache` folder grew from 24 kB to 628 kB, then stayed there), and on
 * that launch the renderer's working set read about 7 MB higher than on every
 * later one: 103 MB against 96 MB. A user's everyday launch is a later one.
 */
async function warmUpApp(userDataDir: string): Promise<void> {
  const app = await launchTestPackage(userDataDir);
  try {
    await (await app.firstWindow()).getByRole("main").waitFor();
  } finally {
    await quitApp(app);
  }
}

/** How long a launch took, in milliseconds from spawn. */
interface LaunchTimes {
  /** Until main showed the window. */
  readonly windowShownMs: number;
  /** Until the page first painted. */
  readonly firstPaintMs: number;
  /** Until the frame that drew the page's first screen, fonts included, was presented. */
  readonly firstScreenMs: number;
}

/** What one plain launch of the app measured. */
interface PlainLaunch {
  readonly launch: LaunchTimes;
  /** Each process's memory, 13 s after the page opened. */
  readonly memory: ProcessMemory[];
  /** Each process's use over 10 s with the window visible, from 30 s after the page opened. */
  readonly visible: ProcessUse[];
  /** Each process's use over 10 s with the window hidden, from 3 s after it was hidden. */
  readonly hidden: ProcessUse[];
}

/**
 * Starts the test package signed in, as a plain process, and measures it:
 *
 * - the memory of each of its processes (see `readProcessMemory`);
 * - each process's CPU and wakeups with the window visible, then hidden
 *   (see `sampleIdleUse`);
 * - last, how long it took to show its window and to paint its first
 *   screen, the measures that need a connection to main and to the page.
 *
 * Fails when the app does not open its page within 10 s, when the window is
 * not visible while it is sampled, when main showed the window without its
 * first screen, when the first screen is not the shell, or when the app does
 * not quit cleanly afterwards.
 */
async function measurePlainLaunch(userDataDir: string): Promise<PlainLaunch> {
  const spawnedAt = Date.now();
  const child = spawn(
    findExecutable("test"),
    [
      ...buildAppArgs(userDataDir),
      MOCK_KEYCHAIN_SWITCH,
      "--inspect=0",
      "--remote-debugging-port=0",
    ],
    { env: buildAppEnv(), stdio: ["ignore", "pipe", "pipe"] },
  );
  // Main logs to both streams. Both are kept whole, to be checked for the
  // error main logs when it shows the window without its first screen, and
  // reading them to the end keeps a full pipe from blocking the app.
  let mainOutput = "";
  const appendMainOutput = (chunk: string) => (mainOutput += chunk);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", appendMainOutput);
  child.stderr.on("data", appendMainOutput);
  let measured: PlainLaunch;
  try {
    // The app prints both addresses on stderr: main's Node inspector as
    // `Debugger listening on ws://127.0.0.1:<port>/<id>`, and Chromium's
    // DevTools endpoint as
    // `DevTools listening on ws://127.0.0.1:<port>/devtools/browser/<id>`.
    const { inspectorUrl, endpoint } = await new Promise<{
      inspectorUrl: string;
      endpoint: string;
    }>((resolve, reject) => {
      let output: string | null = "";
      child.stderr.on("data", (chunk: string) => {
        if (output === null) return;
        output += chunk;
        const inspector = /Debugger listening on (ws:\/\/\S+)/.exec(output);
        const devTools = /DevTools listening on (ws:\/\/\S+)/.exec(output);
        if (inspector === null || devTools === null) return;
        output = null;
        resolve({ inspectorUrl: inspector[1]!, endpoint: devTools[1]! });
      });
      child.once("exit", () =>
        reject(new Error("the app exited before it opened its inspector and DevTools endpoint")),
      );
    });
    const { port } = new URL(endpoint);
    await waitForPageTarget(port);
    const pageOpenedAt = Date.now();

    await sleep(MEMORY_READ_AT_MS);
    const memory = await readProcessMemory(child.pid!);

    await sleep(Math.max(0, pageOpenedAt + VISIBLE_SAMPLE_AT_MS - Date.now()));
    const visible = await sampleIdleUse(inspectorUrl);
    const shown = await evaluateInMain(
      inspectorUrl,
      `require("electron").BrowserWindow.getAllWindows()[0]?.isVisible()`,
    );
    if (shown !== true) throw new Error("the window was not visible while sampled");
    await evaluateInMain(
      inspectorUrl,
      `require("electron").BrowserWindow.getAllWindows()[0]?.hide()`,
    );
    await sleep(HIDDEN_SETTLE_MS);
    const hidden = await sampleIdleUse(inspectorUrl);

    const windowShownAt = await evaluateInMain(
      inspectorUrl,
      `performance.timeOrigin + performance.getEntriesByName("window-shown")[0]?.startTime`,
    );
    if (typeof windowShownAt !== "number" || Number.isNaN(windowShownAt)) {
      throw new Error("main has no window-shown mark, so it never showed the window");
    }
    if (mainOutput.includes(SHOWN_WITHOUT_FIRST_SCREEN_ERROR)) {
      throw new Error(
        `main showed the window without its first screen, so the launch time is not the first screen's. Main's output:\n${mainOutput}`,
      );
    }

    const browser = await chromium.connectOverCDP(endpoint);
    try {
      const page = browser.contexts()[0]?.pages()[0];
      if (page === undefined) throw new Error("the app's page is not among the DevTools targets");
      await page.waitForFunction(
        () =>
          performance.getEntriesByName("first-paint").length > 0 &&
          performance.getEntriesByName("first-screen").length > 0,
        undefined,
        // Polling on a timer rather than on animation frames, because a
        // window that is not shown draws no animation frames.
        { polling: 100, timeout: 10_000 },
      );
      const painted = await page.evaluate(() => {
        const readEntry = (name: string): number =>
          performance.timeOrigin + performance.getEntriesByName(name)[0]!.startTime;
        return { firstPaint: readEntry("first-paint"), firstScreen: readEntry("first-screen") };
      });
      // Only the shell has a <main>; the connect and sign-in screens do not.
      if ((await page.getByRole("main").count()) === 0) {
        throw new Error("the app did not open on the shell, so it was not signed in");
      }
      measured = {
        launch: {
          windowShownMs: windowShownAt - spawnedAt,
          firstPaintMs: painted.firstPaint - spawnedAt,
          firstScreenMs: painted.firstScreen - spawnedAt,
        },
        memory,
        visible,
        hidden,
      };
    } finally {
      await browser.close();
    }
  } finally {
    await stopApp(child.pid!);
  }
  // The process has ended, so its exit code is known. Anything but 0, such as
  // a crash while quitting, fails the run: nothing else would notice it.
  if (child.exitCode !== 0) {
    const ending = child.signalCode ?? `code ${String(child.exitCode)}`;
    throw new Error(`the app did not quit cleanly: its process ended with ${ending}`);
  }
  return measured;
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

/** Formats a process's CPU and wakeups as table cells, or dashes when it was not running. */
function formatUse(sample: ProcessUse | undefined): string[] {
  if (sample === undefined) return ["-", "-"];
  return [sample.cpuPercent.toFixed(1), sample.wakeupsPerSecond.toFixed(1)];
}

const { launch, memory, visible, hidden } = await runWithScratchController((controllerUrl) =>
  runInScratchUserDataDir(async (userDataDir) => {
    writeSettings(userDataDir, { controllerUrl });
    await signInOnce(userDataDir);
    await warmUpApp(userDataDir);
    return measurePlainLaunch(userDataDir);
  }),
);

const memoryRows = memory.map((sample) => [
  sample.label,
  String(sample.pid),
  sample.workingSetMb.toFixed(1),
  sample.footprintMb.toFixed(1),
]);
const summedMb = memory.reduce((sum, sample) => sum + sample.workingSetMb, 0);
const summedFootprintMb = memory.reduce((sum, sample) => sum + sample.footprintMb, 0);
memoryRows.push(["Sum", "", summedMb.toFixed(1), summedFootprintMb.toFixed(1)]);
const renderer = memory.find((sample) => sample.label === "Tab");
const rendererMb = renderer?.workingSetMb ?? 0;
const rendererFootprintMb = renderer?.footprintMb ?? 0;

// A process that started or exited between the two samples is in one of
// them only, so the table lists every process either sample saw.
const seen = [...new Map([...visible, ...hidden].map((sample) => [sample.pid, sample.label]))];
const useRows = seen.map(([pid, label]) => [
  label,
  String(pid),
  ...formatUse(visible.find((sample) => sample.pid === pid)),
  ...formatUse(hidden.find((sample) => sample.pid === pid)),
]);

/** Finds the process of one type in a sample of CPU and wakeups, such as `Tab` for the renderer. */
const findProcessUse = (samples: readonly ProcessUse[], type: string) =>
  samples.find((sample) => sample.type === type);
const gpuWakeups = findProcessUse(visible, "GPU")?.wakeupsPerSecond ?? 0;
const rendererWakeupsVisible = findProcessUse(visible, "Tab")?.wakeupsPerSecond ?? 0;
const rendererWakeupsHidden = findProcessUse(hidden, "Tab")?.wakeupsPerSecond ?? 0;
const rendererLimit = `no wakeups from the app (at most ${BUDGET.rendererWakeups}/s)`;

// Budget, limit, measured, and whether the measurement is within the limit,
// or null for a measure that is recorded but has no budget.
const budgets: [string, string, string, boolean | null][] = [
  [
    "Launch, spawn to window shown",
    `shown within ${BUDGET.launchMs} ms of spawn (warm, signed in)`,
    `${launch.windowShownMs.toFixed(0)} ms`,
    launch.windowShownMs <= BUDGET.launchMs,
  ],
  ["Launch, first paint", "recorded; not budgeted", `${launch.firstPaintMs.toFixed(0)} ms`, null],
  [
    "Launch, first screen",
    "recorded; no budget until slice 5",
    `${launch.firstScreenMs.toFixed(0)} ms (the shell)`,
    null,
  ],
  [
    "Processes",
    `${BUDGET.processes}: browser, GPU, network utility, renderer`,
    `${memory.length}: ${memory.map((sample) => sample.label).join(", ")}`,
    memory.length <= BUDGET.processes,
  ],
  [
    "Footprint, summed",
    `at most ${BUDGET.summedFootprintMb} MB`,
    `${summedFootprintMb.toFixed(0)} MB`,
    summedFootprintMb <= BUDGET.summedFootprintMb,
  ],
  [
    "Footprint, renderer",
    `at most ${BUDGET.rendererFootprintMb} MB`,
    `${rendererFootprintMb.toFixed(0)} MB`,
    rendererFootprintMb <= BUDGET.rendererFootprintMb,
  ],
  ["Working set, summed", "recorded; not budgeted", `${summedMb.toFixed(0)} MB`, null],
  ["Working set, renderer", "recorded; not budgeted", `${rendererMb.toFixed(0)} MB`, null],
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

console.log("Memory, 13 s after the page opened:");
console.log(formatTable(["Process", "PID", "Working set MB", "Footprint MB"], memoryRows));
console.log();
console.log(
  "CPU and wakeups over 10 s: visible from 30 s after the page opened, hidden from 3 s after hiding:",
);
const useHeader = ["CPU %", "Wakeups/s"];
console.log(
  formatTable(
    [
      "Process",
      "PID",
      ...useHeader.map((cell) => `${cell}, visible`),
      ...useHeader.map((cell) => `${cell}, hidden`),
    ],
    useRows,
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
      within === null ? "-" : within ? "yes" : "NO",
    ]),
  ),
);
console.log();
console.log(`Load average over the last minute: ${loadavg()[0]!.toFixed(2)}`);
if (budgets.some(([, , , within]) => within === false)) process.exitCode = 1;
