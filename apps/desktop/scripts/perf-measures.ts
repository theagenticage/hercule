/**
 * The measurements the desktop perf script takes of a running app, shared by
 * `perf.ts` and the scenarios it runs (see `perf-subagents.ts`): the budgets
 * one launch can check, the moments a launch is read at, each process's
 * memory, CPU and wakeups, and the page's DevTools connection.
 *
 * It runs on plain Node, like the perf script, so its imports name the `.ts`
 * file.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { ProcessMetric } from "electron";
import {
  connectInspector,
  evaluateInMain,
  launchTestPackage,
  quitApp,
  readSettings,
} from "./packaged-app.ts";
import { pollUntil } from "./poll.ts";

/** The limits of spec 17's budget table that one launch of the app can check. */
export const BUDGET = {
  launchMs: 500,
  processes: 4,
  summedFootprintMb: 220,
  rendererFootprintMb: 100,
  gpuWakeupsVisible: 12,
  // The budget is "no wakeups from the app". Chromium wakes an idle renderer
  // on its own, 0 to 2 times a second in the baseline, so that is the most a
  // renderer doing nothing for the app can show.
  rendererWakeups: 2,
  // One frame at 60 Hz (spec 17 §Budgets). The thread list reads every
  // thread again on each `session` nudge; past this limit it moves to
  // updating only the threads the nudge names.
  rendererMainThreadPerNudgeMs: 16,
  transcriptPaintMs: 800,
  streamingTaskMs: 50,
} as const;

/**
 * When memory is read, in milliseconds after the page opens. Every earlier
 * reading of the app's memory was taken at this moment too, so the readings
 * compare. It is soon after load, while memory is still near its highest: in
 * a trace of an earlier version of the app, V8 ran its first idle garbage
 * collection about 30 s after launch. A later reading would come out lower,
 * so this one is the conservative choice.
 */
export const MEMORY_READ_AT_MS = 13_000;

/**
 * When the visible idle sample starts, in milliseconds after the page opens.
 * In the first seconds after load, one-off timers still fire in the renderer,
 * some Chromium's and some the page's, such as a request's time limit. A
 * sample taken then counted them as idle wakeups, about 1 a second. By 30 s
 * they have fired, so the sample measures the app at rest.
 */
export const VISIBLE_SAMPLE_AT_MS = 30_000;

/**
 * How long the window stays hidden before the hidden idle sample starts.
 * About 20 s after a window is hidden, Chromium starts purging its memory
 * allocator's caches in the renderer, about once a second for some 40 s. That
 * is Chromium's work, not the app's, and the sample ends before it starts.
 */
export const HIDDEN_SETTLE_MS = 3_000;

/** How long an idle sample lasts. */
export const SAMPLE_MS = 10_000;

/** One process of the app, as `app.getAppMetrics()` reported it at the end of a 10 s sample. */
export interface ProcessUse {
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
export async function readProcessUse(inspectorUrl: string): Promise<ProcessUse[]> {
  const metrics = (await evaluateInMain(
    inspectorUrl,
    `require("electron").app.getAppMetrics()`,
  )) as ProcessMetric[];
  return metrics.map((metric) => ({
    pid: metric.pid,
    label: metric.name === undefined ? metric.type : `${metric.type} (${metric.name})`,
    type: metric.type,
    // Electron divides a process's CPU use by the number of cores, so its 100
    // is every core busy. Multiplying by the number of cores gives % of one
    // core, the unit the budgets use.
    cpuPercent: metric.cpu.percentCPUUsage * cpus().length,
    wakeupsPerSecond: metric.cpu.idleWakeupsPerSecond,
  }));
}

/** Returns each process's use over the next 10 s, read through main's inspector at `inspectorUrl`. */
export async function sampleIdleUse(inspectorUrl: string): Promise<ProcessUse[]> {
  await readProcessUse(inspectorUrl);
  await sleep(SAMPLE_MS);
  return readProcessUse(inspectorUrl);
}

/** One process of the app, with its memory as read from outside the app. */
export interface ProcessMemory {
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
export const PROCESS_TYPES: Readonly<Record<string, string>> = {
  "gpu-process": "GPU",
  renderer: "Tab",
  utility: "Utility",
};

/**
 * The names `app.getAppMetrics()` gives the services of Chromium's
 * `--utility-sub-type` switch, so a process has one label in both tables.
 * A service missing here keeps its switch value.
 */
export const SERVICE_NAMES: Readonly<Record<string, string>> = {
  "network.mojom.NetworkService": "Network Service",
};

/** Runs a command and returns its output; fails when the command exits with an error. */
export const runFile = promisify(execFile);

/**
 * Reads the memory of the app's process `pid` and of each of its children
 * with `ps` and `footprint`. Fails when either command fails.
 *
 * A helper's type comes from the `--type` switch on its command line. The
 * app's own process has none.
 */
export async function readProcessMemory(pid: number): Promise<ProcessMemory[]> {
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
 * Starts the signed-in app on `userDataDir`, waits for the shell, quits, and
 * returns 3 s after the app has quit. Call it right before a measured launch,
 * so that the measured launch is warm, as the budget sets. It warms two
 * caches:
 *
 * - Chromium's code cache. The measured launch must not be the app's second.
 *   On the second launch Chromium writes the renderer's compiled scripts to
 *   its code cache (the `Code Cache` folder grew from 24 kB to 628 kB, then
 *   stayed there), and on that launch the renderer's working set read about
 *   7 MB higher than on every later one: 103 MB against 96 MB. A user's
 *   everyday launch is a later one.
 * - macOS's file cache. On the reference machine, with most of its memory in
 *   use, macOS dropped the app's files from memory 14 to 17 s after the app
 *   quit. A launch after that reads about 70 MB of the Electron framework
 *   back from disk: main took about 4,500 page faults that read from disk,
 *   against about 200 warm, and the window showed 606 to 698 ms after spawn,
 *   against 313 to 350 ms warm, in 12 launches. That is a cold launch. The
 *   fixture's work before a launch can take longer than 14 s, so the warm-up
 *   comes after it.
 *
 * The 3 s let the quit app's other processes exit, so that the measured
 * launch does not overlap them, and stay well short of the 14 s.
 */
export async function warmUpApp(userDataDir: string): Promise<void> {
  const app = await launchTestPackage(userDataDir);
  try {
    await (await app.firstWindow()).getByRole("main").waitFor();
  } finally {
    await quitApp(app);
  }
  await sleep(3_000);
}

/**
 * Opens the thread `sessionId` in the signed-in app on `userDataDir`, waits
 * for its transcript, and quits. The app then opens that thread again at its
 * next launch, as it does for a user who quit with the thread open. Fails
 * when the thread's transcript does not show.
 *
 * The thread is stored as the last screen, and the app started again, rather
 * than opened from the sidebar: a project's section shows only its newest
 * threads, and its list mounts only the rows in view, so the thread's row
 * may not be there to click.
 */
export async function openThreadOnce(userDataDir: string, sessionId: string): Promise<void> {
  const { controllerUrl } = readSettings(userDataDir) as { readonly controllerUrl: string };
  const first = await launchTestPackage(userDataDir);
  try {
    const page = await first.firstWindow();
    // The app stores the screen it settles on, so the thread is stored only
    // once the first screen is up.
    await page.getByRole("navigation", { name: "Threads", exact: true }).waitFor();
    await page.evaluate(
      ([key, path]) => {
        localStorage.setItem(key, path);
      },
      [`last-screen:${controllerUrl}`, `/threads/${sessionId}`] as const,
    );
  } finally {
    await quitApp(first);
  }
  const second = await launchTestPackage(userDataDir);
  try {
    const page = await second.firstWindow();
    await page.getByRole("region", { name: "Transcript" }).waitFor();
  } finally {
    await quitApp(second);
  }
}

/**
 * Waits until Chromium's DevTools endpoint `endpoint` lists the app's page,
 * and returns the WebSocket URL that connects to that page. Fails after 10 s.
 *
 * It asks the endpoint's HTTP list of targets, which attaches to nothing, so
 * asking does not slow the page down. The URL stays the same while the page
 * navigates, so one lookup serves the whole launch.
 */
export async function waitForPageSocketUrl(endpoint: string): Promise<string> {
  const { port } = new URL(endpoint);
  return pollUntil(
    async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = (await response.json()) as {
        type: string;
        url: string;
        webSocketDebuggerUrl: string;
      }[];
      return targets.find(
        (target) => target.type === "page" && target.url.startsWith("app://hercule/"),
      )?.webSocketDebuggerUrl;
    },
    {
      timeoutMs: 10_000,
      intervalMs: 20,
      timeoutMessage: "the app did not open app://hercule/ within 10 s",
    },
  );
}

/**
 * Evaluates `expression` in the app's page, over the DevTools connection at
 * `pageSocketUrl`, and returns the value it evaluates to. The connection
 * lasts only for the call. Fails when the expression throws.
 */
export async function evaluateInPage(pageSocketUrl: string, expression: string): Promise<unknown> {
  // The page speaks the same protocol as main's inspector, so the same
  // connection serves both.
  const page = await connectInspector(pageSocketUrl);
  try {
    return await page.evaluate("Runtime.evaluate", { expression, returnByValue: true });
  } finally {
    page.close();
  }
}

/** Finds the process of one type in a sample of CPU and wakeups, such as `Tab` for the renderer. */
export const findProcessUse = (samples: readonly ProcessUse[], type: string) =>
  samples.find((sample) => sample.type === type);
