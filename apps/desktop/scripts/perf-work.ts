/**
 * The desktop perf script's Work scenario: what Work costs, row by row of
 * spec 17 §What Work costs. Pass `--work-only` to `perf.ts`. It also holds
 * the launch measurement the Inbox scenario shares (`measureDeskLaunch`).
 *
 * The seed (see `seedWork` and `buildWorkDatabaseWrite`), on the fixture's 40
 * threads, each of which is a Task of its own on the board:
 *
 * - 10 Northwind Market Projects and 300 invented Tasks spread over them and
 *   over the five stages, each with a summary;
 * - 20 Initiatives, with 150 of the Tasks on them, and 30 Tasks that wait on
 *   another;
 * - the Inbox's world of `perf-inbox.ts`, and 150 of the Tasks linked to its
 *   cards, so the board can group its lanes by repository;
 * - a scripted runner, "scribe", that makes text generations, and the
 *   setting that sends them there, so the controller writes summaries.
 *
 * Each measured launch (see `measureDeskLaunch`) reads, in this order:
 *
 * 1. With nothing attached: each process's memory 13 s after the page opens,
 *    then each process's CPU and wakeups over 60 s with the window visible
 *    and nothing happening, and over 10 s hidden.
 * 2. Attached, with the page loaded again under a network collector (see
 *    `perf-collector.ts`): what the page reads as it opens, the live topics
 *    it holds, and what it reads over 10 s of quiet.
 * 3. Four agents at work for 10 s, each streaming with a usage report each
 *    second: the pushes, the reads they cause by kind, and the renderer's
 *    main thread and CPU time. Then the same for 5 s with the window hidden,
 *    and the reads that showing the window again causes.
 * 4. A new Thread: the pushes and reads its spawn causes.
 * 5. The screen's own steps: on Work `measureWorkSteps`. The Inbox has none yet.
 *
 * The launches: a thread open, to compare with; Work grouped by Project;
 * Work grouped by repository; and, after the board grows to 1,000 Tasks,
 * Work again, with Find typed.
 *
 * It runs on plain Node, like the perf script, so its imports name the `.ts`
 * file.
 */
import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { loadavg } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "playwright";
import type { Session } from "../../../packages/contract/src/index";
import {
  assertExitedCleanly,
  connectInspector,
  formatTable,
  launchPlainApp,
  readSettings,
  stopPlainApp,
  type Inspector,
} from "./packaged-app.ts";
import { startCollector, type Collector, type RecordedRequest } from "./perf-collector.ts";
import type { ThreadFixture } from "./perf-fixture.ts";
import { buildInboxCard, INBOX_CARDS, printFrames, writeInboxWorld } from "./perf-inbox.ts";
import {
  MEMORY_READ_AT_MS,
  TIMELINE_CATEGORY,
  VISIBLE_SAMPLE_AT_MS,
  drivePage,
  findRendererMainTasks,
  openScreenOnce,
  readCpuMs,
  readProcessMemory,
  readTrace,
  waitForPageSocketUrl,
  warmUpApp,
  type PageDriver,
  type ProcessMemory,
  type TraceEvent,
} from "./perf-measures.ts";
import {
  buildAtRestRows,
  callWindow,
  countAgeClockFires,
  findRendererPid,
  printLaunch,
  readMainThreadMs,
  sampleVisibleAndHidden,
  type LaunchAtRest,
} from "./perf-workflows.ts";
import { USERNAME } from "../../../scripts/controller-process.ts";
import { pollUntil } from "./poll.ts";
import type { ScriptedRunner } from "./scripted-runner.ts";

/** The Projects of the invented Northwind Market, one lane each. */
const NORTHWIND_PROJECTS = [
  "Storefront",
  "Checkout",
  "Delivery",
  "Pricing",
  "Catalog",
  "Loyalty",
  "Payments",
  "Warehouse",
  "Mobile app",
  "Back office",
] as const;

/** How many invented Tasks the board holds besides the fixture's threads, and how many the large board holds. */
const WORK_TASKS = 300;
const LARGE_BOARD_TASKS = 1_000;

/** How many Initiatives there are, how many Tasks are on them, and how many Tasks wait on another. */
const INITIATIVES = 20;
const TASKS_ON_INITIATIVES = 150;
const BLOCKED_TASKS = 30;

/** How many Tasks are linked to a card of the Inbox's world: the first of them, one card each. */
const LINKED_TASKS = 150;

/** The stage of the `index`th invented Task: about 30% Exploring, 20% Planned, 25% Building, 15% In review, 10% Landed. */
const STAGE_CYCLE = [
  ...Array<string>(6).fill("exploring"),
  ...Array<string>(4).fill("planned"),
  ...Array<string>(5).fill("building"),
  ...Array<string>(3).fill("in-review"),
  ...Array<string>(2).fill("landed"),
] as const;

/** How many API calls the seed makes at once. */
const SEED_CONCURRENCY = 20;

/** How long the visible idle sample lasts. */
const VISIBLE_SAMPLE_MS = 60_000;

/** How many agents work at once in the streaming step, and for how long, visible and then hidden. */
const BUSY_AGENTS = 4;
const STREAM_MS = 10_000;
const HIDDEN_STREAM_MS = 5_000;

/** How long the page must be without a request or a push before a measured step counts as over. */
const QUIET_MS = 500;

/**
 * How long a step that changes a Task waits for the push it causes: the
 * controller collects `task` pushes for one second before it sends them, and
 * the page's read follows the push.
 */
const PUSH_WINDOW_MS = 2_500;

/** How many Tasks change at once for the burst of summaries. */
const SUMMARY_BURST = 20;

/**
 * How long after a Task changes the controller writes its summary, plus a
 * margin: the writer waits 30 s of quiet (`SUMMARY_QUIET_SECONDS`) and looks
 * for due Tasks every few seconds.
 */
const SUMMARY_WAIT_MS = 45_000;

/** How many cards change stage while Work is closed, for the morning replay. */
const REPLAY_CHANGES = 4;

/** What the seed made, for the launches to open and change. */
export interface SeededWork {
  /** The invented Tasks, in the order they were made. */
  readonly taskIds: string[];
  readonly projectIds: readonly string[];
  /** The runner that makes text generations. */
  readonly scribe: ScriptedRunner;
}

/** Runs `make` for each of `count` indexes, `SEED_CONCURRENCY` at a time, and returns the results in order. */
async function runInBatches<T>(count: number, make: (index: number) => Promise<T>): Promise<T[]> {
  const made: T[] = [];
  for (let first = 0; first < count; first += SEED_CONCURRENCY) {
    made.push(
      ...(await Promise.all(
        Array.from({ length: Math.min(SEED_CONCURRENCY, count - first) }, (_, offset) =>
          make(first + offset),
        ),
      )),
    );
  }
  return made;
}

/** Creates the invented Tasks numbered from `from` to `to`, spread over `projectIds` and the stages, and returns their ids. */
const createTasks = (
  fixture: ThreadFixture,
  projectIds: readonly string[],
  from: number,
  to: number,
): Promise<string[]> =>
  runInBatches(to - from, async (offset) => {
    const index = from + offset;
    const card = buildInboxCard(index % INBOX_CARDS);
    const task = await fixture.call<{ readonly id: string }>("POST", "/tasks", {
      title: `${card.title} (${String(index + 1)})`,
      description: "",
      stage: STAGE_CYCLE[index % STAGE_CYCLE.length],
      projectId: projectIds[index % projectIds.length],
    });
    return task.id;
  });

/**
 * Makes the seed of the top of this file through the API: the Projects, the
 * Tasks, the Initiatives with their Tasks, the blockers, and the scribe with
 * the text generation setting. Fails when a call is refused.
 */
export async function seedWork(fixture: ThreadFixture): Promise<SeededWork> {
  const projectIds: string[] = [];
  for (const name of NORTHWIND_PROJECTS) {
    projectIds.push(
      (await fixture.call<{ readonly id: string }>("POST", "/projects", { name })).id,
    );
  }
  const taskIds = await createTasks(fixture, projectIds, 0, WORK_TASKS);
  const initiativeIds = await runInBatches(INITIATIVES, async (index) => {
    const initiative = await fixture.call<{ readonly id: string }>("POST", "/initiatives", {
      name: `${NORTHWIND_PROJECTS[index % NORTHWIND_PROJECTS.length]} wave ${String(Math.floor(index / NORTHWIND_PROJECTS.length) + 1)}`,
      intent: "Ship the change before the Friday peak.",
      projectId: projectIds[index % projectIds.length],
    });
    return initiative.id;
  });
  // A Task joins the Initiative of its own Project, so the Initiative's row
  // spans the lanes it should.
  await runInBatches(TASKS_ON_INITIATIVES, (index) =>
    fixture.call("POST", `/tasks/${taskIds[index]!}/move`, {
      initiativeId: initiativeIds[index % INITIATIVES],
    }),
  );
  // Each blocked Task waits on the Task made just before it, which is in another Project.
  await runInBatches(BLOCKED_TASKS, (index) =>
    fixture.call("POST", `/tasks/${taskIds[TASKS_ON_INITIATIVES + 2 * index + 1]!}/blockers`, {
      blockedByTaskId: taskIds[TASKS_ON_INITIATIVES + 2 * index]!,
    }),
  );
  const scribe = await fixture.enlistRunner("scribe", {
    machine: { answersTextGeneration: true },
  });
  const accounts = await fixture.call<ReadonlyArray<{ readonly id: string }>>(
    "GET",
    "/provider-accounts",
  );
  await fixture.call("PATCH", "/settings", {
    controller: {
      "textGeneration.model": { providerAccountId: accounts[0]!.id, model: "scripted" },
    },
  });
  return { taskIds, projectIds, scribe };
}

/** Grows the invented Tasks to `LARGE_BOARD_TASKS`, spread as the first ones are. */
export async function growWork(fixture: ThreadFixture, seeded: SeededWork): Promise<void> {
  seeded.taskIds.push(
    ...(await createTasks(fixture, seeded.projectIds, seeded.taskIds.length, LARGE_BOARD_TASKS)),
  );
}

/** Converts a UUID as text to the 16 bytes the controller stores it as. */
const toIdBytes = (id: string): Buffer => Buffer.from(id.replaceAll("-", ""), "hex");

/**
 * Returns the function `prepareLaunch` runs on the stopped controller's
 * database for the Work launches. It writes the Inbox's world, links the
 * first `LINKED_TASKS` Tasks each to a card of it, and gives every invented
 * Task a summary that is up to date, as the writer leaves one, so no summary
 * is written while a launch is read unless the launch changes a Task.
 */
export function buildWorkDatabaseWrite(seeded: SeededWork): (database: DatabaseSync) => void {
  return (database) => {
    writeInboxWorld(database);
    const at = new Date(Date.now() - 3 * 3_600_000).toISOString();
    database.exec("BEGIN");
    const link = database.prepare(
      "INSERT OR IGNORE INTO task_entity_links (task_id, ref, linked_at, linked_by, following) " +
        "VALUES (?, ?, ?, 'user', 0)",
    );
    for (const [index, taskId] of seeded.taskIds.slice(0, LINKED_TASKS).entries()) {
      link.run(toIdBytes(taskId), buildInboxCard(index).ref, at);
    }
    const summarize = database.prepare(
      "INSERT OR REPLACE INTO task_summaries (task_id, line, standing_text, left_text, " +
        "input_revision, generated_at, dirty_revision, dirty_at, last_attempt_at, " +
        "next_attempt_at, attempt_count, failed_at, failed_reason) " +
        "SELECT id, ?, ?, ?, revision, ?, revision, NULL, ?, NULL, 1, NULL, NULL " +
        "FROM tasks WHERE id = ?",
    );
    for (const taskId of seeded.taskIds) {
      summarize.run(
        "Two designs drafted, depots still worried",
        "Two designs for the change are drafted, and the second one is in review. The depots asked for a fallback.",
        "The fallback and a load test against the Friday peak.",
        at,
        at,
        toIdBytes(taskId),
      );
    }
    database.exec("COMMIT");
  };
}

/** Returns the id of an idle thread of the fixture, the first the controller lists. Fails when there is none. */
export async function findIdleThreadId(fixture: ThreadFixture): Promise<string> {
  const { items } = await fixture.call<{ readonly items: readonly Session[] }>(
    "GET",
    "/sessions?kind=thread&status=idle&archived=false&limit=1",
  );
  if (items[0] === undefined) throw new Error("the fixture has no idle thread");
  return items[0].id;
}

/**
 * Returns what the request `request` reads or writes: its operation's path
 * with ids as `:id`, and for a few reads the query that tells them apart.
 */
function classifyRequest(request: RecordedRequest): string {
  const { pathname, searchParams } = request.url;
  const path = pathname.replace(/^\/api\/v1/, "").replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id");
  if (request.method === "GET" && path === "/sessions") {
    const kind = searchParams.get("kind");
    return `GET /sessions${kind === null ? "" : `?kind=${kind}`}`;
  }
  return `${request.method} ${path}`;
}

/** The reads of one step, by kind: how many requests and how many bytes of answer, decompressed. */
export type ReadTally = Map<string, { requests: number; bytes: number }>;

/** Counts `requests` by kind (see `classifyRequest`). */
function tallyReads(requests: readonly RecordedRequest[]): ReadTally {
  const tally: ReadTally = new Map();
  for (const request of requests) {
    const kind = classifyRequest(request);
    const entry = tally.get(kind) ?? { requests: 0, bytes: 0 };
    entry.requests += 1;
    entry.bytes += request.bodyBytes;
    tally.set(kind, entry);
  }
  return tally;
}

/** What one measured step cost. */
export interface StepCost {
  /** How long the step ran, from its first change to its end, in milliseconds. */
  readonly durationMs: number;
  /** How many changes the step made, such as seconds streamed. */
  readonly changes: number;
  /** The pushes the page received, by topic. */
  readonly pushes: ReadonlyMap<string, number>;
  readonly reads: ReadTally;
  /** The longest a read of the board or the Inbox took, from request to answer, in milliseconds. */
  readonly longestDeskReadMs: number;
  readonly rendererMainThreadMs: number;
  readonly rendererCpuMs: number;
  readonly controllerCpuMs: number;
}

/** What a scenario needs to measure a step on the open page. */
export interface StepContext {
  readonly page: Inspector;
  readonly collector: Collector;
  readonly fixture: ThreadFixture;
  readonly rendererPid: number;
  readonly inspectorUrl: string;
}

/** Whether a request reads the Work board or a page of the Inbox. */
const isDeskRead = (request: RecordedRequest) =>
  /\/tasks\/board$|\/external-entities\/inbox\/query$/.test(request.url.pathname);

/**
 * Runs `step`, which makes `changes` changes, and returns what the page and
 * the controller spent on it, until the page has been quiet for `QUIET_MS`
 * after the step. The CPU times come from `ps`, and the main thread's from the
 * page's DevTools metrics; each also holds what the process did while idle in
 * that time, so they err high.
 */
export async function measureStep(
  context: StepContext,
  changes: number,
  step: () => Promise<void>,
): Promise<StepCost> {
  const { page, collector, fixture, rendererPid } = context;
  const controllerPid = fixture.readControllerPid();
  const from = collector.checkpoint();
  const before = {
    at: Date.now(),
    mainThread: await readMainThreadMs(page),
    renderer: await readCpuMs(rendererPid),
    controller: await readCpuMs(controllerPid),
  };
  await step();
  await collector.waitForQuietReads(QUIET_MS);
  const recorded = collector.since(from);
  const pushes = new Map<string, number>();
  for (const push of recorded.pushes) pushes.set(push.topic, (pushes.get(push.topic) ?? 0) + 1);
  return {
    durationMs: Date.now() - before.at,
    changes,
    pushes,
    reads: tallyReads(recorded.requests),
    longestDeskReadMs: Math.max(
      0,
      ...recorded.requests.filter(isDeskRead).map((request) => request.durationMs ?? 0),
    ),
    rendererMainThreadMs: (await readMainThreadMs(page)) - before.mainThread,
    rendererCpuMs: (await readCpuMs(rendererPid)) - before.renderer,
    controllerCpuMs: (await readCpuMs(controllerPid)) - before.controller,
  };
}

/** Formats a read tally as "kind: requests (kB)" items, most bytes first. */
function formatTally(tally: ReadTally, per = 1): string {
  if (tally.size === 0) return "none";
  return [...tally]
    .toSorted((a, b) => b[1].bytes - a[1].bytes || b[1].requests - a[1].requests)
    .map(([kind, { requests, bytes }]) => {
      const count = per === 1 ? String(requests) : (requests / per).toFixed(2);
      return bytes === 0
        ? `${kind} ${count}`
        : `${kind} ${count} (${(bytes / per / 1_000).toFixed(1)} kB)`;
    })
    .join("; ");
}

/** Prints the rows of one measured step under `name`, per change when `perChange` names the change. */
export function printStep(name: string, step: StepCost, perChange: string | null): void {
  const per = perChange === null ? 1 : step.changes;
  const unit = perChange === null ? "" : ` a ${perChange}`;
  const pushes = [...step.pushes].map(([topic, count]) => `${topic} ${String(count)}`).join(", ");
  console.log(
    formatTable(
      ["Measure", "Result"],
      [
        ["Step", `${name}: ${String(step.changes)} over ${(step.durationMs / 1_000).toFixed(1)} s`],
        ["Pushes received", pushes === "" ? "none" : pushes],
        [`Reads${unit}`, formatTally(step.reads, per)],
        ["Longest board or Inbox read", `${step.longestDeskReadMs.toFixed(0)} ms`],
        [`Renderer main thread${unit}`, `${(step.rendererMainThreadMs / per).toFixed(1)} ms`],
        [`Renderer CPU${unit}`, `${(step.rendererCpuMs / per).toFixed(0)} ms`],
        [`Controller CPU${unit}`, `${(step.controllerCpuMs / per).toFixed(0)} ms`],
      ],
    ),
  );
  console.log();
}

/** What `traceFrames` measured of one piece of motion. */
export interface FrameCost {
  /** How long the recording ran, from the action to its end, in milliseconds. */
  readonly recordedMs: number;
  /** How many frames the page drew in that time. */
  readonly frames: number;
  /** The usual time between two frames, the median, and the longest, in milliseconds. */
  readonly usualGapMs: number;
  readonly longestGapMs: number;
  /** How many gaps were at least one and a half usual ones: a frame dropped in each. */
  readonly droppedFrames: number;
  /** The style and layout time of the renderer's main thread in a frame: the median of the frames that had any, and the most. */
  readonly usualStyleLayoutMs: number;
  readonly longestStyleLayoutMs: number;
  /** How many frames spent more than 2 ms on style and layout. */
  readonly framesOver2Ms: number;
  /** The longest task of the renderer's main thread in that time, in milliseconds. */
  readonly longestTaskMs: number;
  /** How many animations started, and how many of those the compositor could not run alone. */
  readonly animations: number;
  readonly animationsNotComposited: number;
}

/** The names of the trace events that are style and layout work. */
const STYLE_AND_LAYOUT = new Set(["UpdateLayoutTree", "Layout"]);

/** The mark the page writes into the trace when the recording starts. */
const START_MARK = "perf-work-start";

/**
 * Records a Chromium trace and the page's animation frames on `page` for
 * `recordMs`, running `action` at the start, and returns what the frames
 * cost (see `FrameCost`). A frame's style and layout is the work between two
 * `BeginMainThreadFrame` events of the renderer's main thread. A gap of one
 * and a half usual frames or more counts as a dropped frame. On Linux in a
 * container the GPU process draws on the CPU, so the gaps mean little; the
 * style and layout time is the trustworthy number. Fails when the trace lost
 * events.
 */
export async function traceFrames(
  page: Inspector,
  recordMs: number,
  action: () => Promise<void>,
): Promise<FrameCost> {
  await page.send("Tracing.start", {
    transferMode: "ReturnAsStream",
    traceConfig: {
      includedCategories: [
        TIMELINE_CATEGORY,
        "devtools.timeline",
        "disabled-by-default-devtools.timeline.frame",
        "blink.animations",
      ],
    },
  });
  await page.evaluate("Runtime.evaluate", {
    expression: `(() => {
      const frames = [];
      globalThis.perfWorkFrames = frames;
      const until = performance.now() + ${String(recordMs)};
      console.timeStamp(${JSON.stringify(START_MARK)});
      const record = (at) => {
        frames.push(at);
        if (at < until) requestAnimationFrame(record);
      };
      requestAnimationFrame(record);
    })()`,
    returnByValue: true,
  });
  const startedAt = Date.now();
  await action();
  await sleep(Math.max(0, startedAt + recordMs + 100 - Date.now()));
  await page.send("Tracing.end");
  const events = await readTrace(page);
  const frames = (await page.evaluate("Runtime.evaluate", {
    expression: "globalThis.perfWorkFrames",
    returnByValue: true,
  })) as number[];
  const mark = events.find(
    (event) => event.name === "TimeStamp" && event.args?.data?.message === START_MARK,
  );
  if (mark === undefined) throw new Error("the trace holds no mark of the recording's start");
  const end = mark.ts + recordMs * 1_000;
  const tasks = findRendererMainTasks(events).filter(
    (task) => task.ts + task.dur! >= mark.ts && task.ts <= end,
  );
  const mainThread = `${String(tasks[0]?.pid)}:${String(tasks[0]?.tid)}`;
  const onMain = (event: TraceEvent) => `${String(event.pid)}:${String(event.tid)}` === mainThread;
  const frameStarts = events
    .filter(
      (event) =>
        event.name === "BeginMainThreadFrame" &&
        onMain(event) &&
        event.ts >= mark.ts &&
        event.ts <= end,
    )
    .map((event) => event.ts)
    .toSorted((a, b) => a - b);
  const styleAndLayout = events.filter(
    (event) => STYLE_AND_LAYOUT.has(event.name) && event.ph === "X" && onMain(event),
  );
  const perFrame = frameStarts.map((from, index) => {
    const to = frameStarts[index + 1] ?? end;
    return (
      styleAndLayout
        .filter((event) => event.ts >= from && event.ts < to)
        .reduce((sum, event) => sum + event.dur!, 0) / 1_000
    );
  });
  const busy = perFrame.filter((ms) => ms > 0).toSorted((a, b) => a - b);
  const gaps = frames
    .slice(1)
    .map((at, index) => at - frames[index]!)
    .toSorted((a, b) => a - b);
  const usualGapMs = gaps[Math.floor(gaps.length / 2)] ?? 0;
  const animationStarts = events.filter(
    (event) => event.name === "Animation" && event.ph === "b",
  ) as unknown as { args?: { data?: { compositeFailed?: number } } }[];
  return {
    recordedMs: (frames.at(-1) ?? 0) - (frames[0] ?? 0),
    frames: frames.length,
    usualGapMs,
    longestGapMs: gaps.at(-1) ?? 0,
    droppedFrames: gaps.filter((gap) => gap >= 1.5 * usualGapMs).length,
    usualStyleLayoutMs: busy[Math.floor(busy.length / 2)] ?? 0,
    longestStyleLayoutMs: busy.at(-1) ?? 0,
    framesOver2Ms: busy.filter((ms) => ms > 2).length,
    longestTaskMs: Math.max(0, ...tasks.map((task) => task.dur! / 1_000)),
    animations: animationStarts.length,
    animationsNotComposited: animationStarts.filter(
      (start) => (start.args?.data?.compositeFailed ?? 0) !== 0,
    ).length,
  };
}

/** The screen a launch opens. */
export interface DeskLaunchPlan {
  readonly name: string;
  /** The path the app reopens, such as `/work`. */
  readonly path: string;
  /** An expression that is true in the page once the screen has drawn. */
  readonly drawn: string;
  /** What the Work board's view is set to before the launch: what its lanes group by. */
  readonly groupBy?: string;
}

/** The steps a screen measures after the steps every launch runs. */
export type ScreenSteps = (
  context: StepContext,
  driver: PageDriver,
  fixture: ThreadFixture,
) => Promise<void>;

/** What one launch measured. */
export interface DeskLaunch extends LaunchAtRest {
  readonly plan: DeskLaunchPlan;
  /** How many elements the page held, and how many cards, 13 s after it opened. */
  readonly elements: number;
  readonly cards: number;
  /** The reads the visible and the hidden idle samples saw, from the page's resource timing. */
  readonly idleReads: {
    readonly visible: ReadonlyMap<string, number>;
    readonly hidden: ReadonlyMap<string, number>;
  };
  /** The reads the page made as it loaded again, and the live topics it held then. */
  readonly load: StepCost;
  readonly heldTopics: readonly string[];
  readonly quiet: StepCost;
  readonly streaming: StepCost;
  readonly hiddenStreaming: StepCost;
  readonly shownAgain: StepCost;
  readonly newThread: StepCost;
}

/**
 * Stores `plan.path` as the last screen, and the Work view `plan.groupBy`
 * asks for, so the next launch opens that screen drawn that way (see
 * `openScreenOnce`). The view is stored under the key the board reads it
 * from (`buildWorkViewKey`): one per controller and user. Fails when the
 * screen does not draw within 30 s.
 */
export async function openDeskScreenOnce(userDataDir: string, plan: DeskLaunchPlan): Promise<void> {
  const { controllerUrl } = readSettings(userDataDir) as { readonly controllerUrl: string };
  await openScreenOnce(userDataDir, plan.path, async (page: Page) => {
    await page.evaluate(
      ([key, groupBy]) => {
        const saved = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, unknown>;
        localStorage.setItem(key, JSON.stringify({ ...saved, groupBy }));
      },
      [`work-view:${controllerUrl}:${USERNAME}`, plan.groupBy ?? "project"] as const,
    );
    let shown = "";
    await pollUntil(
      async () => {
        shown = await page.evaluate(
          `document.querySelectorAll("[data-card-id]").length + " cards, " + document.title`,
        );
        return (await page.evaluate(plan.drawn)) === true ? true : undefined;
      },
      {
        timeoutMs: 30_000,
        intervalMs: 100,
        timeoutMessage: () => `${plan.name}: the screen did not draw; it shows ${shown}`,
      },
    );
  });
}

/** An expression that evaluates, in the page, to the URLs of its reads that began between two times, in ms since the epoch. */
const buildReadsBetween = (from: number, to: number) => `performance
  .getEntriesByType("resource")
  .filter((entry) => {
    const at = performance.timeOrigin + entry.startTime;
    return entry.name.startsWith("http") && at >= ${String(from)} && at < ${String(to)};
  })
  .map((entry) => entry.name)`;

/** Counts reads known only by their URL, by kind. */
function countUrls(urls: readonly string[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const url of urls) {
    const kind = classifyRequest({
      method: "GET",
      url: new URL(url),
      startedAtMs: 0,
      durationMs: 0,
      firstByteMs: null,
      bodyBytes: 0,
    });
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return counts;
}

/**
 * The threads the new-Thread step spawned. The fixture cannot play a turn into
 * them, because it did not spawn them, so no later step streams into one.
 */
const spawnedThreadIds = new Set<string>();

/**
 * Returns `count` idle threads of the fixture's own runners, which the fixture
 * can stream into, leaving out any thread whose id is in `path`: the thread a
 * launch has open would draw the stream, which the screens measured do not.
 */
async function findIdleThreads(
  fixture: ThreadFixture,
  count: number,
  path: string,
): Promise<string[]> {
  const fixtureRunners = new Set(fixture.runners.slice(0, 2).map((runner) => runner.runnerId));
  const { items } = await fixture.call<{ readonly items: readonly Session[] }>(
    "GET",
    "/sessions?kind=thread&status=idle&archived=false&limit=500",
  );
  const threads = items
    .filter(
      (each) =>
        fixtureRunners.has(each.runnerId ?? "") &&
        !path.includes(each.id) &&
        !spawnedThreadIds.has(each.id),
    )
    .slice(0, count);
  if (threads.length < count)
    throw new Error(`the fixture has ${String(threads.length)} idle threads, not ${String(count)}`);
  return threads.map((thread) => thread.id);
}

/**
 * Sends the idle thread `sessionId` a question, which opens a turn, and plays
 * an answer into it for `forMs`: text at full speed, with a usage report after
 * each second of it, as a harness reports its token counts while it writes.
 * Resolves once the turn has completed and the thread is idle again.
 */
async function streamWithUsage(fixture: ThreadFixture, sessionId: string, forMs: number) {
  const seconds = Math.round(forMs / 1_000);
  const steps = Array.from({ length: seconds }, (_, second) => [
    { kind: "stream" as const, forMs: 1_000 },
    {
      kind: "usage" as const,
      usage: { inputTokens: 20_000 + 1_000 * second, outputTokens: 400 * (second + 1) },
    },
  ]).flat();
  const { played } = await fixture.playTurn(sessionId, "Write up the change.", [
    ...steps,
    { kind: "end", state: "completed" },
  ]);
  await played;
  await pollUntil(
    async () =>
      (await fixture.call<Session>("GET", `/sessions/${sessionId}`)).status === "idle"
        ? true
        : undefined,
    // Four agents writing at full speed leave the controller a backlog of
    // events, so the last turn can end some seconds after the script does.
    {
      timeoutMs: 60_000,
      intervalMs: 100,
      timeoutMessage: `thread ${sessionId} never became idle within 60 s of its script's end`,
    },
  );
}

/**
 * Starts the signed-in app on `userDataDir` as a plain process, warm, on the
 * screen `plan` names, and measures it as the top of this file describes,
 * with `screenSteps` last. Fails when the screen does not draw, when a step
 * does not end within its time, or when the app does not quit cleanly.
 */
export async function measureDeskLaunch(
  userDataDir: string,
  fixture: ThreadFixture,
  plan: DeskLaunchPlan,
  screenSteps: ScreenSteps | null,
): Promise<DeskLaunch> {
  await warmUpApp(userDataDir);
  const loadAtSpawn = loadavg()[0]!;
  const app = await launchPlainApp(userDataDir);
  const { inspectorUrl } = app;
  let measured: DeskLaunch;
  try {
    const pageSocketUrl = await waitForPageSocketUrl(app.endpoint);
    const pageOpenedAt = Date.now();
    const sleepUntil = (msAfterOpen: number) =>
      sleep(Math.max(0, pageOpenedAt + msAfterOpen - Date.now()));
    await sleepUntil(MEMORY_READ_AT_MS);
    const memory: readonly ProcessMemory[] = await readProcessMemory(app.process.pid!);
    const rendererPid = findRendererPid(memory);
    await sleepUntil(VISIBLE_SAMPLE_AT_MS);
    logStep(`${plan.name}: memory read, idle samples start`);
    const samples = await sampleVisibleAndHidden(inspectorUrl, VISIBLE_SAMPLE_MS);
    logStep("idle samples done; attaching");

    const page = await connectInspector(pageSocketUrl);
    let collector: Collector | undefined;
    try {
      const driver = drivePage(page);
      if (!(await driver.evaluate<boolean>(plan.drawn))) {
        throw new Error(`${plan.name}: the screen was not drawn when it was sampled`);
      }
      const { elements, cards } = await driver.evaluate<{ elements: number; cards: number }>(
        `({ elements: document.querySelectorAll("*").length, cards: document.querySelectorAll("[data-card-id]").length })`,
      );
      const fires = await countAgeClockFires(page, samples);
      const idleReads = {
        visible: countUrls(
          await driver.evaluate<string[]>(
            buildReadsBetween(samples.visibleFrom, samples.visibleTo),
          ),
        ),
        hidden: countUrls(
          await driver.evaluate<string[]>(buildReadsBetween(samples.hiddenFrom, samples.hiddenTo)),
        ),
      };
      collector = await startCollector(pageSocketUrl);
      await page.send("Performance.enable");
      await page.send("Page.enable");
      const context: StepContext = { page, collector, fixture, rendererPid, inspectorUrl };
      // The page subscribed and made its first reads before the collector was
      // on, so it loads again with the collector watching.
      const load = await measureStep(context, 1, async () => {
        await page.send("Page.reload");
        await page.waitForEvent("Page.loadEventFired");
        await driver.waitFor(
          plan.drawn,
          `${plan.name}: the screen did not draw after the reload`,
          30_000,
        );
        await sleep(2_000);
      });
      const heldTopics = collector.listHeldTopics();
      const quiet = await measureStep(context, 10, () => sleep(10_000));

      logStep("loaded again; agents stream");
      const busy = await findIdleThreads(fixture, BUSY_AGENTS + 2, plan.path);
      const streaming = await measureStep(context, STREAM_MS / 1_000, async () => {
        await Promise.all(
          busy.slice(0, BUSY_AGENTS).map((id) => streamWithUsage(fixture, id, STREAM_MS)),
        );
      });
      await callWindow(inspectorUrl, "hide");
      await driver.waitFor(`document.visibilityState === "hidden"`, "the page never became hidden");
      const hiddenStreaming = await measureStep(context, HIDDEN_STREAM_MS / 1_000, async () => {
        await Promise.all(
          busy
            .slice(BUSY_AGENTS, BUSY_AGENTS + 2)
            .map((id) => streamWithUsage(fixture, id, HIDDEN_STREAM_MS)),
        );
      });
      const shownAgain = await measureStep(context, 1, async () => {
        await callWindow(inspectorUrl, "showInactive");
        await driver.waitFor(
          `document.visibilityState === "visible"`,
          "the page never became visible",
        );
        await sleep(1_000);
      });

      logStep("streaming done; a new Thread");
      const studio = fixture.runners[0]!;
      let spawned: Session | undefined;
      const newThread = await measureStep(context, 1, async () => {
        [spawned] = await fixture.spawnThreads(1, { runner: studio });
        spawnedThreadIds.add(spawned!.id);
        await sleep(3_000);
      });
      await pollUntil(
        async () =>
          (await fixture.call<Session>("GET", `/sessions/${spawned!.id}`)).status === "busy"
            ? true
            : undefined,
        { timeoutMs: 10_000, intervalMs: 50, timeoutMessage: "the new thread never started" },
      );
      studio.completeTurn(spawned!.id);
      await pollUntil(
        async () =>
          (await fixture.call<Session>("GET", `/sessions/${spawned!.id}`)).status === "idle"
            ? true
            : undefined,
        { timeoutMs: 10_000, intervalMs: 50, timeoutMessage: "the new thread never became idle" },
      );
      await collector.waitForQuietReads(QUIET_MS);

      logStep("the screen's own steps");
      if (screenSteps !== null) await screenSteps(context, driver, fixture);

      measured = {
        plan,
        loadAtSpawn,
        memory,
        visible: samples.visible,
        visibleMs: samples.visibleTo - samples.visibleFrom,
        hidden: samples.hidden,
        ...fires,
        elements,
        cards,
        idleReads,
        load,
        heldTopics,
        quiet,
        streaming,
        hiddenStreaming,
        shownAgain,
        newThread,
      };
    } finally {
      collector?.close();
      page.close();
    }
  } finally {
    await stopPlainApp(app);
  }
  assertExitedCleanly(app.process);
  return measured;
}

/** Prints what one launch measured. Its screen's own steps printed as they ran. */
export function reportDeskLaunch(measured: DeskLaunch): void {
  printLaunch(
    `## ${measured.plan.name} (load ${measured.loadAtSpawn.toFixed(1)})`,
    measured,
    buildAtRestRows(measured, "recorded: a time label on screen may change"),
  );
  const formatCounts = (counts: ReadonlyMap<string, number>) =>
    counts.size === 0
      ? "none"
      : [...counts].map(([kind, count]) => `${kind} ${String(count)}`).join("; ");
  console.log(
    formatTable(
      ["Measure", "Result"],
      [
        [
          "Elements on the page, and cards",
          `${String(measured.elements)}, ${String(measured.cards)}`,
        ],
        ["Reads while visible, 60 s, nothing happening", formatCounts(measured.idleReads.visible)],
        ["Reads while hidden, 10 s", formatCounts(measured.idleReads.hidden)],
        ["Live topics held after the reload", measured.heldTopics.join(", ")],
      ],
    ),
  );
  console.log();
  printStep("the page loaded again", measured.load, null);
  printStep("10 s of quiet, attached", measured.quiet, null);
  printStep(
    `${String(BUSY_AGENTS)} agents streaming, window visible`,
    measured.streaming,
    "second",
  );
  printStep("2 agents streaming, window hidden", measured.hiddenStreaming, "second");
  printStep("the window shown again", measured.shownAgain, null);
  printStep("a new Thread spawned", measured.newThread, null);
}

/** Presses `key` with the modifiers `modifiers` (CDP's bits: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift), down and then up. */
export async function pressKeyWith(page: Inspector, key: string, code: string, modifiers: number) {
  for (const type of ["rawKeyDown", "keyUp"]) {
    await page.send("Input.dispatchKeyEvent", {
      type,
      key,
      code,
      modifiers,
      windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
    });
  }
}

/** Returns the centre of the element `element`, an expression, evaluates to, or fails. */
async function findCentre(driver: PageDriver, element: string) {
  const box = await driver.evaluate<{ x: number; y: number } | null>(`(() => {
    const element = ${element};
    if (!element) return null;
    element.scrollIntoView({ block: "center", inline: "center" });
    const box = element.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  })()`);
  if (box === null) throw new Error(`no element for ${element}`);
  return box;
}

/** Clicks with the pointer at `at`: moves there, presses and lets go. */
async function clickAt(page: Inspector, at: { x: number; y: number }): Promise<void> {
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await page.send("Input.dispatchMouseEvent", { type, ...at, button: "left", clickCount: 1 });
  }
}

/**
 * Presses the pointer on `from`, moves it in `steps` steps of a frame each
 * to `to`, and lets go, as a hand drags: the first steps go a little way, so
 * the board lifts what is pressed.
 */
async function dragPointer(
  page: Inspector,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps: number,
) {
  const send = (type: string, at: { x: number; y: number }) =>
    page.send("Input.dispatchMouseEvent", {
      type,
      ...at,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...from });
  await send("mousePressed", from);
  for (let step = 1; step <= 4; step += 1) {
    await send("mouseMoved", { x: from.x + 3 * step, y: from.y + 3 * step });
    await sleep(16);
  }
  for (let step = 1; step <= steps; step += 1) {
    const share = step / steps;
    await send("mouseMoved", {
      x: from.x + 12 + (to.x - from.x - 12) * share,
      y: from.y + 12 + (to.y - from.y - 12) * share,
    });
    await sleep(16);
  }
  await send("mouseReleased", to);
}

/** Prints a line that says how far a launch has come, with the time, so a failed run shows where it stopped. */
export const logStep = (what: string): void => {
  console.log(`· ${new Date().toISOString().slice(11, 19)} ${what}`);
};

/** Returns the proportional set size of the process `pid` in MB, from `/proc/<pid>/smaps_rollup`. Linux only. */
async function readPssMb(pid: number): Promise<number> {
  const rollup = await readFile(`/proc/${String(pid)}/smaps_rollup`, "utf8");
  const kilobytes = /^Pss:\s+(\d+) kB$/m.exec(rollup)?.[1];
  if (kilobytes === undefined) throw new Error(`no Pss line in the smaps_rollup of ${String(pid)}`);
  return Number(kilobytes) / 1_000;
}

/** An expression that is true in the page once Work's board has drawn its lanes. */
const WORK_DRAWN = `document.querySelectorAll(".work-desk [data-card-id]").length >= 50`;

/**
 * Work's own steps, after the steps every launch runs: what each changes
 * reads, and how each motion draws (see `traceFrames`). Each motion is
 * printed as it is measured.
 */
function buildWorkSteps(seeded: SeededWork): ScreenSteps {
  return async (context, driver, fixture) => {
    const { page } = context;
    const settle = async () => {
      await driver.waitForAnimationsToEnd(8_000).catch(() => undefined);
      await context.collector.waitForQuietReads(QUIET_MS);
    };

    // A burst of summaries: 20 Tasks renamed at once, so each is due for a
    // summary, and the writer then writes them, each a `task` push.
    const renamed = seeded.taskIds.slice(200, 200 + SUMMARY_BURST);
    await Promise.all(
      renamed.map((id, index) =>
        fixture.call("PATCH", `/tasks/${id}`, {
          title: `Renamed for the summary burst ${String(index + 1)}`,
        }),
      ),
    );
    await settle();
    const summaries = await measureStep(context, SUMMARY_BURST, () => sleep(SUMMARY_WAIT_MS));
    printStep(
      `a burst of ${String(SUMMARY_BURST)} summaries written, 45 s after the renames`,
      summaries,
      null,
    );

    // A stage change of a Task with neighbours, and a blocker added.
    const moved = await measureStep(context, 1, async () => {
      // The first Task is in Exploring, so the move changes its stage.
      await fixture.call("POST", `/tasks/${seeded.taskIds[0]!}/move`, { stage: "building" });
      // The controller collects `task` pushes for a second before it sends them.
      await sleep(PUSH_WINDOW_MS);
    });
    printStep("one Task moved to Building through the API", moved, null);
    const blocked = await measureStep(context, 1, async () => {
      await fixture.call("POST", `/tasks/${seeded.taskIds[11]!}/blockers`, {
        blockedByTaskId: seeded.taskIds[12]!,
      });
      await sleep(PUSH_WINDOW_MS);
    });
    printStep("one blocker added through the API", blocked, null);
    await settle();

    // A drag: the first card of the first lane's Exploring cell, to its Building cell.
    const firstCell = `document.querySelector(".work-desk .board-cell[data-stage='exploring'] [data-card-id]")`;
    const laneId = await driver.evaluate<string>(
      `${firstCell}.closest(".board-cell").dataset.laneId`,
    );
    const from = await findCentre(driver, firstCell);
    const to = await findCentre(
      driver,
      `document.querySelector(".work-desk .board-cell[data-lane-id='${laneId}'][data-stage='building']")`,
    );
    const drag = await traceFrames(page, 2_000, () => dragPointer(page, from, to, 40));
    printFrames("Dragging a card to another stage", drag);
    await settle();

    const cellsBefore = await driver.evaluate<number>(
      `document.querySelectorAll("[data-card-id]").length`,
    );
    const openCell = await traceFrames(page, 1_200, () =>
      driver.click(`document.querySelector(".work-desk .board-more")`),
    );
    const cellsAfter = await driver.evaluate<number>(
      `document.querySelectorAll("[data-card-id]").length`,
    );
    printFrames(
      `Opening a cell (cards on the page ${String(cellsBefore)} to ${String(cellsAfter)})`,
      openCell,
    );
    await settle();

    // Every cell opened, with the renderer's memory before and after. A tool
    // is attached, so both readings err high by the same amount.
    const pssBefore = await readPssMb(context.rendererPid);
    const elementsBefore = await driver.evaluate<number>(`document.querySelectorAll("*").length`);
    await driver.evaluate(`(() => {
      for (const more of document.querySelectorAll(".work-desk .board-more[aria-expanded='false']")) more.click();
    })()`);
    await settle();
    await sleep(2_000);
    const pssAfter = await readPssMb(context.rendererPid);
    const elementsAfter = await driver.evaluate<number>(`document.querySelectorAll("*").length`);
    const cardsAfter = await driver.evaluate<number>(
      `document.querySelectorAll("[data-card-id]").length`,
    );
    console.log(
      `Opening every cell: ${String(cellsAfter)} to ${String(cardsAfter)} cards, ${String(elementsBefore)} to ${String(elementsAfter)} elements; ` +
        `the renderer's PSS ${pssBefore.toFixed(1)} to ${pssAfter.toFixed(1)} MB, attached\n`,
    );

    // The click lands where the card is on screen, so the card is scrolled into view first.
    await driver.pressKey("Escape");
    const cardAt = await findCentre(
      driver,
      `document.querySelector(".work-desk .board-cell[data-stage='planned'] [data-card-id]")`,
    );
    await settle();
    let paneFrames: FrameCost | undefined;
    const pane = await measureStep(context, 1, async () => {
      paneFrames = await traceFrames(page, 1_500, () => clickAt(page, cardAt));
      await driver.waitFor(
        `document.querySelector('[role="dialog"]') !== null`,
        "the details pane did not open",
      );
      await sleep(PUSH_WINDOW_MS);
    });
    printFrames("Opening the details pane", paneFrames!);
    printStep("the reads of opening the pane", pane, null);
    await driver.pressKey("Escape");
    await settle();

    // Every lane folded with Shift+F, then opened again.
    await driver.evaluate(`document.activeElement?.blur()`);
    const fold = await traceFrames(page, 1_500, () => pressKeyWith(page, "F", "KeyF", 8));
    printFrames("Folding every lane (Shift+F)", fold);
    await settle();
    const unfold = await traceFrames(page, 1_500, () => pressKeyWith(page, "F", "KeyF", 8));
    printFrames("Opening every lane again (Shift+F)", unfold);
    await settle();

    const toggle = `document.querySelector(".initiative-toggle")`;
    if (await driver.evaluate<boolean>(`${toggle} !== null`)) {
      const openRow = await traceFrames(page, 1_500, () => driver.click(toggle));
      printFrames("Opening an Initiative's row", openRow);
      await settle();
      const bead = `document.querySelector("[data-bead-task-id]")`;
      if (await driver.evaluate<boolean>(`${bead} !== null`)) {
        const beadAt = await findCentre(driver, bead);
        const slide = await traceFrames(page, 2_000, () =>
          dragPointer(page, beadAt, { x: beadAt.x + 160, y: beadAt.y }, 30),
        );
        printFrames("Sliding a bead along its Initiative's line", slide);
        await settle();
      } else {
        console.log("No bead was on screen to slide.\n");
      }
      await driver.click(toggle);
      await settle();
    } else {
      console.log("No Initiative's row was on screen to open.\n");
    }

    // To the Office and back, with nothing changed meanwhile.
    const office = await measureStep(context, 1, async () => {
      await pressKeyWith(page, "1", "Digit1", 2);
      await driver.waitFor(
        `document.querySelector(".work-desk") === null`,
        "the Office did not open",
      );
      await sleep(1_500);
      await pressKeyWith(page, "2", "Digit2", 2);
      await driver.waitFor(WORK_DRAWN, "Work did not draw again", 20_000);
    });
    printStep("to the Office and back to Work (Ctrl+1, Ctrl+2)", office, null);
    await settle();

    // The morning replay: Work closes, cards change stage, Work opens again.
    await pressKeyWith(page, "1", "Digit1", 2);
    await driver.waitFor(
      `document.querySelector(".work-desk") === null`,
      "the Office did not open",
    );
    for (const [index, id] of seeded.taskIds.slice(20, 20 + REPLAY_CHANGES).entries()) {
      await fixture.call("POST", `/tasks/${id}/move`, {
        stage: index % 2 === 0 ? "landed" : "in-review",
      });
    }
    await sleep(1_500);
    const replay = await traceFrames(page, 8_000, async () => {
      await pressKeyWith(page, "2", "Digit2", 2);
    });
    printFrames(`The morning replay of ${String(REPLAY_CHANGES)} changes`, replay);
    await settle();
  };
}

/** Steps of the large board: Find typed, which lifts the row limit of every cell. */
const measureFind: ScreenSteps = async (context, driver) => {
  const { page } = context;
  await driver.evaluate(`document.activeElement?.blur()`);
  await driver.pressKey("/");
  await driver.waitFor(
    `document.activeElement?.tagName === "INPUT"`,
    "the Find box did not take the focus",
  );
  const before = await driver.evaluate<number>(
    `document.querySelectorAll("[data-card-id]").length`,
  );
  const find = await traceFrames(page, 2_000, async () => {
    await page.send("Input.insertText", { text: "the" });
  });
  const after = await driver.evaluate<number>(`document.querySelectorAll("[data-card-id]").length`);
  printFrames(
    `Typing "the" into Find (cards on the page ${String(before)} to ${String(after)})`,
    find,
  );
  await driver.pressKey("Escape");
};

/**
 * Measures Work (see the top of this file): seeds the board, then measures a
 * thread open, Work grouped by Project, Work grouped by repository, and Work
 * at 1,000 Tasks. Each launch starts from a fresh `prepareLaunch`, because a
 * streamed turn makes its thread's age recent.
 */
export async function measureWork(fixture: ThreadFixture, userDataDir: string): Promise<void> {
  const seeded = await seedWork(fixture);
  const writeDatabase = buildWorkDatabaseWrite(seeded);
  const threadId = await findIdleThreadId(fixture);
  const measure = async (plan: DeskLaunchPlan, steps: ScreenSteps | null) => {
    await fixture.prepareLaunch({ twoMinuteRow: false, writeDatabase });
    await openDeskScreenOnce(userDataDir, plan);
    reportDeskLaunch(await measureDeskLaunch(userDataDir, fixture, plan, steps));
  };
  await measure(
    {
      name: "a thread open, to compare with",
      path: `/threads/${threadId}`,
      drawn: `document.querySelector('[aria-label="Transcript"]') !== null`,
    },
    null,
  );
  await measure(
    {
      name: `Work by Project, ${String(WORK_TASKS)} Tasks and the threads'`,
      path: "/work",
      drawn: WORK_DRAWN,
    },
    buildWorkSteps(seeded),
  );
  await measure(
    {
      name: `Work by repository, ${String(WORK_TASKS)} Tasks and the threads'`,
      path: "/work",
      drawn: WORK_DRAWN,
      groupBy: "github/repository",
    },
    null,
  );
  await growWork(fixture, seeded);
  await measure(
    {
      name: `Work by Project, ${String(LARGE_BOARD_TASKS)} Tasks and the threads'`,
      path: "/work",
      drawn: WORK_DRAWN,
    },
    measureFind,
  );
}
