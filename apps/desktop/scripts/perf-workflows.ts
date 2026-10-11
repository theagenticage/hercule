/**
 * The desktop perf script's Workflows scenarios, on 50 workflows listed and
 * 50 live runs across 10 of them. Two plain launches measure the rows of
 * spec 17 §What Workflows costs that a script can measure. The first opens
 * the workflow list alone:
 *
 * - processes and memory with the list open;
 * - each process's CPU and wakeups with the list open, visible and hidden,
 *   and how often the age clock fired in each sample;
 * - opening the list: how many reads of the strips the launch made, and how
 *   long from spawn, and from the page's start, until the first of them had
 *   answered, and until the last answered, with the controller local;
 * - "From runs": how many reads of the live sessions that are not threads
 *   the launch made, against the thread list's reads. The launch reads every
 *   read on screen twice: once as the page loads, and again when the live
 *   connection's first pushes say every record may have changed;
 * - what one `run` push costs: how many reads it causes, by what they read
 *   (the strips, `run.query({ newestPerWorkflow })`, one read for every
 *   workflow; the live runs, one `run.query` for the `running` status and one for `pending`;
 *   any other run read; and any other read), how long after the push the
 *   last of those reads answered, and the renderer's main thread and CPU,
 *   and the controller's CPU, per push.
 *
 * The second opens the last workflow beside the list (see
 * `measureOpenWorkflowWork`), and measures:
 *
 * - processes and memory with the list and the open workflow;
 * - each process's CPU and wakeups with the workflow open, visible and
 *   hidden, and the age clock's fires in each;
 * - how many nodes the graph drew, and how many rows of the Runs list are
 *   mounted against how many it has read;
 * - what one `run` push costs with the Runs tab on its list, then on the
 *   timeline of the day that holds the workflow's 300 runs, read as for the
 *   list launch, with the open workflow's own reads counted apart;
 * - how many of those 300 runs the timeline draws, on how many tracks, and
 *   the renderer main thread's time from asking for the day until it shows.
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
 * - one run of each of the next 39, whose step waits 1 s, the least the
 *   `wait` action allows, so the run has completed before the app launches.
 *   No seeded run fails, so the list's Failing group is empty;
 * - 300 runs of the last workflow, the open one, whose three steps each
 *   wait 1 s, two of them after the first. The runs complete, and the
 *   fixture then spreads them evenly over yesterday, in the user's
 *   timezone, as a busy workflow's day would be. The controller stamps a
 *   run's times with its own clock, so only the database can move them.
 *
 * A push is one run cancelled through `run.cancel`, one live workflow after
 * another. Cancelling is one change to one run, where starting a run is two
 * (pending, then running). Each round of 10 pushes cancels each live
 * workflow's next run, so the three rounds take the live runs from 50 down
 * to 20. That changes no count of reads: each push reads every run read on
 * screen once, however many runs are live. No push changes a run of the
 * open workflow, so the open workflow's reads answer the same each time.
 *
 * Each strip holds at most 20 runs, as a strip shows at most. The seed's
 * 339 finished runs and 50 live ones make the strips' answer at most 109
 * runs, one page of 500, so the strips' read is one request.
 *
 * The routes' chunks and the first screen's bytes are not measured here:
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
  type Inspector,
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

/** How many runs the open workflow has, all of them on one day. */
const OPEN_WORKFLOW_RUNS = 300;

/**
 * How many finished runs the seed leaves: one for each workflow without live
 * runs but the open one, and the open workflow's.
 */
const COMPLETED_RUNS = WORKFLOW_COUNT - LIVE_WORKFLOW_COUNT - 1 + OPEN_WORKFLOW_RUNS;

/** How many nodes the open workflow's graph draws: its trigger and its three steps. */
const OPEN_WORKFLOW_NODES = 4;

/** How long a live run waits, in seconds: the longest the `wait` action allows, one day. */
const LIVE_WAIT_SECONDS = 86_400;

/** How long a run that completes waits, in seconds: the least the `wait` action allows. */
const COMPLETED_WAIT_SECONDS = 1;

/**
 * How far inside yesterday the open workflow's runs start, at each end. Two
 * hours keep every run on that day even when the clocks changed between
 * yesterday and now, which moves the day's start by an hour.
 */
const DAY_MARGIN_MS = 2 * 3_600_000;

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
 * which 10 pushes of a few reads each stay under, but a push that reads
 * more than it should must still be counted.
 */
const RESOURCE_BUFFER_SIZE = 10_000;

/** The path every run read goes to. */
const RUNS_PATH = "/api/v1/runs";

/** The path every session read goes to; "From runs" reads it with `thread=false`. */
const SESSIONS_PATH = "/api/v1/sessions";

/**
 * Builds the definition of the open workflow, the seed's last, numbered
 * `number`: its event trigger starts a fetch step, after which two steps run
 * side by side. Each step waits 1 s, so a run completes in a few seconds,
 * and the graph has a fork to lay out.
 */
function buildOpenWorkflowDefinition(number: number): WorkflowDefinition {
  const wait = {
    kind: "action",
    action: "wait",
    params: { seconds: COMPLETED_WAIT_SECONDS },
  } as const;
  return {
    name: `Workflow ${String(number)}`,
    description: "Fetches the night's orders, then checks them and sends the summary.",
    triggers: [
      {
        id: "start",
        kind: "start",
        on: { kind: "task.created", filter: 'event.payload.task.title == "never"' },
      },
    ],
    steps: [
      { id: "fetch", ...wait },
      { id: "check", ...wait },
      { id: "notify", ...wait },
    ],
    edges: [
      { from: "fetch", to: "check" },
      { from: "fetch", to: "notify" },
    ],
  };
}

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

/** What `seedWorkflows` made. */
export interface SeededWorkflows {
  /** The ids of the live runs, grouped by workflow, in the order each was started. */
  readonly liveRunIds: readonly (readonly string[])[];
  /** The id of the workflow with 300 runs, which the second launch opens. */
  readonly openWorkflowId: string;
}

/**
 * Returns the instants yesterday started and ended in the IANA zone
 * `timezone`, as seen from `now`. The start is found with the zone's offset
 * at `now`, so it is an hour off when the clocks changed since; the caller
 * keeps clear of the day's edges.
 */
function findYesterday(timezone: string, now: Date): { start: Date; end: Date } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(now);
  const readPart = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)!.value);
  const year = readPart("year");
  const month = readPart("month") - 1;
  const day = readPart("day");
  const wallClockMs = Date.UTC(
    year,
    month,
    day,
    readPart("hour"),
    readPart("minute"),
    readPart("second"),
  );
  const offsetMs = wallClockMs - Math.floor(now.getTime() / 1_000) * 1_000;
  const startMs = Date.UTC(year, month, day - 1) - offsetMs;
  return { start: new Date(startMs), end: new Date(startMs + 86_400_000) };
}

/**
 * Creates the 50 workflows and starts their runs, as the top of this file
 * describes. The finished runs come first. Once they have completed, the
 * fixture restarts the controller and spreads the open workflow's 300 runs
 * over yesterday (see `ThreadFixture.prepareLaunch`). The live runs start
 * only after that restart, so the controller never restarts under them.
 * Returns once all 50 live runs are `running`.
 *
 * Fails when the controller refuses a workflow or a run, or when the runs
 * have not settled within 60 s.
 *
 * The runs settle before the app launches, so no run's change reaches the
 * launch and adds reads to it.
 */
export async function seedWorkflows(fixture: ThreadFixture): Promise<SeededWorkflows> {
  const workflowIds: string[] = [];
  for (let number = 1; number <= WORKFLOW_COUNT; number += 1) {
    const live = number <= LIVE_WORKFLOW_COUNT;
    const { workflow } = await fixture.call<WorkflowSaveResult>("POST", "/workflows", {
      definition:
        number === WORKFLOW_COUNT
          ? buildOpenWorkflowDefinition(number)
          : buildWorkflowDefinition(number, live ? LIVE_WAIT_SECONDS : COMPLETED_WAIT_SECONDS),
    });
    workflowIds.push(workflow.id);
  }
  const startRun = async (workflowId: string): Promise<string> =>
    (await fixture.call<RunStarted>("POST", "/runs/start", { workflowId })).runId;
  const waitForRuns = (running: number, completed: number) =>
    pollUntil(
      async () =>
        (await listRuns(fixture, "running")).length === running &&
        (await listRuns(fixture, "pending")).length === 0 &&
        (await listRuns(fixture, "completed")).length === completed
          ? true
          : undefined,
      {
        timeoutMs: 60_000,
        intervalMs: 200,
        timeoutMessage: `the seeded runs were not ${String(running)} running and ${String(completed)} completed within 60 s`,
      },
    );

  const openWorkflowId = workflowIds.at(-1)!;
  for (const workflowId of workflowIds.slice(LIVE_WORKFLOW_COUNT, -1)) await startRun(workflowId);
  for (let run = 0; run < OPEN_WORKFLOW_RUNS; run += 1) await startRun(openWorkflowId);
  await waitForRuns(0, COMPLETED_RUNS);

  const { user } = await fixture.call<{ readonly user: { readonly timezone: string } }>(
    "GET",
    "/settings",
  );
  const yesterday = findYesterday(user.timezone, new Date());
  await fixture.prepareLaunch({
    twoMinuteRow: false,
    spreadRuns: {
      workflowId: openWorkflowId,
      from: new Date(yesterday.start.getTime() + DAY_MARGIN_MS),
      to: new Date(yesterday.end.getTime() - DAY_MARGIN_MS),
    },
  });

  const liveRunIds: string[][] = [];
  for (const workflowId of workflowIds.slice(0, LIVE_WORKFLOW_COUNT)) {
    const ids: string[] = [];
    for (let run = 0; run < LIVE_RUNS_PER_WORKFLOW; run += 1) ids.push(await startRun(workflowId));
    liveRunIds.push(ids);
  }
  await waitForRuns(LIVE_RUNS, COMPLETED_RUNS);
  return { liveRunIds, openWorkflowId };
}

/**
 * Returns the live runs that the push round `round`, counting from 0,
 * cancels: the run at position `round` of each live workflow, in workflow
 * order.
 */
export const pickPushRound = (
  liveRunIds: readonly (readonly string[])[],
  round: number,
): string[] => liveRunIds.map((ids) => ids[round]!);

/**
 * Opens Workflows once in the signed-in app on `userDataDir`, so the app
 * opens it again at its next launch (see `openScreenOnce`). Fails when the
 * list does not show a row.
 */
export const openWorkflowsOnce = (userDataDir: string): Promise<void> =>
  openScreenOnce(userDataDir, "/workflows", (page: Page) =>
    page.locator(WORKFLOW_ROW_SELECTOR).first().waitFor(),
  );

/**
 * An expression that evaluates, in the page, to whether the open workflow
 * has drawn: every node of its graph, and a row of its Runs list.
 */
const OPEN_WORKFLOW_DRAWN = `document.querySelectorAll(".open-pane .graph .node").length >= ${String(OPEN_WORKFLOW_NODES)} &&
  document.querySelector('.open-pane [role="list"] > *') !== null`;

/**
 * Opens the workflow `workflowId` once in the signed-in app on
 * `userDataDir`, so the app opens it again, beside the list, at its next
 * launch (see `openScreenOnce`). Fails when its graph and its Runs list do
 * not show.
 */
export const openWorkflowOnce = (userDataDir: string, workflowId: string): Promise<void> =>
  openScreenOnce(userDataDir, `/workflows/${workflowId}`, async (page: Page) => {
    // The page's content security policy refuses code passed as a string,
    // so the wait reads the page through locators.
    await page
      .locator(".open-pane .graph .node")
      .nth(OPEN_WORKFLOW_NODES - 1)
      .waitFor();
    await page.locator('.open-pane [role="list"] > *').first().waitFor();
  });

/** What a read is for, by its URL. */
type ReadKind =
  "strip" | "liveRuns" | "workflowRuns" | "dayRuns" | "otherRuns" | "liveSessions" | "other";

/** The reads of the live runs in one round: the `running` runs and the `pending` ones. */
const LIVE_RUN_READS = 2;

/**
 * Returns what the read of `url` is for:
 *
 * - the strips, when it reads each workflow's newest runs;
 * - the live runs, when it reads running or pending runs;
 * - a page of the open workflow's Runs list, when it reads one workflow's
 *   runs;
 * - the timeline's day, when it reads one workflow's runs live in a span;
 * - any other run read;
 * - the live sessions that are not threads, which "From runs" reads;
 * - or anything else.
 */
function classifyRead(url: URL): ReadKind {
  if (url.pathname === SESSIONS_PATH && url.searchParams.get("thread") === "false") {
    return "liveSessions";
  }
  if (url.pathname !== RUNS_PATH) return "other";
  if (url.searchParams.has("newestPerWorkflow")) return "strip";
  const status = url.searchParams.get("status");
  if (status === "running" || status === "pending") return "liveRuns";
  if (url.searchParams.has("workflowId")) {
    return url.searchParams.has("activeSince") ? "dayRuns" : "workflowRuns";
  }
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
  /**
   * How many requests for the strips the launch made. Each is one page of
   * one read; the seed's runs fit one page.
   */
  readonly stripReads: number;
  /** How many reads of the live sessions that are not threads the launch made. */
  readonly liveSessionReads: number;
  /**
   * How many reads of the thread list the launch made. The thread list is a
   * shell read on every screen, so it counts the rounds of shell reads the
   * launch made.
   */
  readonly threadListReads: number;
  /** From spawn until the first request for the strips answered, in milliseconds. */
  readonly firstStripsFromSpawnMs: number;
  /** The same, from the page's start, its navigation. */
  readonly firstStripsFromPageStartMs: number;
  /** From the page's start until the last request for the strips answered, in milliseconds. */
  readonly lastStripsFromPageStartMs: number;
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

/** Each process's use with the window visible and hidden, and when each sample ran. */
interface IdleSamples {
  /** Each process's use over 10 s with the window visible. */
  readonly visible: readonly ProcessUse[];
  /** Each process's use over 10 s with the window hidden, from 3 s after it was hidden. */
  readonly hidden: readonly ProcessUse[];
  /** When the visible sample started and ended, in milliseconds since the epoch. */
  readonly visibleFrom: number;
  readonly visibleTo: number;
  /** When the window was hidden, and when the hidden sample ended. */
  readonly hiddenFrom: number;
  readonly hiddenTo: number;
}

/** What one launch measured at rest: memory, and the idle samples with the age clock's fires. */
interface LaunchAtRest {
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
}

/** What the workflow list scenario measured. */
export interface WorkflowWork extends LaunchAtRest {
  readonly opening: OpeningCost;
  readonly pushes: PushCost;
}

/** Calls `method` on the app's one window, through main's inspector at `inspectorUrl`. */
const callWindow = (inspectorUrl: string, method: "hide" | "showInactive" | "isVisible") =>
  evaluateInMain(inspectorUrl, `require("electron").BrowserWindow.getAllWindows()[0]?.${method}()`);

/**
 * Samples each process's use over 10 s with the window visible, hides the
 * window, samples again from 3 s after hiding it (see `sampleIdleUse`), and
 * shows the window again, without taking the focus. Returns once the window
 * has been shown for 3 s, so the page has read again what it dropped while
 * hidden. Fails when the window is not visible or hidden as each sample
 * expects.
 */
async function sampleVisibleAndHidden(inspectorUrl: string): Promise<IdleSamples> {
  const visibleFrom = Date.now();
  const visible = await sampleIdleUse(inspectorUrl);
  const visibleTo = Date.now();
  if ((await callWindow(inspectorUrl, "isVisible")) !== true) {
    throw new Error("the window was not visible while sampled");
  }
  await callWindow(inspectorUrl, "hide");
  const hiddenFrom = Date.now();
  await sleep(HIDDEN_SETTLE_MS);
  const hidden = await sampleIdleUse(inspectorUrl);
  const hiddenTo = Date.now();
  if ((await callWindow(inspectorUrl, "isVisible")) !== false) {
    throw new Error("the window was not hidden while sampled");
  }
  // `showInactive` leaves the focus where it is, so the run does not take
  // the keyboard from whoever is using the machine.
  await callWindow(inspectorUrl, "showInactive");
  await sleep(SHOW_SETTLE_MS);
  return { visible, hidden, visibleFrom, visibleTo, hiddenFrom, hiddenTo };
}

/**
 * Returns how often the age clock fired in `samples`' visible sample, and
 * from hiding the window to the end of the hidden one, read from the page
 * `page`. The clock marks each fire with `performance.mark("age-clock-fire")`.
 */
async function countAgeClockFires(
  page: Inspector,
  samples: IdleSamples,
): Promise<{ firesVisible: number; firesHidden: number }> {
  const fires = (await page.evaluate("Runtime.evaluate", {
    expression: `performance.getEntriesByName("age-clock-fire").map((entry) => performance.timeOrigin + entry.startTime)`,
    returnByValue: true,
  })) as number[];
  const countFires = (from: number, to: number) =>
    fires.filter((at) => at >= from && at < to).length;
  return {
    firesVisible: countFires(samples.visibleFrom, samples.visibleTo),
    firesHidden: countFires(samples.hiddenFrom, samples.hiddenTo),
  };
}

/**
 * Returns the time the renderer's main thread of `page` has spent running
 * tasks so far, in milliseconds, from its DevTools performance metrics.
 * `Performance.enable` must have been sent to `page` first.
 */
async function readMainThreadMs(page: Inspector): Promise<number> {
  const { metrics } = (await page.send("Performance.getMetrics")) as {
    metrics: { name: string; value: number }[];
  };
  const seconds = metrics.find((metric) => metric.name === "TaskDuration")?.value;
  if (seconds === undefined) throw new Error("the page reports no TaskDuration metric");
  return seconds * 1_000;
}

/**
 * Cancels each run of `pushRunIds`, one a second, with the app's page
 * `page` open, and returns what those pushes cost, over the time from the
 * first cancel to 2 s after the last. The controller's (`controllerPid`)
 * and the renderer's (`rendererPid`) CPU time come from `ps`, and the
 * renderer main thread's time from the page's DevTools performance metrics.
 * Each also holds whatever the process did while idle in that time, so the
 * numbers err high. The page's reads come from its resource timing entries,
 * each counted to the push before it started. A push's settle time ends with
 * the last run read that answered, so it holds the controller's work on the
 * cancel, the push reaching the app, the 50 ms the app gathers pushes in,
 * and the reads.
 *
 * The page's resource timing buffer is cleared first, so reads made before
 * the call are not counted. `Performance.enable` must have been sent to
 * `page` first.
 */
async function measurePushes(
  page: Inspector,
  fixture: ThreadFixture,
  rendererPid: number,
  pushRunIds: readonly string[],
): Promise<PushCost> {
  const evaluate = (expression: string) =>
    page.evaluate("Runtime.evaluate", { expression, returnByValue: true });
  const controllerPid = fixture.readControllerPid();
  await evaluate(`performance.setResourceTimingBufferSize(${String(RESOURCE_BUFFER_SIZE)});
    performance.clearResourceTimings();`);
  const before = {
    controller: await readCpuMs(controllerPid),
    renderer: await readCpuMs(rendererPid),
    mainThread: await readMainThreadMs(page),
  };
  const pushedAt: number[] = [];
  for (const runId of pushRunIds) {
    pushedAt.push(Date.now());
    await fixture.call("POST", `/runs/${runId}/cancel`, {});
    await sleep(Math.max(0, pushedAt.at(-1)! + PUSH_INTERVAL_MS - Date.now()));
  }
  await sleep(PUSH_SETTLE_MS);
  const after = {
    controller: await readCpuMs(controllerPid),
    renderer: await readCpuMs(rendererPid),
    mainThread: await readMainThreadMs(page),
  };
  const reads = (await evaluate(READ_READS)) as Read[];
  return {
    controllerCpuMs: after.controller - before.controller,
    rendererCpuMs: after.renderer - before.renderer,
    rendererMainThreadMs: after.mainThread - before.mainThread,
    ...countPushReads(reads, pushedAt),
  };
}

/** Returns the renderer's process id in `memory`, and fails when there is no renderer. */
function findRendererPid(memory: readonly ProcessMemory[]): number {
  const pid = memory.find((sample) => sample.label === "Tab")?.pid;
  if (pid === undefined) throw new Error("the app has no renderer process");
  return pid;
}

/**
 * Starts the signed-in app on `userDataDir` as a plain process, warm (see
 * `warmUpApp`), where it opens Workflows again on the seeded workflows, and
 * measures it. Returns, read in this order:
 *
 * - each process's memory, 13 s after the page opened (see
 *   `readProcessMemory`);
 * - the launch's reads, 28 s after the page opened: the reads of the
 *   strips and of the live sessions that are not threads, and when the
 *   first and the last read of the strips answered;
 * - each process's CPU and wakeups over 10 s with the window visible, from
 *   30 s after the page opened, and over 10 s with the window hidden (see
 *   `sampleVisibleAndHidden`), with the age clock's fires in each;
 * - with the window shown again, what the 10 pushes of `pushRunIds` cost
 *   (see `measurePushes`).
 *
 * Nothing stays attached to the page until the idle samples are over, as in
 * `perf.ts`; the pushes then share one connection. The window stays shown
 * during the pushes, because a hidden page drops the `run` topic.
 *
 * Fails when the list does not show with its strips read within 15 s, when
 * the window is not visible or hidden as each sample expects, or when the
 * app does not quit cleanly afterwards.
 */
export async function measureWorkflowWork(
  userDataDir: string,
  fixture: ThreadFixture,
  pushRunIds: readonly string[],
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

    // The loader reads the strips before the list draws, so a drawn row
    // and a read of the strips show that every workflow is listed.
    await pollUntil(
      async () =>
        (await evaluateInPage(
          pageSocketUrl,
          `document.querySelector(${JSON.stringify(WORKFLOW_ROW_SELECTOR)}) !== null`,
        )) === true && countReadsOfKind(await readReads(), "strip") >= 1
          ? true
          : undefined,
      {
        timeoutMs: 15_000,
        intervalMs: 100,
        timeoutMessage: "the app did not open Workflows and read its strips",
      },
    );

    await sleepUntil(MEMORY_READ_AT_MS);
    const memory = await readProcessMemory(app.process.pid!);
    const rendererPid = findRendererPid(memory);

    await sleepUntil(LAUNCH_READS_AT_MS);
    const launchReads = await readReads();
    const pageStart = (await evaluateInPage(pageSocketUrl, "performance.timeOrigin")) as number;
    // The live connection opens after the launch's first reads, and the
    // controller answers each live topic's subscription with a push that
    // says every record may have changed. So the launch reads the strips,
    // and every other read on screen, a second time. The first read of the
    // strips is the one the list waits for.
    const strips = launchReads
      .filter((read) => classifyRead(new URL(read.url)) === "strip")
      .toSorted((a, b) => a.startedAt - b.startedAt);
    const findLastAnswer = (reads: readonly Read[]) =>
      Math.max(...reads.map((read) => read.answeredAt));
    const firstStripsAnsweredAt = strips[0]!.answeredAt;
    const opening: OpeningCost = {
      stripReads: strips.length,
      liveSessionReads: countReadsOfKind(launchReads, "liveSessions"),
      threadListReads: launchReads.filter((read) => {
        const url = new URL(read.url);
        return url.pathname === SESSIONS_PATH && url.searchParams.get("thread") === "true";
      }).length,
      firstStripsFromSpawnMs: firstStripsAnsweredAt - spawnedAt,
      firstStripsFromPageStartMs: firstStripsAnsweredAt - pageStart,
      lastStripsFromPageStartMs: findLastAnswer(strips) - pageStart,
    };

    await sleepUntil(VISIBLE_SAMPLE_AT_MS);
    const samples = await sampleVisibleAndHidden(inspectorUrl);

    const page = await connectInspector(pageSocketUrl);
    try {
      const fires = await countAgeClockFires(page, samples);
      await page.send("Performance.enable");
      // Showing the window again read every list again, so `measurePushes`
      // clears the reads only now, and those reads are not counted as the
      // first push's.
      const pushes = await measurePushes(page, fixture, rendererPid, pushRunIds);
      measured = {
        loadAtSpawn,
        memory,
        visible: samples.visible,
        hidden: samples.hidden,
        ...fires,
        opening,
        pushes,
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

/** What the open workflow scenario measured. */
export interface OpenWorkflowWork extends LaunchAtRest {
  /** How many nodes the graph drew. */
  readonly graphNodes: number;
  /** How many rows of the Runs list were mounted, with the list at its top. */
  readonly mountedRows: number;
  /** How many rows the Runs list had read, from the height its virtualizer gave it. */
  readonly listedRows: number;
  /** What the pushes cost with the Runs tab on its list. */
  readonly listPushes: PushCost;
  /** The renderer main thread's time from asking for the 300-run day until all of it showed, in milliseconds. */
  readonly dayDrawMainThreadMs: number;
  /** How many bars the timeline drew for that day, and on how many tracks. */
  readonly dayBars: number;
  readonly dayTracks: number;
  /** What the pushes cost with the Runs tab on the timeline of that day. */
  readonly timelinePushes: PushCost;
}

/** An expression that evaluates, in the page, to how many bars the open workflow's timeline draws. */
const COUNT_DAY_BARS = `document.querySelectorAll(".open-pane .lanes .run-bar").length`;

/**
 * Starts the signed-in app on `userDataDir` as a plain process, warm (see
 * `warmUpApp`), where it opens the workflow with 300 runs again beside the
 * list, on its Runs tab's list, and measures it. Returns, read in this order:
 *
 * - each process's memory, 13 s after the page opened;
 * - how many nodes the graph drew, and how many rows of the Runs list are
 *   mounted against how many it has read, with the list at its top;
 * - each process's CPU and wakeups over 10 s with the window visible, from
 *   30 s after the page opened, and over 10 s with the window hidden, with
 *   the age clock's fires in each;
 * - with the window shown again, what the pushes of `listPushRunIds` cost
 *   with the Runs tab on its list (see `measurePushes`);
 * - the renderer main thread's time to show the timeline, step back to
 *   yesterday, and draw its 300 runs, from the press until 1 s after every
 *   bar is in the page, so the bars' arrival is in it; how many bars the
 *   day drew, and on how many tracks;
 * - 3 s later, once the day has settled, what the pushes of
 *   `timelinePushRunIds` cost on that day.
 *
 * Fails when the workflow does not show within 15 s, when the day does not
 * draw its 300 runs within 15 s, when the window is not visible or hidden
 * as each sample expects, or when the app does not quit cleanly afterwards.
 */
export async function measureOpenWorkflowWork(
  userDataDir: string,
  fixture: ThreadFixture,
  listPushRunIds: readonly string[],
  timelinePushRunIds: readonly string[],
): Promise<OpenWorkflowWork> {
  await warmUpApp(userDataDir);
  const loadAtSpawn = loadavg()[0]!;
  const app = await launchPlainApp(userDataDir);
  const { inspectorUrl } = app;
  let measured: OpenWorkflowWork;
  try {
    const pageSocketUrl = await waitForPageSocketUrl(app.endpoint);
    const pageOpenedAt = Date.now();
    const sleepUntil = (msAfterOpen: number) =>
      sleep(Math.max(0, pageOpenedAt + msAfterOpen - Date.now()));
    await pollUntil(
      async () =>
        (await evaluateInPage(pageSocketUrl, OPEN_WORKFLOW_DRAWN)) === true ? true : undefined,
      {
        timeoutMs: 15_000,
        intervalMs: 100,
        timeoutMessage: "the app did not open the workflow with its graph and its Runs list",
      },
    );

    await sleepUntil(MEMORY_READ_AT_MS);
    const memory = await readProcessMemory(app.process.pid!);
    const rendererPid = findRendererPid(memory);
    const { graphNodes, mountedRows, listedRows } = (await evaluateInPage(
      pageSocketUrl,
      `(() => {
        const list = document.querySelector('.open-pane [role="list"]');
        return {
          graphNodes: document.querySelectorAll(".open-pane .graph .node").length,
          mountedRows: list.children.length,
          listedRows: Math.round(
            parseFloat(list.style.height) / list.firstElementChild.getBoundingClientRect().height,
          ),
        };
      })()`,
    )) as { graphNodes: number; mountedRows: number; listedRows: number };

    await sleepUntil(VISIBLE_SAMPLE_AT_MS);
    const samples = await sampleVisibleAndHidden(inspectorUrl);

    const page = await connectInspector(pageSocketUrl);
    try {
      const evaluate = (expression: string) =>
        page.evaluate("Runtime.evaluate", { expression, returnByValue: true });
      const fires = await countAgeClockFires(page, samples);
      await page.send("Performance.enable");
      const listPushes = await measurePushes(page, fixture, rendererPid, listPushRunIds);

      // Picking the timeline shows today, which holds none of the runs, so
      // the day before is asked for once today's lanes are drawn.
      const drawStartMs = await readMainThreadMs(page);
      await evaluate(`document.querySelector('.open-pane [data-view="timeline"]').click()`);
      await pollUntil(
        async () =>
          (await evaluate(`document.querySelector(".open-pane .lanes") !== null`)) === true
            ? true
            : undefined,
        { timeoutMs: 15_000, intervalMs: 50, timeoutMessage: "the timeline did not show" },
      );
      await evaluate(
        `document.querySelector('.open-pane button[aria-label="Show the day before"]').click()`,
      );
      await pollUntil(
        async () => ((await evaluate(COUNT_DAY_BARS)) === OPEN_WORKFLOW_RUNS ? true : undefined),
        {
          timeoutMs: 15_000,
          intervalMs: 50,
          timeoutMessage: `the timeline did not draw yesterday's ${String(OPEN_WORKFLOW_RUNS)} runs`,
        },
      );
      await sleep(1_000);
      const dayDrawMainThreadMs = (await readMainThreadMs(page)) - drawStartMs;
      const dayTracks = Number(
        await evaluate(
          `document.querySelector(".open-pane .lanes").style.getPropertyValue("--tracks")`,
        ),
      );
      await sleep(SHOW_SETTLE_MS);
      const timelinePushes = await measurePushes(page, fixture, rendererPid, timelinePushRunIds);
      measured = {
        loadAtSpawn,
        memory,
        visible: samples.visible,
        hidden: samples.hidden,
        ...fires,
        graphNodes,
        mountedRows,
        listedRows,
        listPushes,
        dayDrawMainThreadMs,
        dayBars: (await evaluate(COUNT_DAY_BARS)) as number,
        dayTracks,
        timelinePushes,
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
    workflowRuns: 0,
    dayRuns: 0,
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

/** A row of a budget table: the budget, its limit, what was measured, and whether that is within the limit, or null for a measure with no budget. */
type BudgetRow = [string, string, string, boolean | null];

/**
 * Builds the budget rows every Workflows launch shares from `measured`: the
 * processes, the memory, and the idle samples with the age clock's fires.
 * `agesText` says why the age clock may fire while visible.
 */
function buildAtRestRows(measured: LaunchAtRest, agesText: string): BudgetRow[] {
  const { memory, visible, hidden } = measured;
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
  return [
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
    ["Idle visible, age clock over 10 s", agesText, String(measured.firesVisible), null],
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
  ];
}

/**
 * Builds the budget rows of one round of pushes, `pushes`, each row's name
 * starting with `prefix`. `expected` lists the run reads one push should
 * cause, by kind; a kind it leaves out should cause none.
 */
function buildPushRows(
  prefix: string,
  pushes: PushCost,
  expected: Partial<Record<ReadKind, { readonly count: number; readonly text: string }>>,
): BudgetRow[] {
  const settled = pushes.settleMs.filter((ms) => ms !== null).toSorted((a, b) => a - b);
  const otherPaths = [...pushes.otherPaths]
    .map(([path, count]) => `${path} ${String(count)}`)
    .join(", ");
  const mainThreadPerPushMs = pushes.rendererMainThreadMs / PUSH_COUNT;
  const runKinds: { kind: ReadKind; name: string }[] = [
    { kind: "strip", name: "requests for the strips" },
    { kind: "liveRuns", name: "live run reads" },
    { kind: "workflowRuns", name: "reads of the Runs list's pages" },
    { kind: "dayRuns", name: "reads of the timeline's day" },
  ];
  return [
    ...runKinds.map(({ kind, name }): BudgetRow => {
      const want = expected[kind] ?? { count: 0, text: "none" };
      return [
        `${prefix}, ${name}`,
        want.text,
        formatPerPush(pushes.reads[kind]),
        pushes.reads[kind] <= want.count * PUSH_COUNT,
      ];
    }),
    [
      `${prefix}, other run reads`,
      "recorded; not budgeted",
      formatPerPush(pushes.reads.otherRuns),
      null,
    ],
    [
      `${prefix}, other reads`,
      "recorded; not budgeted",
      `${formatPerPush(pushes.reads.other + pushes.reads.liveSessions)}${otherPaths === "" ? "" : `: ${otherPaths}`}`,
      null,
    ],
    [
      `${prefix}, until the last run read answered`,
      "recorded; not budgeted",
      settled.length === 0
        ? "no run read followed a push"
        : `median ${settled[Math.floor(settled.length / 2)]!.toFixed(0)} ms, ` +
          `longest ${settled.at(-1)!.toFixed(0)} ms, ` +
          `${String(settled.length)} of ${String(PUSH_COUNT)} pushes read runs`,
      null,
    ],
    [
      `${prefix}, renderer main thread`,
      `at most ${String(BUDGET.rendererMainThreadPerNudgeMs)} ms, the thread list's nudge limit`,
      formatMsPerPush(pushes.rendererMainThreadMs),
      mainThreadPerPushMs <= BUDGET.rendererMainThreadPerNudgeMs,
    ],
    [
      `${prefix}, renderer CPU`,
      "recorded; not budgeted",
      formatMsPerPush(pushes.rendererCpuMs),
      null,
    ],
    [
      `${prefix}, controller CPU`,
      "recorded; not budgeted",
      formatMsPerPush(pushes.controllerCpuMs),
      null,
    ],
  ];
}

/**
 * Prints one Workflows launch under the heading `heading`: the load
 * average, each process's memory, CPU and wakeups, and `budgets`.
 */
function printLaunch(heading: string, measured: LaunchAtRest, budgets: readonly BudgetRow[]): void {
  const { memory, visible, hidden } = measured;
  const summedMb = memory.reduce((sum, sample) => sum + sample.workingSetMb, 0);
  const summedFootprintMb = memory.reduce((sum, sample) => sum + sample.footprintMb, 0);
  // A process that started or exited between the two samples is in one of
  // them only, so the table lists every process either sample saw.
  const seen = [...new Map([...visible, ...hidden].map((sample) => [sample.pid, sample.label]))];

  console.log(heading);
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

/** The run reads one push causes on any Workflows screen: the strips once and the live runs once. */
const LIST_PUSH_READS = {
  strip: { count: 1, text: "1 a push: one read for every workflow, one page at this seed" },
  liveRuns: {
    count: LIVE_RUN_READS,
    text: "two a push, running and pending; each pair is one round of reads",
  },
} as const;

/** Prints what the workflow list scenario measured, against the limits spec 17 sets. */
export function reportWorkflowWork(measured: WorkflowWork): void {
  const { opening, pushes } = measured;
  const rounds = pushes.reads.liveRuns / LIVE_RUN_READS;
  const runReads = pushes.reads.strip + pushes.reads.liveRuns + pushes.reads.otherRuns;
  const budgets: BudgetRow[] = [
    ...buildAtRestRows(
      measured,
      "recorded; the seeded runs are under an hour old, so their ages change",
    ),
    [
      "Opening the list, requests for the strips",
      "2: the loader's read, then the first push's read again, one page each",
      String(opening.stripReads),
      opening.stripReads <= 2,
    ],
    [
      "Opening the list, until the first request for the strips answered",
      "controller local; at most 500 ms",
      `${opening.firstStripsFromPageStartMs.toFixed(0)} ms from the page's start ` +
        `(${opening.firstStripsFromSpawnMs.toFixed(0)} ms from spawn)`,
      opening.firstStripsFromPageStartMs <= 500,
    ],
    [
      "Opening the list, until the last request for the strips answered",
      "recorded; not budgeted",
      `${opening.lastStripsFromPageStartMs.toFixed(0)} ms from the page's start`,
      null,
    ],
    [
      '"From runs", reads at launch',
      "one read added to each round of the launch's shell reads, as many as the thread list's",
      `${String(opening.liveSessionReads)} (thread list ${String(opening.threadListReads)})`,
      opening.liveSessionReads <= opening.threadListReads,
    ],
    [
      "Run reads per round of reads",
      `${String(1 + LIVE_RUN_READS)}: the strips and the live runs, once`,
      rounds === 0 ? "no round" : `${(runReads / rounds).toFixed(1)} over ${String(rounds)} rounds`,
      rounds === 0 ? null : runReads <= (1 + LIVE_RUN_READS) * rounds,
    ],
    ...buildPushRows("Per push", pushes, LIST_PUSH_READS),
  ];
  printLaunch(
    `## Workflows at work, ${String(WORKFLOW_COUNT)} workflows listed, ` +
      `${String(LIVE_RUNS)} live runs across ${String(LIVE_WORKFLOW_COUNT)} of them, ` +
      `one run cancelled a push`,
    measured,
    budgets,
  );
}

/** Prints what the open workflow scenario measured, against the limits spec 17 sets. */
export function reportOpenWorkflowWork(measured: OpenWorkflowWork): void {
  const budgets: BudgetRow[] = [
    ...buildAtRestRows(
      measured,
      "recorded; the list's live runs are under an hour old, so their ages change",
    ),
    [
      "The graph, nodes drawn",
      `${String(OPEN_WORKFLOW_NODES)}: the trigger and the three steps`,
      String(measured.graphNodes),
      measured.graphNodes === OPEN_WORKFLOW_NODES,
    ],
    [
      "The Runs list, rows mounted",
      "virtualized: the rows in view and 8 on each side, fewer than the rows read",
      `${String(measured.mountedRows)} of ${String(measured.listedRows)} read`,
      measured.mountedRows < measured.listedRows,
    ],
    ...buildPushRows("Per push, Runs list", measured.listPushes, {
      ...LIST_PUSH_READS,
      workflowRuns: { count: 1, text: "1 a push: the one page the list has read" },
    }),
    [
      "The 300-run day, bars drawn",
      `the day drawn whole: ${String(OPEN_WORKFLOW_RUNS)}`,
      `${String(measured.dayBars)}, on ${String(measured.dayTracks)} tracks`,
      measured.dayBars === OPEN_WORKFLOW_RUNS,
    ],
    [
      "The 300-run day, renderer main thread to show it",
      "recorded; not budgeted",
      `${measured.dayDrawMainThreadMs.toFixed(0)} ms, from picking the timeline until 1 s after the day showed`,
      null,
    ],
    ...buildPushRows("Per push, timeline", measured.timelinePushes, {
      ...LIST_PUSH_READS,
      dayRuns: { count: 1, text: "1 a push: the day, one page of 500" },
    }),
  ];
  printLaunch(
    `## The open workflow, ${String(OPEN_WORKFLOW_RUNS)} runs yesterday, beside ` +
      `${String(WORKFLOW_COUNT)} workflows listed, one run of another workflow cancelled a push`,
    measured,
    budgets,
  );
}
