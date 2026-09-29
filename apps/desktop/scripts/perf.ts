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
 *    - the launch times: how long from spawn until the window was ready to
 *      show, and until the first screen was on it.
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
 * - The working set, which the budget limits: the resident size `ps`
 *   reports. It is the same number `app.getAppMetrics()` reports as the
 *   working set on macOS, so the budget's unit is unchanged.
 * - The physical footprint, which `footprint` reports and Activity Monitor
 *   shows as a process's memory. It is printed for information only.
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
 * the app with `--remote-debugging-port=0`, and connects to the page over the
 * Chrome DevTools Protocol only after the idle samples. From the page it
 * reads two performance entries, in milliseconds since the epoch like the
 * time noted at spawn:
 *
 * - `first-paint`, for the window showing. Main keeps no record of when
 *   `ready-to-show` fired. Electron emits `ready-to-show` when the page first
 *   paints: on a copy of main that logged the event, the `first-paint` entry
 *   came 4 to 18 ms after it, so the time printed here is high by about that
 *   much.
 * - `first-screen`, the mark the page sets in the animation frame after its
 *   first screen is on the page. The script checks that the screen is the
 *   shell, so the time is a signed-in launch's and not the connect screen's.
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
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { ProcessMetric } from "electron";
import { chromium } from "playwright";
// The extensions are spelled out because Node runs this script as it is, and
// Node resolves no import without one.
import {
  completeSetup,
  PASSWORD,
  ROOT,
  startController,
  USERNAME,
} from "../../../scripts/controller-process.ts";
import {
  buildAppArgs,
  buildAppEnv,
  findExecutable,
  launchTestPackage,
  MOCK_KEYCHAIN_SWITCH,
  quitApp,
  readSettings,
  signIn,
  writeControllerUrl,
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

/** The inspector's reply to a `Runtime.evaluate` request, as far as the script reads it. */
interface EvaluateReply {
  readonly id: number;
  readonly result: {
    readonly result: { readonly value?: unknown };
    readonly exceptionDetails?: { readonly text: string };
  };
}

/**
 * Evaluates `expression` in the app's main process, through the Node
 * inspector at `inspectorUrl`, and returns the value it evaluates to. Fails
 * when the expression throws.
 *
 * The connection lasts only for the call, so nothing stays attached to the
 * app in between. `require` is not a global in main; the inspector's command
 * line API supplies it to the expression.
 */
async function evaluateInMain(inspectorUrl: string, expression: string): Promise<unknown> {
  const socket = new WebSocket(inspectorUrl);
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error(`could not connect to main's inspector at ${inspectorUrl}`)),
        { once: true },
      );
    });
    const reply = new Promise<EvaluateReply>((resolve) => {
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as EvaluateReply;
        if (message.id === 1) resolve(message);
      });
    });
    socket.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, includeCommandLineAPI: true, returnByValue: true },
      }),
    );
    const { result } = await reply;
    if (result.exceptionDetails !== undefined) {
      throw new Error(`main could not evaluate ${expression}: ${result.exceptionDetails.text}`);
    }
    return result.result.value;
  } finally {
    socket.close();
  }
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
 * Starts a controller from the compiled binary in a scratch Hercule Home,
 * never the user's own, and completes its setup. Runs `use` with the
 * controller's URL, then stops the controller and deletes the home. Fails
 * when the binary has not been built, or setup fails.
 */
async function runWithScratchController<T>(use: (url: string) => Promise<T>): Promise<T> {
  const binary = join(ROOT, "hercule");
  if (!existsSync(binary)) {
    throw new Error(`no compiled controller at ${binary}: run \`pnpm build:binary\` first.`);
  }
  const home = mkdtempSync(join(tmpdir(), "hercule-desktop-perf-home-"));
  try {
    const controller = await startController({ home, binary });
    try {
      const ran = await completeSetup({ home, url: controller.url, binary });
      if (ran.code !== 0) {
        throw new Error(`setup failed with code ${String(ran.code)}:\n${ran.stderr}`);
      }
      return await use(controller.url);
    } finally {
      await controller.stop();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * Waits until main has saved a token in the settings file in `userDataDir`.
 * The page saves the token without waiting for main, so it can land just
 * after the shell shows. Fails after 5 s.
 */
async function waitForSavedToken(userDataDir: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (typeof readSettings(userDataDir)["token"] === "string") return;
    await sleep(50);
  }
  throw new Error("main did not save the token within 5 s of signing in");
}

/**
 * Starts the app on `userDataDir`, which already holds a saved controller,
 * signs in on the sign-in screen, waits for the shell and the saved token,
 * and quits.
 */
async function signInOnce(userDataDir: string): Promise<void> {
  const app = await launchTestPackage(userDataDir);
  try {
    const page = await app.firstWindow();
    await signIn(page, { username: USERNAME, password: PASSWORD });
    await page.getByRole("main").waitFor();
    await waitForSavedToken(userDataDir);
  } finally {
    await quitApp(app);
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
  /** Until the page first painted: the window is ready to show. */
  readonly windowShowsMs: number;
  /** Until the page's first screen was on it. */
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
 * - last, how long it took to show its window and its first screen, which
 *   is the one measure that needs a connection to the page.
 *
 * Fails when the app does not open its page within 10 s, when the window is
 * not visible while it is sampled, when the first screen is not the shell,
 * or when the app does not quit cleanly afterwards.
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
    { env: buildAppEnv(), stdio: ["ignore", "ignore", "pipe"] },
  );
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
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        // The stream is read to its end all the same, so that a full pipe
        // never blocks the app.
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
      const measured = await page.evaluate(() => ({
        firstPaint:
          performance.timeOrigin + performance.getEntriesByName("first-paint")[0]!.startTime,
        firstScreen:
          performance.timeOrigin + performance.getEntriesByName("first-screen")[0]!.startTime,
      }));
      // Only the shell has a <main>; the connect and sign-in screens do not.
      if ((await page.getByRole("main").count()) === 0) {
        throw new Error("the app did not open on the shell, so it was not signed in");
      }
      return {
        launch: {
          windowShowsMs: measured.firstPaint - spawnedAt,
          firstScreenMs: measured.firstScreen - spawnedAt,
        },
        memory,
        visible,
        hidden,
      };
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

/** Formats a process's CPU and wakeups as table cells, or dashes when it was not running. */
function formatUse(sample: ProcessUse | undefined): string[] {
  if (sample === undefined) return ["-", "-"];
  return [sample.cpuPercent.toFixed(1), sample.wakeupsPerSecond.toFixed(1)];
}

const { launch, memory, visible, hidden } = await runWithScratchController((controllerUrl) =>
  runInScratchUserDataDir(async (userDataDir) => {
    writeControllerUrl(userDataDir, controllerUrl);
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
    "Launch, window shows",
    `ready to show within ${BUDGET.launchMs} ms of spawn (warm, signed in)`,
    `${launch.windowShowsMs.toFixed(0)} ms`,
    launch.windowShowsMs <= BUDGET.launchMs,
  ],
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
  ["Footprint, summed", "recorded; not budgeted", `${summedFootprintMb.toFixed(0)} MB`, null],
  ["Footprint, renderer", "recorded; not budgeted", `${rendererFootprintMb.toFixed(0)} MB`, null],
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
