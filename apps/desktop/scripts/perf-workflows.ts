/**
 * The desktop perf script's workflow list scenario: one plain launch of the
 * app on Workflows, with 50 workflows listed and 50 live runs across 10 of
 * them, which measures the rows of spec 17 §What Workflows costs that a
 * script can measure:
 *
 * - processes and memory with the list open;
 * - each process's CPU and wakeups with the list open, visible and hidden,
 *   and how often the age clock fired in each sample;
 * - opening the list: how many strip reads the launch made, and how long
 *   from spawn, and from the page's start, until the first read of every
 *   strip had answered, and until the last strip read answered, with the
 *   controller local;
 * - "From runs": how many reads of the live sessions that are not threads
 *   the launch made, against the thread list's reads. The launch reads every
 *   read on screen twice: once as the page loads, and again when the live
 *   connection's first pushes say every record may have changed;
 * - what one `run` push costs: how many reads it causes, by what they read
 *   (each workflow's strip, `run.query({ workflowId, limit })`; the live
 *   runs, one `run.query` for the `running` status and one for `pending`;
 *   any other run read; and any other read), how long after the push the
 *   last of those reads answered, and the renderer's main thread and CPU,
 *   and the controller's CPU, per push.
 *
 * The seed (see `seedWorkflows`):
 *
 * - 50 workflows, each with one start trigger: half on a schedule, half on
 *   `task.created` events. Neither fires during a run of the script: the
 *   schedule is 03:00 on 1 January, and the event trigger's filter accepts
 *   only a task titled "never", which nothing creates;
 * - 5 runs of each of the first 10 workflows, 50 in all. Their one step is
 *   the built-in `wait` action for a day, so every run stays `running` with
 *   no runner and no provider, until it is cancelled;
 * - one run of each of the other 40, whose step waits 1 s, the least the
 *   `wait` action allows, so the run has completed before the app launches.
 *   No seeded run fails, so the list's Failing group is empty.
 *
 * A push is one run cancelled through `run.cancel`, one live workflow after
 * another. Cancelling is one change to one run, where starting a run is two
 * (pending, then running). The 10 pushes take the live runs from 50 down to
 * 40, which changes no count of reads: each push reads every strip and the
 * live runs once, however many runs are live.
 *
 * Each strip holds at most 5 runs, not the 20 a strip shows at most, so each
 * strip's answer is smaller than a busy workflow's would be.
 *
 * The route's chunk and the first screen's bytes are not measured here:
 * `pnpm build:desktop`'s bundle check prints them. The remote controller's
 * opening time is not measured either: the script's controller is local.
 *
 * It runs on plain Node, like the perf script, so its imports name the `.ts`
 * file.
 */
import { loadavg } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "playwright";
import type {
  RunStarted,
  RunSummary,
  WorkflowDefinition,
  WorkflowSaveResult,
} from "../../../packages/contract/src/index";
import {
  assertExitedCleanly,
  connectInspector,
  evaluateInMain,
  formatTable,
  launchPlainApp,
  stopPlainApp,
} from "./packaged-app.ts";
import type { ThreadFixture } from "./perf-fixture.ts";
import {
  BUDGET,
  HIDDEN_SETTLE_MS,
  MEMORY_READ_AT_MS,
  VISIBLE_SAMPLE_AT_MS,
  evaluateInPage,
  findProcessUse,
  openScreenOnce,
  readCpuMs,
  readProcessMemory,
  sampleIdleUse,
  waitForPageSocketUrl,
  warmUpApp,
  type ProcessMemory,
  type ProcessUse,
} from "./perf-measures.ts";
import { pollUntil } from "./poll.ts";

/** A workflow's row in the list: a link to the workflow's page, inside the list's `nav`. */
const WORKFLOW_ROW_SELECTOR = 'nav[aria-label="Workflows"] a[href^="/workflows/"]';

/** How many workflows the seed creates, and how many of them have live runs. */
const WORKFLOW_COUNT = 50;
const LIVE_WORKFLOW_COUNT = 10;

/** How many live runs each live workflow has, and how many there are in all. */
const LIVE_RUNS_PER_WORKFLOW = 5;
const LIVE_RUNS = LIVE_WORKFLOW_COUNT * LIVE_RUNS_PER_WORKFLOW;

/** How many completed runs the seed leaves: one for each workflow without live runs. */
const COMPLETED_RUNS = WORKFLOW_COUNT - LIVE_WORKFLOW_COUNT;

/** How long a live run waits, in seconds: the longest the `wait` action allows, one day. */
const LIVE_WAIT_SECONDS = 86_400;

/** How long a run that completes waits, in seconds: the least the `wait` action allows. */
const COMPLETED_WAIT_SECONDS = 1;

/** How many runs are cancelled one at a time, and how far apart. */
const PUSH_COUNT = 10;
const PUSH_INTERVAL_MS = 1_000;

/** How long after the last push the reading ends, so the last reads are in it. */
const PUSH_SETTLE_MS = 2_000;

/**
 * When the launch's reads are read, in milliseconds after the page opens:
 * just before the visible sample, so the connection that reads them is
 * closed while the sample runs.
 */
const LAUNCH_READS_AT_MS = 28_000;

/** How long the window is shown again before the pushes start, so the page has read again. */
const SHOW_SETTLE_MS = 3_000;

/**
 * How many entries the page's resource timing buffer holds during the
 * pushes. Chromium keeps 250 by default and drops every entry after that,
 * which 10 pushes of some 50 reads each reach.
 */
const RESOURCE_BUFFER_SIZE = 10_000;

/** The path every run read goes to. */
const RUNS_PATH = "/api/v1/runs";

/** The path every session read goes to; "From runs" reads it with `thread=false`. */
const SESSIONS_PATH = "/api/v1/sessions";

/**
 * Builds the definition of the seeded workflow `number`, counting from 1,
 * whose one step waits `waitSeconds`. Odd workflows start on a schedule,
 * even ones on an event; neither fires while the script runs (see the top of
 * this file).
 */
function buildWorkflowDefinition(number: number, waitSeconds: number): WorkflowDefinition {
  const on =
    number % 2 === 1
      ? { schedule: "0 3 1 1 *" }
      : { kind: "task.created", filter: 'event.payload.task.title == "never"' };
  return {
    name: `Workflow ${String(number).padStart(2, "0")}`,
    triggers: [{ id: "start", kind: "start", on }],
    steps: [{ id: "hold", kind: "action", action: "wait", params: { seconds: waitSeconds } }],
  };
}

/** Lists every run of the scratch controller with the status `status`. */
const listRuns = async (
  fixture: ThreadFixture,
  status: RunSummary["status"],
): Promise<readonly RunSummary[]> =>
  (
    await fixture.call<{ readonly items: readonly RunSummary[] }>(
      "GET",
      `/runs?status=${status}&limit=500`,
    )
  ).items;

/**
 * Creates the 50 workflows and starts their runs: 5 live runs of each of the
 * first 10, and one run of each of the other 40 that completes within a
 * second. Returns the ids of the live runs, grouped by workflow, once all 50
 * are `running` and the other 40 have completed. Fails when the controller
 * refuses a workflow or a run, or when the runs have not settled within 30 s.
 *
 * The runs settle before the app launches, so no run's change reaches the
 * launch and adds reads to it.
 */
export async function seedWorkflows(fixture: ThreadFixture): Promise<string[][]> {
  const runIds: string[][] = [];
  for (let number = 1; number <= WORKFLOW_COUNT; number += 1) {
    const live = number <= LIVE_WORKFLOW_COUNT;
    const { workflow } = await fixture.call<WorkflowSaveResult>("POST", "/workflows", {
      definition: buildWorkflowDefinition(
        number,
        live ? LIVE_WAIT_SECONDS : COMPLETED_WAIT_SECONDS,
      ),
    });
    const ids: string[] = [];
    for (let run = 0; run < (live ? LIVE_RUNS_PER_WORKFLOW : 1); run += 1) {
      const { runId } = await fixture.call<RunStarted>("POST", "/runs/start", {
        workflowId: workflow.id,
      });
      ids.push(runId);
    }
    if (live) runIds.push(ids);
  }
  await pollUntil(
    async () =>
      (await listRuns(fixture, "running")).length === LIVE_RUNS &&
      (await listRuns(fixture, "pending")).length === 0 &&
      (await listRuns(fixture, "completed")).length === COMPLETED_RUNS
        ? true
        : undefined,
    {
      timeoutMs: 30_000,
      intervalMs: 200,
      timeoutMessage: `the seeded runs were not ${String(LIVE_RUNS)} running and ${String(COMPLETED_RUNS)} completed within 30 s`,
    },
  );
  return runIds;
}

/**
 * Opens Workflows once in the signed-in app on `userDataDir`, so the app
 * opens it again at its next launch (see `openScreenOnce`). Fails when the
 * list does not show a row.
 */
export const openWorkflowsOnce = (userDataDir: string): Promise<void> =>
  openScreenOnce(userDataDir, "/workflows", (page: Page) =>
    page.locator(WORKFLOW_ROW_SELECTOR).first().waitFor(),
  );

/** What a read is for, by its URL. */
type ReadKind = "strip" | "liveRuns" | "otherRuns" | "liveSessions" | "other";

/** The reads of the live runs in one round: the `running` runs and the `pending` ones. */
const LIVE_RUN_READS = 2;

/**
 * Returns what the read of `url` is for: a workflow's strip when it reads
 * runs of one workflow, the live runs when it reads running or pending
 * runs, any other run read, the live sessions that are not threads, which
 * "From runs" reads, or anything else.
 */
function classifyRead(url: URL): ReadKind {
  if (url.pathname === SESSIONS_PATH && url.searchParams.get("thread") === "false") {
    return "liveSessions";
  }
  if (url.pathname !== RUNS_PATH) return "other";
  if (url.searchParams.has("workflowId")) return "strip";
  const status = url.searchParams.get("status");
  if (status === "running" || status === "pending") return "liveRuns";
  return "otherRuns";
}

/** One read the page made, from its resource timing entry, in milliseconds since the epoch. */
interface Read {
  readonly url: string;
  readonly startedAt: number;
  readonly answeredAt: number;
}

/** An expression that evaluates, in the page, to every read in its resource timing buffer. */
const READ_READS = `performance.getEntriesByType("resource").map((entry) => ({
  url: entry.name,
  startedAt: performance.timeOrigin + entry.startTime,
  answeredAt: performance.timeOrigin + entry.responseEnd,
}))`;

/** Counts the reads in `reads` that are of the kind `kind`. */
const countReadsOfKind = (reads: readonly Read[], kind: ReadKind) =>
  reads.filter((read) => classifyRead(new URL(read.url)) === kind).length;

/** What opening the list at launch cost. */
interface OpeningCost {
  /** How many strip reads the launch made. */
  readonly stripReads: number;
  /** How many reads of the live sessions that are not threads the launch made. */
  readonly liveSessionReads: number;
  /**
   * How many reads of the thread list the launch made. The thread list is a
   * shell read on every screen, so it counts the rounds of shell reads the
   * launch made.
   */
  readonly threadListReads: number;
  /**
   * From spawn until the first 50 strip reads to start, one per workflow,
   * had all answered, in milliseconds.
   */
  readonly firstStripsFromSpawnMs: number;
  /** The same, from the page's start, its navigation. */
  readonly firstStripsFromPageStartMs: number;
  /** From the page's start until the last strip read answered, in milliseconds. */
  readonly lastStripFromPageStartMs: number;
}

/** What the run pushes cost, summed over all of them. */
interface PushCost {
  /** The controller process's CPU time, in milliseconds. */
  readonly controllerCpuMs: number;
  /** The renderer process's CPU time, all of its threads, in milliseconds. */
  readonly rendererCpuMs: number;
  /** The time the renderer's main thread spent running tasks, in milliseconds. */
  readonly rendererMainThreadMs: number;
  /** How many reads of each kind the page made. */
  readonly reads: Readonly<Record<ReadKind, number>>;
  /** Each read that is not a run read, by its path, with how many there were. */
  readonly otherPaths: ReadonlyMap<string, number>;
  /**
   * For each push, how long from the cancel's request until the last run
   * read that started after it answered, in milliseconds, or null when no
   * run read followed the push.
   */
  readonly settleMs: ReadonlyArray<number | null>;
}

/** What the workflow list scenario measured. */
export interface WorkflowWork {
  /** The machine's load average over the minute before the app was spawned. */
  readonly loadAtSpawn: number;
  /** Each process's memory, 13 s after the page opened. */
  readonly memory: readonly ProcessMemory[];
  /** Each process's use over 10 s with the window visible, from 30 s after the page opened. */
  readonly visible: readonly ProcessUse[];
  /** Each process's use over 10 s with the window hidden, from 3 s after it was hidden. */
  readonly hidden: readonly ProcessUse[];
  /** How often the age clock fired during the visible sample. */
  readonly firesVisible: number;
  /** How often the age clock fired from hiding the window to the end of the hidden sample. */
  readonly firesHidden: number;
  readonly opening: OpeningCost;
  readonly pushes: PushCost;
}

/**
 * Starts the signed-in app on `userDataDir` as a plain process, warm (see
 * `warmUpApp`), where it opens Workflows again on the seeded workflows, and
 * measures it. Returns, read in this order:
 *
 * - each process's memory, 13 s after the page opened (see
 *   `readProcessMemory`);
 * - the launch's reads, 28 s after the page opened: the strip reads and the
 *   reads of the live sessions that are not threads, and when the last strip
 *   read answered;
 * - each process's CPU and wakeups over 10 s with the window visible, from
 *   30 s after the page opened, and over 10 s with the window hidden, from
 *   3 s after hiding it (see `sampleIdleUse`), with the age clock's fires in
 *   each;
 * - with the window shown again, what 10 pushes cost: one live run of
 *   `runIds` cancelled every second, each from the next workflow, over the
 *   12 s from the first cancel to 2 s after the last. The controller's and
 *   the renderer's CPU time come from `ps`, and the renderer main thread's
 *   time from the page's DevTools performance metrics. Each also holds
 *   whatever the process did while idle in that time, so the numbers err
 *   high. The page's reads come from its resource timing entries, each
 *   counted to the push before it started. A push's settle time ends with
 *   the last run read that answered, so it holds the controller's work on
 *   the cancel, the push reaching the app, the 50 ms the app gathers pushes
 *   in, and the reads.
 *
 * Nothing stays attached to the page until the idle samples are over, as in
 * `perf.ts`; the pushes then share one connection. The window stays shown
 * during the pushes, because a hidden page drops the `run` topic.
 *
 * Fails when the list does not show with every strip read within 15 s, when
 * the window is not visible or hidden as each sample expects, or when the
 * app does not quit cleanly afterwards.
 */
export async function measureWorkflowWork(
  userDataDir: string,
  fixture: ThreadFixture,
  runIds: readonly (readonly string[])[],
): Promise<WorkflowWork> {
  await warmUpApp(userDataDir);
  const loadAtSpawn = loadavg()[0]!;
  const spawnedAt = Date.now();
  const app = await launchPlainApp(userDataDir);
  const { inspectorUrl } = app;
  let measured: WorkflowWork;
  try {
    const pageSocketUrl = await waitForPageSocketUrl(app.endpoint);
    const pageOpenedAt = Date.now();
    const sleepUntil = (msAfterOpen: number) =>
      sleep(Math.max(0, pageOpenedAt + msAfterOpen - Date.now()));
    const readReads = async () => (await evaluateInPage(pageSocketUrl, READ_READS)) as Read[];
    const callWindow = (method: "hide" | "showInactive" | "isVisible") =>
      evaluateInMain(
        inspectorUrl,
        `require("electron").BrowserWindow.getAllWindows()[0]?.${method}()`,
      );

    // The list is virtualized, so its rows cannot be counted; the strip
    // reads, one per workflow, show that every workflow is listed.
    await pollUntil(
      async () =>
        (await evaluateInPage(
          pageSocketUrl,
          `document.querySelector(${JSON.stringify(WORKFLOW_ROW_SELECTOR)}) !== null`,
        )) === true && countReadsOfKind(await readReads(), "strip") >= WORKFLOW_COUNT
          ? true
          : undefined,
      {
        timeoutMs: 15_000,
        intervalMs: 100,
        timeoutMessage: `the app did not open Workflows and read its ${String(WORKFLOW_COUNT)} strips`,
      },
    );

    await sleepUntil(MEMORY_READ_AT_MS);
    const memory = await readProcessMemory(app.process.pid!);
    const rendererPid = memory.find((sample) => sample.label === "Tab")?.pid;
    if (rendererPid === undefined) throw new Error("the app has no renderer process");

    await sleepUntil(LAUNCH_READS_AT_MS);
    const launchReads = await readReads();
    const pageStart = (await evaluateInPage(pageSocketUrl, "performance.timeOrigin")) as number;
    // The live connection opens after the launch's first reads, and the
    // controller answers each live topic's subscription with a push that
    // says every record may have changed. So the launch reads the strips,
    // and every other read on screen, a second time. The first read of each
    // workflow's strip is the one the list waits for.
    const strips = launchReads
      .filter((read) => classifyRead(new URL(read.url)) === "strip")
      .toSorted((a, b) => a.startedAt - b.startedAt);
    const findLastAnswer = (reads: readonly Read[]) =>
      Math.max(...reads.map((read) => read.answeredAt));
    const firstStripsAnsweredAt = findLastAnswer(strips.slice(0, WORKFLOW_COUNT));
    const opening: OpeningCost = {
      stripReads: strips.length,
      liveSessionReads: countReadsOfKind(launchReads, "liveSessions"),
      threadListReads: launchReads.filter((read) => {
        const url = new URL(read.url);
        return url.pathname === SESSIONS_PATH && url.searchParams.get("thread") === "true";
      }).length,
      firstStripsFromSpawnMs: firstStripsAnsweredAt - spawnedAt,
      firstStripsFromPageStartMs: firstStripsAnsweredAt - pageStart,
      lastStripFromPageStartMs: findLastAnswer(strips) - pageStart,
    };

    await sleepUntil(VISIBLE_SAMPLE_AT_MS);
    const visibleFrom = Date.now();
    const visible = await sampleIdleUse(inspectorUrl);
    const visibleTo = Date.now();
    if ((await callWindow("isVisible")) !== true) {
      throw new Error("the window was not visible while sampled");
    }
    await callWindow("hide");
    const hiddenFrom = Date.now();
    await sleep(HIDDEN_SETTLE_MS);
    const hidden = await sampleIdleUse(inspectorUrl);
    const hiddenTo = Date.now();
    if ((await callWindow("isVisible")) !== false) {
      throw new Error("the window was not hidden while sampled");
    }
    // `showInactive` leaves the focus where it is, so the run does not take
    // the keyboard from whoever is using the machine.
    await callWindow("showInactive");
    await sleep(SHOW_SETTLE_MS);

    const page = await connectInspector(pageSocketUrl);
    try {
      const evaluate = (expression: string) =>
        page.evaluate("Runtime.evaluate", { expression, returnByValue: true });
      const fires = (await evaluate(
        `performance.getEntriesByName("age-clock-fire").map((entry) => performance.timeOrigin + entry.startTime)`,
      )) as number[];
      const countFires = (from: number, to: number) =>
        fires.filter((at) => at >= from && at < to).length;

      const controllerPid = fixture.readControllerPid();
      await page.send("Performance.enable");
      const readMainThreadMs = async () => {
        const { metrics } = (await page.send("Performance.getMetrics")) as {
          metrics: { name: string; value: number }[];
        };
        const seconds = metrics.find((metric) => metric.name === "TaskDuration")?.value;
        if (seconds === undefined) throw new Error("the page reports no TaskDuration metric");
        return seconds * 1_000;
      };

      // Showing the window again read every list again, so the buffer is
      // cleared only after that, and those reads are not counted as the
      // first push's.
      await evaluate(`performance.setResourceTimingBufferSize(${String(RESOURCE_BUFFER_SIZE)});
        performance.clearResourceTimings();`);
      const before = {
        controller: await readCpuMs(controllerPid),
        renderer: await readCpuMs(rendererPid),
        mainThread: await readMainThreadMs(),
      };
      const pushedAt: number[] = [];
      for (let push = 0; push < PUSH_COUNT; push += 1) {
        const workflowRuns = runIds[push % runIds.length]!;
        const runId = workflowRuns[Math.floor(push / runIds.length)]!;
        pushedAt.push(Date.now());
        await fixture.call("POST", `/runs/${runId}/cancel`, {});
        await sleep(Math.max(0, pushedAt.at(-1)! + PUSH_INTERVAL_MS - Date.now()));
      }
      await sleep(PUSH_SETTLE_MS);
      const after = {
        controller: await readCpuMs(controllerPid),
        renderer: await readCpuMs(rendererPid),
        mainThread: await readMainThreadMs(),
      };
      const reads = (await evaluate(READ_READS)) as Read[];
      measured = {
        loadAtSpawn,
        memory,
        visible,
        hidden,
        firesVisible: countFires(visibleFrom, visibleTo),
        firesHidden: countFires(hiddenFrom, hiddenTo),
        opening,
        pushes: {
          controllerCpuMs: after.controller - before.controller,
          rendererCpuMs: after.renderer - before.renderer,
          rendererMainThreadMs: after.mainThread - before.mainThread,
          ...countPushReads(reads, pushedAt),
        },
      };
    } finally {
      page.close();
    }
  } finally {
    await stopPlainApp(app);
  }
  assertExitedCleanly(app.process);
  return measured;
}

/**
 * Counts `reads` by kind, and the other reads by path, leaving out the reads
 * that started before the first push in `pushedAt`. Returns the counts and,
 * for each push, its settle time: from the push until the last run read that
 * started after it, and before the next push, answered.
 */
function countPushReads(
  reads: readonly Read[],
  pushedAt: readonly number[],
): Pick<PushCost, "reads" | "otherPaths" | "settleMs"> {
  const counts: Record<ReadKind, number> = {
    strip: 0,
    liveRuns: 0,
    otherRuns: 0,
    liveSessions: 0,
    other: 0,
  };
  const otherPaths = new Map<string, number>();
  const lastAnswer: (number | null)[] = pushedAt.map(() => null);
  for (const read of reads) {
    const push = pushedAt.findLastIndex((at) => at <= read.startedAt);
    if (push === -1) continue;
    const url = new URL(read.url);
    const kind = classifyRead(url);
    counts[kind] += 1;
    if (kind === "other" || kind === "liveSessions") {
      otherPaths.set(url.pathname, (otherPaths.get(url.pathname) ?? 0) + 1);
    } else {
      lastAnswer[push] = Math.max(lastAnswer[push] ?? 0, read.answeredAt);
    }
  }
  return {
    reads: counts,
    otherPaths,
    settleMs: lastAnswer.map((at, push) => (at === null ? null : at - pushedAt[push]!)),
  };
}

/** Formats a count of reads as the count for one push, with the total after it. */
const formatPerPush = (count: number) =>
  `${(count / PUSH_COUNT).toFixed(1)} a push (${String(count)} for ${String(PUSH_COUNT)})`;

/** Formats a cost of all the pushes as the cost of one, with the total after it. */
const formatMsPerPush = (totalMs: number) =>
  `${(totalMs / PUSH_COUNT).toFixed(1)} ms a push (${totalMs.toFixed(0)} ms for ${String(PUSH_COUNT)})`;

/** Formats a process's CPU and wakeups as table cells, or dashes when it was not running. */
const formatUse = (sample: ProcessUse | undefined): string[] =>
  sample === undefined
    ? ["-", "-"]
    : [sample.cpuPercent.toFixed(1), sample.wakeupsPerSecond.toFixed(1)];

/** Prints what the workflow list scenario measured, against the limits spec 17 sets. */
export function reportWorkflowWork(measured: WorkflowWork): void {
  const { memory, visible, hidden, opening, pushes } = measured;
  const summedMb = memory.reduce((sum, sample) => sum + sample.workingSetMb, 0);
  const summedFootprintMb = memory.reduce((sum, sample) => sum + sample.footprintMb, 0);
  const renderer = memory.find((sample) => sample.label === "Tab");
  const rendererMb = renderer?.workingSetMb ?? 0;
  const rendererFootprintMb = renderer?.footprintMb ?? 0;
  const rendererLimit = `no wakeups from the app (at most ${String(BUDGET.rendererWakeups)}/s)`;
  const readUse = (samples: readonly ProcessUse[], type: string) => {
    const use = findProcessUse(samples, type);
    return use === undefined
      ? { text: "-", wakeups: 0 }
      : {
          text: `${use.cpuPercent.toFixed(1)}% CPU, ${use.wakeupsPerSecond.toFixed(1)} wakeups/s`,
          wakeups: use.wakeupsPerSecond,
        };
  };
  const rendererVisible = readUse(visible, "Tab");
  const rendererHidden = readUse(hidden, "Tab");
  const gpuVisible = readUse(visible, "GPU");

  const settled = pushes.settleMs.filter((ms) => ms !== null).toSorted((a, b) => a - b);
  const otherPaths = [...pushes.otherPaths]
    .map(([path, count]) => `${path} ${String(count)}`)
    .join(", ");
  const mainThreadPerPushMs = pushes.rendererMainThreadMs / PUSH_COUNT;
  const rounds = pushes.reads.liveRuns / LIVE_RUN_READS;
  const runReads = pushes.reads.strip + pushes.reads.liveRuns + pushes.reads.otherRuns;
  // Budget, limit, measured, and whether the measurement is within the
  // limit, or null for a measure that is recorded but has no budget.
  const budgets: [string, string, string, boolean | null][] = [
    [
      "Processes",
      `none added: ${String(BUDGET.processes)}`,
      `${String(memory.length)}: ${memory.map((sample) => sample.label).join(", ")}`,
      memory.length <= BUDGET.processes,
    ],
    [
      "Footprint, summed",
      `at most ${String(BUDGET.summedFootprintMb)} MB`,
      `${summedFootprintMb.toFixed(0)} MB`,
      summedFootprintMb <= BUDGET.summedFootprintMb,
    ],
    [
      "Footprint, renderer",
      `at most ${String(BUDGET.rendererFootprintMb)} MB`,
      `${rendererFootprintMb.toFixed(0)} MB`,
      rendererFootprintMb <= BUDGET.rendererFootprintMb,
    ],
    ["Working set, summed", "recorded; not budgeted", `${summedMb.toFixed(0)} MB`, null],
    ["Working set, renderer", "recorded; not budgeted", `${rendererMb.toFixed(0)} MB`, null],
    [
      "Idle visible, renderer",
      rendererLimit,
      rendererVisible.text,
      rendererVisible.wakeups <= BUDGET.rendererWakeups,
    ],
    [
      "Idle visible, GPU",
      `at most ${String(BUDGET.gpuWakeupsVisible)} wakeups/s`,
      gpuVisible.text,
      gpuVisible.wakeups <= BUDGET.gpuWakeupsVisible,
    ],
    [
      "Idle visible, age clock over 10 s",
      "recorded; the seeded runs are under an hour old, so their ages change",
      String(measured.firesVisible),
      null,
    ],
    [
      "Idle hidden, renderer",
      rendererLimit,
      rendererHidden.text,
      rendererHidden.wakeups <= BUDGET.rendererWakeups,
    ],
    [
      "Idle hidden, age clock over 13 s",
      "0 fires: the clock is stopped while hidden",
      String(measured.firesHidden),
      measured.firesHidden === 0,
    ],
    [
      "Opening the list, strip reads",
      `one per workflow: ${String(WORKFLOW_COUNT)}`,
      String(opening.stripReads),
      opening.stripReads <= WORKFLOW_COUNT,
    ],
    [
      `Opening the list, until the first ${String(WORKFLOW_COUNT)} strip reads answered`,
      "controller local; past 500 ms the strips become one read",
      `${opening.firstStripsFromPageStartMs.toFixed(0)} ms from the page's start ` +
        `(${opening.firstStripsFromSpawnMs.toFixed(0)} ms from spawn)`,
      opening.firstStripsFromPageStartMs <= 500,
    ],
    [
      "Opening the list, until the last strip read answered",
      "recorded; not budgeted",
      `${opening.lastStripFromPageStartMs.toFixed(0)} ms from the page's start`,
      null,
    ],
    [
      '"From runs", reads at launch',
      "one read added to each round of the launch's shell reads, as many as the thread list's",
      `${String(opening.liveSessionReads)} (thread list ${String(opening.threadListReads)})`,
      opening.liveSessionReads <= opening.threadListReads,
    ],
    [
      "Per push, strip reads",
      `one per workflow, ${String(WORKFLOW_COUNT)} a push`,
      formatPerPush(pushes.reads.strip),
      pushes.reads.strip <= WORKFLOW_COUNT * PUSH_COUNT,
    ],
    [
      "Per push, live run reads",
      "two a push, running and pending; each pair is one round of reads",
      formatPerPush(pushes.reads.liveRuns),
      pushes.reads.liveRuns <= LIVE_RUN_READS * PUSH_COUNT,
    ],
    [
      "Run reads per round of reads",
      `${String(WORKFLOW_COUNT + LIVE_RUN_READS)}: every strip and the live runs, once`,
      rounds === 0 ? "no round" : `${(runReads / rounds).toFixed(1)} over ${String(rounds)} rounds`,
      rounds === 0 ? null : runReads <= (WORKFLOW_COUNT + LIVE_RUN_READS) * rounds,
    ],
    [
      "Per push, other run reads",
      "recorded; not budgeted",
      formatPerPush(pushes.reads.otherRuns),
      null,
    ],
    [
      "Per push, other reads",
      "recorded; not budgeted",
      `${formatPerPush(pushes.reads.other + pushes.reads.liveSessions)}${otherPaths === "" ? "" : `: ${otherPaths}`}`,
      null,
    ],
    [
      "Per push, until the last run read answered",
      "recorded; not budgeted",
      settled.length === 0
        ? "no run read followed a push"
        : `median ${settled[Math.floor(settled.length / 2)]!.toFixed(0)} ms, ` +
          `longest ${settled.at(-1)!.toFixed(0)} ms, ` +
          `${String(settled.length)} of ${String(PUSH_COUNT)} pushes read runs`,
      null,
    ],
    [
      "Per push, renderer main thread",
      `at most ${String(BUDGET.rendererMainThreadPerNudgeMs)} ms, the thread list's nudge limit`,
      formatMsPerPush(pushes.rendererMainThreadMs),
      mainThreadPerPushMs <= BUDGET.rendererMainThreadPerNudgeMs,
    ],
    [
      "Per push, renderer CPU",
      "recorded; not budgeted",
      formatMsPerPush(pushes.rendererCpuMs),
      null,
    ],
    [
      "Per push, controller CPU",
      "recorded; not budgeted",
      formatMsPerPush(pushes.controllerCpuMs),
      null,
    ],
  ];

  // A process that started or exited between the two samples is in one of
  // them only, so the table lists every process either sample saw.
  const seen = [...new Map([...visible, ...hidden].map((sample) => [sample.pid, sample.label]))];

  console.log(
    `## Workflows at work, ${String(WORKFLOW_COUNT)} workflows listed, ` +
      `${String(LIVE_RUNS)} live runs across ${String(LIVE_WORKFLOW_COUNT)} of them, ` +
      `one run cancelled a push`,
  );
  console.log();
  console.log(`Load average over the minute before the launch: ${measured.loadAtSpawn.toFixed(2)}`);
  console.log();
  console.log("Memory, 13 s after the page opened:");
  console.log(
    formatTable(
      ["Process", "PID", "Working set MB", "Footprint MB"],
      [
        ...memory.map((sample) => [
          sample.label,
          String(sample.pid),
          sample.workingSetMb.toFixed(1),
          sample.footprintMb.toFixed(1),
        ]),
        ["Sum", "", summedMb.toFixed(1), summedFootprintMb.toFixed(1)],
      ],
    ),
  );
  console.log();
  console.log(
    "CPU and wakeups over 10 s: visible from 30 s after the page opened, hidden from 3 s after hiding:",
  );
  console.log(
    formatTable(
      [
        "Process",
        "PID",
        "CPU %, visible",
        "Wakeups/s, visible",
        "CPU %, hidden",
        "Wakeups/s, hidden",
      ],
      seen.map(([pid, label]) => [
        label,
        String(pid),
        ...formatUse(visible.find((sample) => sample.pid === pid)),
        ...formatUse(hidden.find((sample) => sample.pid === pid)),
      ]),
    ),
  );
  console.log();
  console.log(
    formatTable(
      ["Budget", "Limit", "Measured", "Within"],
      budgets.map(([budget, limit, measuredText, within]) => [
        budget,
        limit,
        measuredText,
        within === null ? "-" : within ? "yes" : "over",
      ]),
    ),
  );
  console.log();
}
