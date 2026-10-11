/**
 * The desktop perf script's workflow list scenario: one plain launch of the
 * app on Workflows, with 10 workflows and 50 live runs across them, which
 * measures the Per push row of spec 17 §What Workflows costs:
 *
 * - how many reads one `run` push causes, by what they read: each workflow's
 *   strip (`run.query({ workflowId, limit })`), the live runs
 *   (`run.query({ status: "running" })`), any other run read, and any other
 *   read;
 * - how long after the push the last of those reads answered;
 * - the renderer's main thread and CPU, and the controller's CPU, per push.
 *
 * The seed (see `seedWorkflows`):
 *
 * - 10 workflows, each with one start trigger: half on a schedule, half on
 *   `task.created` events. Neither fires during a run of the script: the
 *   schedule is 03:00 on 1 January, and the event trigger's filter accepts
 *   only a task titled "never", which nothing creates;
 * - 5 runs of each workflow, 50 in all. Each workflow's one step is the
 *   built-in `wait` action for a day, so every run stays `running` with no
 *   runner and no provider, until it is cancelled.
 *
 * A push is one run cancelled through `run.cancel`, one workflow after
 * another. Cancelling is one change to one run, where starting a run is two
 * (pending, then running). The 10 pushes take the live runs from 50 down to
 * 40, which changes no count of reads: each push reads every strip and the
 * live runs once, however many runs are live.
 *
 * Each strip holds the workflow's 5 runs, not the 20 a strip shows at most,
 * so each strip's answer is smaller than a busy workflow's would be.
 *
 * The route's chunk and the first screen's bytes are not measured here:
 * `pnpm build:desktop`'s bundle check prints them.
 *
 * The list is still being built, so its selectors sit at the top of this
 * file, where they are easy to change.
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
  formatTable,
  launchPlainApp,
  stopPlainApp,
} from "./packaged-app.ts";
import type { ThreadFixture } from "./perf-fixture.ts";
import {
  BUDGET,
  openScreenOnce,
  readCpuMs,
  readProcessMemory,
  waitForPageSocketUrl,
} from "./perf-measures.ts";
import { pollUntil } from "./poll.ts";

/** A workflow's row in the list: a link to the workflow's page, inside the list's `nav`. */
const WORKFLOW_ROW_SELECTOR = 'nav[aria-label="Workflows"] a[href^="/workflows/"]';

/**
 * An expression that evaluates, in the page, to how many workflow rows the
 * list shows: links to a workflow's page, `/workflows/<id>`, and not to
 * anything below it, such as a run.
 */
const COUNT_WORKFLOW_ROWS = `[...document.querySelectorAll(${JSON.stringify(WORKFLOW_ROW_SELECTOR)})]
  .filter((link) => /^\\/workflows\\/[^/]+$/.test(link.getAttribute("href"))).length`;

/** How many workflows the seed creates, and how many live runs each one has. */
const WORKFLOW_COUNT = 10;
const LIVE_RUNS_PER_WORKFLOW = 5;
const LIVE_RUNS = WORKFLOW_COUNT * LIVE_RUNS_PER_WORKFLOW;

/** How long each seeded run waits, in seconds: the longest the `wait` action allows, one day. */
const WAIT_SECONDS = 86_400;

/** How many runs are cancelled one at a time, and how far apart. */
const PUSH_COUNT = 10;
const PUSH_INTERVAL_MS = 1_000;

/** How long after the last push the reading ends, so the last reads are in it. */
const PUSH_SETTLE_MS = 2_000;

/**
 * How long the launch rests after the list has shown, before the first push,
 * so its first reads, each workflow's strip among them, are over.
 */
const LAUNCH_SETTLE_MS = 5_000;

/**
 * How many entries the page's resource timing buffer holds during the
 * pushes. Chromium keeps 250 by default and drops every entry after that,
 * which 10 pushes of a dozen reads each, on top of the launch's reads, could
 * reach.
 */
const RESOURCE_BUFFER_SIZE = 10_000;

/** The path every run read goes to. */
const RUNS_PATH = "/api/v1/runs";

/**
 * Builds the definition of the seeded workflow `number`, counting from 1.
 * Odd workflows start on a schedule, even ones on an event; neither fires
 * while the script runs (see the top of this file).
 */
function buildWorkflowDefinition(number: number): WorkflowDefinition {
  const on =
    number % 2 === 1
      ? { schedule: "0 3 1 1 *" }
      : { kind: "task.created", filter: 'event.payload.task.title == "never"' };
  return {
    name: `Workflow ${String(number).padStart(2, "0")}`,
    triggers: [{ id: "start", kind: "start", on }],
    steps: [{ id: "hold", kind: "action", action: "wait", params: { seconds: WAIT_SECONDS } }],
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
 * Creates the 10 workflows and starts 5 runs of each, and returns the ids of
 * the live runs, grouped by workflow, once all 50 are `running`. Fails when
 * the controller refuses a workflow or a run, or when the runs are not all
 * running within 30 s.
 */
export async function seedWorkflows(fixture: ThreadFixture): Promise<string[][]> {
  const runIds: string[][] = [];
  for (let number = 1; number <= WORKFLOW_COUNT; number += 1) {
    const { workflow } = await fixture.call<WorkflowSaveResult>("POST", "/workflows", {
      definition: buildWorkflowDefinition(number),
    });
    const ids: string[] = [];
    for (let run = 0; run < LIVE_RUNS_PER_WORKFLOW; run += 1) {
      const { runId } = await fixture.call<RunStarted>("POST", "/runs/start", {
        workflowId: workflow.id,
      });
      ids.push(runId);
    }
    runIds.push(ids);
  }
  await pollUntil(
    async () =>
      (await listRuns(fixture, "running")).length === LIVE_RUNS &&
      (await listRuns(fixture, "pending")).length === 0
        ? true
        : undefined,
    {
      timeoutMs: 30_000,
      intervalMs: 200,
      timeoutMessage: `the ${String(LIVE_RUNS)} seeded runs were not all running within 30 s`,
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
type ReadKind = "strip" | "liveRuns" | "otherRuns" | "other";

/**
 * Returns what the read of `url` is for: a workflow's strip when it reads
 * runs of one workflow, the live runs when it reads running runs, any other
 * run read, or anything else.
 */
function classifyRead(url: URL): ReadKind {
  if (url.pathname !== RUNS_PATH) return "other";
  if (url.searchParams.has("workflowId")) return "strip";
  if (url.searchParams.get("status") === "running") return "liveRuns";
  return "otherRuns";
}

/** One read the page made, from its resource timing entry, in milliseconds since the epoch. */
interface Read {
  readonly url: string;
  readonly startedAt: number;
  readonly answeredAt: number;
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
  readonly pushes: PushCost;
}

/**
 * Starts the signed-in app on `userDataDir` as a plain process, where it
 * opens Workflows again on the seeded workflows, and cancels one live run of
 * `runIds` every second, 10 times, each from the next workflow. Returns what
 * those pushes cost, over the 12 s from the first cancel to 2 s after the
 * last:
 *
 * - the controller's and the renderer's CPU time with `ps`, and the renderer
 *   main thread's time from the page's DevTools performance metrics. Each
 *   also holds whatever the process did while idle in that time, so the
 *   numbers err high;
 * - the page's reads, from its resource timing entries, each counted to the
 *   push before it started. A push's settle time ends with the last run read
 *   that answered, so it holds the controller's work on the cancel, the push
 *   reaching the app, the 50 ms the app gathers pushes in, and the reads.
 *
 * One connection to the page serves the whole scenario. The window stays
 * shown throughout, because a hidden page drops the `run` topic.
 *
 * Fails when the list does not show all 10 workflows within 15 s, or when
 * the app does not quit cleanly afterwards.
 */
export async function measureWorkflowWork(
  userDataDir: string,
  fixture: ThreadFixture,
  runIds: readonly (readonly string[])[],
): Promise<WorkflowWork> {
  const loadAtSpawn = loadavg()[0]!;
  const app = await launchPlainApp(userDataDir);
  let measured: WorkflowWork;
  try {
    const page = await connectInspector(await waitForPageSocketUrl(app.endpoint));
    try {
      const evaluate = (expression: string) =>
        page.evaluate("Runtime.evaluate", { expression, returnByValue: true });
      await pollUntil(
        async () =>
          ((await evaluate(COUNT_WORKFLOW_ROWS)) as number) >= WORKFLOW_COUNT || undefined,
        {
          timeoutMs: 15_000,
          intervalMs: 50,
          timeoutMessage: `the app did not open Workflows on its ${String(WORKFLOW_COUNT)} workflows`,
        },
      );
      await sleep(LAUNCH_SETTLE_MS);

      const memory = await readProcessMemory(app.process.pid!);
      const rendererPid = memory.find((sample) => sample.label === "Tab")?.pid;
      if (rendererPid === undefined) throw new Error("the app has no renderer process");
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
      const reads = (await evaluate(`performance.getEntriesByType("resource").map((entry) => ({
        url: entry.name,
        startedAt: performance.timeOrigin + entry.startTime,
        answeredAt: performance.timeOrigin + entry.responseEnd,
      }))`)) as Read[];
      measured = {
        loadAtSpawn,
        pushes: {
          controllerCpuMs: after.controller - before.controller,
          rendererCpuMs: after.renderer - before.renderer,
          rendererMainThreadMs: after.mainThread - before.mainThread,
          ...countReads(reads, pushedAt),
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
function countReads(
  reads: readonly Read[],
  pushedAt: readonly number[],
): Pick<PushCost, "reads" | "otherPaths" | "settleMs"> {
  const counts: Record<ReadKind, number> = { strip: 0, liveRuns: 0, otherRuns: 0, other: 0 };
  const otherPaths = new Map<string, number>();
  const lastAnswer: (number | null)[] = pushedAt.map(() => null);
  for (const read of reads) {
    const push = pushedAt.findLastIndex((at) => at <= read.startedAt);
    if (push === -1) continue;
    const url = new URL(read.url);
    const kind = classifyRead(url);
    counts[kind] += 1;
    if (kind === "other") {
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

/** Prints what the workflow list scenario measured, against the limits spec 17 sets. */
export function reportWorkflowWork(measured: WorkflowWork): void {
  const { pushes } = measured;
  const settled = pushes.settleMs.filter((ms) => ms !== null).toSorted((a, b) => a - b);
  const otherPaths = [...pushes.otherPaths]
    .map(([path, count]) => `${path} ${String(count)}`)
    .join(", ");
  const mainThreadPerPushMs = pushes.rendererMainThreadMs / PUSH_COUNT;
  // Budget, limit, measured, and whether the measurement is within the
  // limit, or null for a measure that is recorded but has no budget.
  const budgets: [string, string, string, boolean | null][] = [
    [
      "Per push, strip reads",
      `one per workflow, ${String(WORKFLOW_COUNT)} a push`,
      formatPerPush(pushes.reads.strip),
      pushes.reads.strip <= WORKFLOW_COUNT * PUSH_COUNT,
    ],
    [
      "Per push, live run reads",
      "one a push; each is one round of reads",
      formatPerPush(pushes.reads.liveRuns),
      pushes.reads.liveRuns <= PUSH_COUNT,
    ],
    [
      "Run reads per round of reads",
      `${String(WORKFLOW_COUNT + 1)}: every strip and the live runs, once`,
      pushes.reads.liveRuns === 0
        ? "no round"
        : `${((pushes.reads.strip + pushes.reads.liveRuns + pushes.reads.otherRuns) / pushes.reads.liveRuns).toFixed(1)} ` +
          `over ${String(pushes.reads.liveRuns)} rounds`,
      pushes.reads.liveRuns === 0
        ? null
        : pushes.reads.strip + pushes.reads.liveRuns + pushes.reads.otherRuns <=
          (WORKFLOW_COUNT + 1) * pushes.reads.liveRuns,
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
      `${formatPerPush(pushes.reads.other)}${otherPaths === "" ? "" : `: ${otherPaths}`}`,
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

  console.log(
    `## Workflows at work, ${String(WORKFLOW_COUNT)} workflows and ${String(LIVE_RUNS)} live runs, ` +
      `one run cancelled a push`,
  );
  console.log();
  console.log(`Load average over the minute before the launch: ${measured.loadAtSpawn.toFixed(2)}`);
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
