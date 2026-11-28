/**
 * The desktop perf script's Fleet scenario: what the Fleet screens cost, row by
 * row of spec 17 §What Fleet costs.
 *
 * The seed (see `seedFleet` and `buildFleetDatabaseWrite`):
 *
 * - six machines: the fixture's "studio" and "laptop", which hold its
 *   threads, three more scripted runners, "nimbus", "mini" and "beelink", and
 *   the controller's own runner;
 * - 14 days of Runner Metrics for every machine, one row a minute, written
 *   into the database, because no operation writes history. Nimbus's free disk
 *   falls steadily, so its forecast shows and it needs the user;
 * - on nimbus, six Threads, each in its own ephemeral workspace, stopped, four
 *   of them Done, whose workspaces were last used 8 days ago, so the cleanup
 *   dialog lists them; and 1,994 more workspaces with disk usage, so nimbus
 *   reports the most entries one `DiskUsageReport` may hold, 2,000.
 *
 * Each measured launch (see `measureFleetLaunch`) reads, in this order:
 *
 * 1. With nothing attached: each process's memory 13 s after the page opens,
 *    then each process's CPU and wakeups over 60 s with the window visible
 *    and over 10 s hidden. One scripted runner reports its Runner Metrics
 *    every 12 s during both, so each of the five reports once a minute, as a
 *    real runner does, and the samples hold the nudges that follow.
 * 2. Attached, with the page loaded again under a network collector (see
 *    `perf-collector.ts`): what the page reads as it opens, and the live
 *    topics it holds.
 * 3. Ten Runner Metrics reports, a second apart: the reads each causes, their
 *    bytes, and the renderer's main thread time.
 * 4. A turn that streams for 10 s into an idle thread, with a usage report
 *    each second (see `streamWithUsage`): the `session` pushes,
 *    the reads they cause by kind and their bytes, per second, and the
 *    renderer's main thread and CPU time. Then the same for 5 s with the
 *    window hidden, and the reads that showing the window again causes.
 * 5. On some launches: a `DiskUsageReport` from nimbus with 50 of its 2,000
 *    entries changed, and the reads that follow; a machine's Activity page
 *    opened from its Recent section; or the cleanup dialog opened and its
 *    Archive and remove pressed.
 *
 * The launches: the new-thread screen, to compare with; the Fleet page; a
 * machine's page, studio's, which runs half the threads; the Fleet page again
 * with about 500 open sessions; and nimbus's page, for the cleanup.
 *
 * It runs on plain Node, like the perf script, so its imports name the `.ts`
 * file.
 */
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { loadavg } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "playwright";
import type { Runner, Session } from "../../../packages/contract/src/index";
import type {
  RunnerDiskUsageReport,
  WorkspaceDiskUsageEntry,
} from "../../../packages/protocol/src/index";
import {
  assertExitedCleanly,
  connectInspector,
  formatTable,
  launchPlainApp,
  stopPlainApp,
  type Inspector,
} from "./packaged-app.ts";
import { startCollector, type Collector, type RecordedRequest } from "./perf-collector.ts";
import type { ThreadFixture } from "./perf-fixture.ts";
import {
  MEMORY_READ_AT_MS,
  VISIBLE_SAMPLE_AT_MS,
  drivePage,
  openScreenOnce,
  readCpuMs,
  readProcessMemory,
  waitForPageSocketUrl,
  warmUpApp,
  type PageDriver,
  type ProcessMemory,
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
import { pollUntil } from "./poll.ts";
import type { ScriptedRunner } from "./scripted-runner.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const GB = 1_000_000_000;
const GIB = 1024 ** 3;

/** How many days of Runner Metrics the seed writes: the controller's default retention. */
const HISTORY_DAYS = 14;

/** Each scripted machine's disk and memory. */
const DISK_TOTAL_BYTES = 1_000 * GB;
const MEMORY_TOTAL_BYTES = 64 * GIB;

/**
 * Nimbus's free disk 14 days ago and now. It falls by about 14 GB a day, so
 * it reaches the default disk limit, 10 GiB, in about 13 days, and the
 * forecast makes nimbus need the user.
 */
const NIMBUS_FREE_THEN_BYTES = 400 * GB;
const NIMBUS_FREE_NOW_BYTES = 200 * GB;

/** Every other machine's free disk, which stays level. */
const LEVEL_FREE_BYTES = 600 * GB;

/** How many Threads on nimbus the cleanup dialog lists, and how many of them are Done. */
const CLEANUP_THREADS = 6;
const CLEANUP_DONE = 4;

/** How long ago the cleanup's workspaces were last used: idle, for the dialog, which lists those idle for 7 days. */
const CLEANUP_IDLE_MS = 8 * DAY_MS;

/** How many entries nimbus's disk usage report holds: the most one report may list (`MAX_MEASURED_WORKSPACES`). */
const REPORTED_WORKSPACES = 2_000;

/** How many entries of the report change in the measured report. */
const CHANGED_ENTRIES = 50;

/** When the seeded workspaces were measured, and last used: a day ago, so they are not idle. */
const SEEDED_WORKSPACE_AGE_MS = DAY_MS;

/** How long the visible idle sample lasts, so each scripted machine reports once in it. */
const VISIBLE_SAMPLE_MS = 60_000;

/** How far apart the scripted machines' reports are during the idle samples: each of five reports once a minute. */
const IDLE_REPORT_INTERVAL_MS = 12_000;

/** How many Runner Metrics reports are measured one at a time, and how far apart. */
const NUDGE_COUNT = 10;
const NUDGE_INTERVAL_MS = 1_000;

/** How long the measured turn streams with the window visible, and then hidden. */
const STREAM_MS = 10_000;
const HIDDEN_STREAM_MS = 5_000;

/** How long the page must be without a request or a push before a measured step counts as over. */
const QUIET_MS = 500;

/**
 * The machines the scenario enlists beside the fixture's two. Each measures
 * disk usage, as a current runner does. No name may be a real machine's: the
 * controller's own runner takes the host's name, such as "atlas", and the
 * controller refuses a second runner of the same name.
 */
const EXTRA_MACHINES = ["nimbus", "mini", "beelink"] as const;

/** What the seed made, for the launches to open, report and clean up. */
export interface SeededFleet {
  /** The five scripted runners: studio and laptop, then nimbus, mini and beelink. */
  readonly runners: readonly ScriptedRunner[];
  /** The scripted runner nimbus. */
  readonly nimbus: ScriptedRunner;
  /** The workspaces of nimbus's six stopped Threads, which the cleanup dialog lists. */
  readonly cleanupWorkspaceIds: readonly string[];
  /** Each entry nimbus reports, by workspace, as the controller holds it; a measured report changes some. */
  readonly reported: Map<string, WorkspaceDiskUsageEntry>;
}

/** Converts a UUID as text to the 16 bytes the controller stores it as. */
const uuidToBytes = (id: string): Uint8Array => Buffer.from(id.replaceAll("-", ""), "hex");

/** Converts 16 stored bytes back to a UUID as text. */
const bytesToUuid = (bytes: Uint8Array): string => {
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * Builds a UUID of version 7 for the time `atMs`, as the controller makes its
 * ids: the contract refuses any other version.
 */
function buildUuidV7(atMs: number): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(atMs, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

/** Returns what one Runner Metrics report of the machine `index` says now: its disk, memory and CPU. */
function buildMetrics(index: number, isNimbus: boolean) {
  const swing = Math.sin(Date.now() / 600_000 + index);
  return {
    diskFreeBytes: isNimbus ? NIMBUS_FREE_NOW_BYTES : LEVEL_FREE_BYTES,
    availableMemoryBytes: Math.round(MEMORY_TOTAL_BYTES * (0.45 + 0.1 * swing)),
    cpu: { averagePercent: 20 + 10 * swing, peakPercent: 60 + 20 * swing },
  };
}

/**
 * Enlists nimbus, mini and beelink, and makes nimbus's six Threads: each in a
 * workspace of its own, stopped once its first turn ends, four of them marked
 * Done. Returns what the launches need. Fails when a call is refused or a
 * Thread does not reach its state.
 */
export async function seedFleet(fixture: ThreadFixture): Promise<SeededFleet> {
  const extra: ScriptedRunner[] = [];
  for (const name of EXTRA_MACHINES) {
    extra.push(
      await fixture.enlistRunner(name, {
        machine: {
          totalMemoryBytes: MEMORY_TOTAL_BYTES,
          diskTotalBytes: DISK_TOTAL_BYTES,
          measuresDiskUsage: true,
        },
      }),
    );
  }
  const nimbus = extra[0]!;
  const threads: Session[] = [];
  for (let index = 0; index < CLEANUP_THREADS; index += 1) {
    threads.push(
      ...(await fixture.spawnThreads(1, {
        runner: nimbus,
        workspace: { kind: "ephemeral", checkouts: [] },
      })),
    );
  }
  const readThread = (id: string) => fixture.call<Session>("GET", `/sessions/${id}`);
  const waitForStatus = async (id: string, status: Session["status"]) => {
    for (let tries = 0; (await readThread(id)).status !== status; tries += 1) {
      if (tries > 200) throw new Error(`thread ${id} never became ${status}`);
      await sleep(50);
    }
  };
  for (const thread of threads) {
    await waitForStatus(thread.id, "busy");
    nimbus.completeTurn(thread.id);
    await waitForStatus(thread.id, "idle");
    await fixture.call("POST", `/sessions/${thread.id}/stop`, {});
    await waitForStatus(thread.id, "exited");
  }
  await fixture.call("POST", "/sessions/mark-done", {
    sessionIds: threads.slice(0, CLEANUP_DONE).map((thread) => thread.id),
  });
  const cleanupWorkspaceIds = await Promise.all(
    threads.map(async (thread) => (await readThread(thread.id)).workspaceId!),
  );
  return { runners: fixture.runners, nimbus, cleanupWorkspaceIds, reported: new Map() };
}

/**
 * Returns the function `prepareLaunch` runs on the stopped controller's
 * database for the Fleet launches. It writes:
 *
 * - 14 days of Runner Metrics, one row a minute up to the minute before now,
 *   for every machine, replacing what is there;
 * - the cleanup's workspaces last used 8 days ago;
 * - the first time only, the workspaces that take nimbus's report to 2,000
 *   entries: copies of the first cleanup workspace, each with its own id, a
 *   size, and a last use a day ago. `seeded.reported` then holds every entry.
 */
export function buildFleetDatabaseWrite(seeded: SeededFleet): (database: DatabaseSync) => void {
  return (database) => {
    const nowMinute = Date.now() - (Date.now() % MINUTE_MS);
    const historyMinutes = HISTORY_DAYS * 24 * 60;
    const runners = database
      .prepare("SELECT id, name FROM runners WHERE lifecycle = 'active' ORDER BY id")
      .all() as { id: Uint8Array; name: string }[];
    const writeHistory = database.prepare(`
      WITH RECURSIVE m(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM m WHERE i < ?)
      INSERT OR REPLACE INTO runner_metrics
        (runner_id, minute, disk_free_bytes, available_memory_bytes, cpu_average_percent,
         cpu_peak_percent, sessions_running, sessions_queued)
      SELECT ?, ? - i * 60000,
             CAST(? + (? - ?) * i / ? AS INTEGER),
             CAST(? * (0.45 + 0.1 * sin(i / 10.0 + ?)) AS INTEGER),
             20 + 10 * sin(i / 10.0 + ?),
             60 + 20 * sin(i / 10.0 + ?),
             ?, 0
      FROM m`);
    database.exec("BEGIN");
    for (const [index, runner] of runners.entries()) {
      const isNimbus = runner.name === "nimbus";
      const freeNow = isNimbus ? NIMBUS_FREE_NOW_BYTES : LEVEL_FREE_BYTES;
      const freeThen = isNimbus ? NIMBUS_FREE_THEN_BYTES : LEVEL_FREE_BYTES;
      writeHistory.run(
        historyMinutes,
        runner.id,
        nowMinute,
        freeNow,
        freeThen,
        freeNow,
        historyMinutes,
        MEMORY_TOTAL_BYTES,
        index,
        index,
        index,
        runner.name === "studio" || runner.name === "laptop" ? 24 : 0,
      );
    }
    const lastUsed = database.prepare("UPDATE workspaces SET last_used_at = ? WHERE id = ?");
    for (const id of seeded.cleanupWorkspaceIds) {
      lastUsed.run(new Date(Date.now() - CLEANUP_IDLE_MS).toISOString(), uuidToBytes(id));
    }
    if (seeded.reported.size === 0) copyWorkspaces(database, seeded);
    database.exec("COMMIT");
  };
}

/**
 * Inserts the copies of the first cleanup workspace that take nimbus to
 * `REPORTED_WORKSPACES` workspaces, and records every entry of nimbus's report
 * in `seeded.reported`: the cleanup's workspaces not measured yet, each copy
 * measured a day ago at a size of its own. Runs inside the caller's
 * transaction.
 */
function copyWorkspaces(database: DatabaseSync, seeded: SeededFleet): void {
  const columns = (
    database.prepare("PRAGMA table_info(workspaces)").all() as { name: string }[]
  ).map((column) => column.name);
  const measuredAt = new Date(Date.now() - SEEDED_WORKSPACE_AGE_MS).toISOString();
  const overrides: Record<string, string> = {
    id: "?",
    created_at: "?",
    last_used_at: "?",
    size_bytes: "?",
    frees_bytes: "?",
    disk_usage_measured_at: "?",
    disk_usage_error: "NULL",
  };
  const copy = database.prepare(
    `INSERT INTO workspaces (${columns.join(", ")})
     SELECT ${columns.map((column) => overrides[column] ?? column).join(", ")}
     FROM workspaces WHERE id = ?`,
  );
  // The order of `?` follows the order of the columns in the table.
  const bound = columns.filter((column) => overrides[column] === "?");
  for (const id of seeded.cleanupWorkspaceIds) {
    seeded.reported.set(id, { workspaceId: id, diskUsage: null, error: null });
  }
  const copies = REPORTED_WORKSPACES - seeded.cleanupWorkspaceIds.length;
  const firstCreatedAt = Date.now() - 30 * DAY_MS;
  for (let index = 0; index < copies; index += 1) {
    const createdAtMs = firstCreatedAt + index * MINUTE_MS;
    const id = buildUuidV7(createdAtMs);
    const sizeBytes = (index + 1) * 10_000_000;
    const values: Record<string, unknown> = {
      id: uuidToBytes(id),
      created_at: new Date(createdAtMs).toISOString(),
      last_used_at: measuredAt,
      size_bytes: sizeBytes,
      frees_bytes: sizeBytes / 2,
      disk_usage_measured_at: measuredAt,
    };
    copy.run(
      ...bound.map((column) => values[column] as never),
      uuidToBytes(seeded.cleanupWorkspaceIds[0]!),
    );
    seeded.reported.set(id, {
      workspaceId: id,
      diskUsage: { sizeBytes, freesBytes: sizeBytes / 2, measuredAt },
      error: null,
    });
  }
}

/** Builds nimbus's disk usage report from what `seeded.reported` holds. */
const buildDiskUsageReport = (seeded: SeededFleet): RunnerDiskUsageReport => ({
  workspaces: [...seeded.reported.values()],
  truncated: false,
  runner: {
    repositoryCacheBytes: 5 * GB,
    harnessHomeBytes: 2 * GB,
    measuredAt: new Date(0).toISOString(),
  },
});

/**
 * Changes `CHANGED_ENTRIES` entries of nimbus's report, the measured ones that
 * the last change did not reach, as a runner does after it measured them
 * again, and returns the whole report.
 */
function changeDiskUsage(seeded: SeededFleet, round: number): RunnerDiskUsageReport {
  const measured = [...seeded.reported.values()].filter((entry) => entry.diskUsage !== null);
  const measuredAt = new Date().toISOString();
  for (let index = 0; index < CHANGED_ENTRIES; index += 1) {
    const entry = measured[(round * CHANGED_ENTRIES + index) % measured.length]!;
    const sizeBytes = entry.diskUsage!.sizeBytes + 1_000_000;
    seeded.reported.set(entry.workspaceId, {
      ...entry,
      diskUsage: { sizeBytes, freesBytes: sizeBytes / 2, measuredAt },
    });
  }
  return buildDiskUsageReport(seeded);
}

/**
 * Sends nimbus's whole report as the controller should already hold it, then
 * one Runner Metrics report of every scripted machine, so the cards have
 * metrics and the cleanup's workspaces are measured. Call it after each
 * `prepareLaunch`, which restarts the controller.
 */
export async function reportFleetState(seeded: SeededFleet): Promise<void> {
  seeded.nimbus.reportDiskUsage(buildDiskUsageReport(seeded));
  for (const [index, runner] of seeded.runners.entries()) {
    runner.reportMetrics(buildMetrics(index, runner === seeded.nimbus));
  }
  // The controller applies the frames in the order they arrive; a second is ample.
  await sleep(1_000);
}

/**
 * Returns what the request `request` reads, from its path and query: the
 * operation, and for `session.query` and `runnerMetrics.query` which of their
 * reads, or the method and the path, with ids as `:id`, for anything else.
 */
function classifyRead(request: RecordedRequest): string {
  const { pathname, searchParams } = request.url;
  const path = pathname.replace(/^\/api\/v1/, "");
  if (request.method !== "GET") return `${request.method} ${path.replace(/[0-9a-f-]{36}/g, ":id")}`;
  if (path === "/sessions") {
    if (searchParams.has("workspaceId"))
      return "a workspace's Threads (session.query by workspace)";
    if (searchParams.has("status") && !searchParams.has("kind") && !searchParams.has("archived")) {
      return "fleet sessions (session.query, live, every kind)";
    }
    return "shell sessions (session.query, other filters)";
  }
  if (path === "/runners") return "runner.query";
  if (/^\/runners\/[0-9a-f-]{36}$/.test(path)) return "runner.read";
  if (path === "/runner-metrics") {
    return searchParams.get("resolution") === "hour"
      ? "hour points (runnerMetrics.query)"
      : "five-minute points (runnerMetrics.query)";
  }
  if (path === "/workspaces") return "workspace.query";
  if (path === "/events") return "event.query";
  if (/^\/runs\/[0-9a-f-]{36}$/.test(path)) return "run.read";
  return `GET ${path.replace(/[0-9a-f-]{36}/g, ":id")}`;
}

/** The reads of one step, by kind: how many requests and how many bytes of answer, decompressed. */
type ReadTally = Map<string, { requests: number; bytes: number }>;

/** Counts `requests` by kind (see `classifyRead`). */
function tallyReads(requests: readonly RecordedRequest[]): ReadTally {
  const tally: ReadTally = new Map();
  for (const request of requests) {
    const kind = classifyRead(request);
    const entry = tally.get(kind) ?? { requests: 0, bytes: 0 };
    entry.requests += 1;
    entry.bytes += request.bodyBytes;
    tally.set(kind, entry);
  }
  return tally;
}

/** What one measured step cost. */
interface StepCost {
  /** How long the step ran, from its first change to its end, in milliseconds. */
  readonly durationMs: number;
  /** How many changes the step made: reports sent, or seconds streamed. */
  readonly changes: number;
  /** The pushes the page received, by topic. */
  readonly pushes: ReadonlyMap<string, number>;
  readonly reads: ReadTally;
  readonly rendererMainThreadMs: number;
  readonly rendererCpuMs: number;
  readonly controllerCpuMs: number;
}

/** What the scenario needs to measure a step on the open page. */
interface StepContext {
  readonly page: Inspector;
  readonly collector: Collector;
  readonly fixture: ThreadFixture;
  readonly rendererPid: number;
}

/**
 * Runs `step`, which makes `changes` changes, and returns what the page and
 * the controller spent on it, until the page has been quiet for `QUIET_MS`
 * after the step. The CPU times come from `ps`, and the main thread's from the
 * page's DevTools metrics; each also holds what the process did while idle in
 * that time, so they err high.
 */
async function measureStep(
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
    rendererMainThreadMs: (await readMainThreadMs(page)) - before.mainThread,
    rendererCpuMs: (await readCpuMs(rendererPid)) - before.renderer,
    controllerCpuMs: (await readCpuMs(controllerPid)) - before.controller,
  };
}

/** The screen a launch opens, and what it does on it besides the steps every launch runs. */
export interface FleetLaunchPlan {
  readonly name: string;
  /** The path the app reopens, such as `/fleet`. */
  readonly path: string;
  /** An expression that is true in the page once the screen has drawn. */
  readonly drawn: string;
  /** The machines whose Runner Metrics reports are measured; their reports are what the screen follows. */
  readonly reporters: readonly ScriptedRunner[];
  /** Whether the launch measures a `DiskUsageReport` from nimbus. */
  readonly reportsDiskUsage: boolean;
  /** Whether the launch opens the machine's Activity page from its Recent section. */
  readonly opensActivity: boolean;
  /** Whether the launch opens the cleanup dialog and presses Archive and remove. */
  readonly cleansUp: boolean;
}

/** What one Fleet launch measured. */
export interface FleetLaunch extends LaunchAtRest {
  readonly plan: FleetLaunchPlan;
  /** How many sessions the controller lists as not exited. */
  readonly openSessions: number;
  /** The reads the page made as it loaded again. */
  readonly load: ReadTally;
  readonly heldTopics: readonly string[];
  /** The reads the visible and the hidden idle samples saw, from the page's resource timing. */
  readonly idleReads: { readonly visible: ReadTally; readonly hidden: ReadTally };
  readonly nudges: StepCost;
  readonly streaming: StepCost;
  readonly hiddenStreaming: StepCost;
  readonly shownAgain: StepCost;
  readonly diskUsage: StepCost | null;
  readonly activity: StepCost | null;
  readonly cleanup: {
    readonly opening: StepCost;
    readonly removal: StepCost;
    readonly toast: string;
  } | null;
}

/** Stores `plan.path` as the last screen, so the next launch opens it (see `openScreenOnce`). */
export const openFleetScreenOnce = (userDataDir: string, plan: FleetLaunchPlan): Promise<void> =>
  openScreenOnce(userDataDir, plan.path, async (page: Page) => {
    // The page's Content-Security-Policy refuses `waitForFunction`'s eval, so
    // the expression is evaluated over DevTools, which the policy does not cover.
    let shown = "";
    await pollUntil(
      async () => {
        shown = await page.evaluate(
          `location.pathname + ", " + document.querySelectorAll(".fleet-card").length + " cards"`,
        );
        return (await page.evaluate(plan.drawn)) === true ? true : undefined;
      },
      {
        timeoutMs: 20_000,
        intervalMs: 100,
        timeoutMessage: () => `${plan.name}: the screen did not draw; it shows ${shown}`,
      },
    );
  });

/**
 * Runs `report` every `IDLE_REPORT_INTERVAL_MS` from now, through the
 * reporters in turn, until the returned function is called.
 */
function startIdleReports(seeded: SeededFleet): () => void {
  let turn = 0;
  const timer = setInterval(() => {
    const index = turn % seeded.runners.length;
    const runner = seeded.runners[index]!;
    runner.reportMetrics(buildMetrics(index, runner === seeded.nimbus));
    turn += 1;
  }, IDLE_REPORT_INTERVAL_MS);
  return () => clearInterval(timer);
}

/** An expression that evaluates, in the page, to the URLs of its reads that began between two times, in ms since the epoch. */
const buildReadsBetween = (from: number, to: number) => `performance
  .getEntriesByType("resource")
  .filter((entry) => {
    const at = performance.timeOrigin + entry.startTime;
    return entry.name.startsWith("http") && at >= ${String(from)} && at < ${String(to)};
  })
  .map((entry) => entry.name)`;

/** Counts reads known only by their URL, as GET requests of no size. */
const tallyUrls = (urls: readonly string[]): ReadTally =>
  tallyReads(
    urls.map((url) => ({
      method: "GET",
      url: new URL(url),
      startedAtMs: 0,
      durationMs: 0,
      firstByteMs: null,
      bodyBytes: 0,
    })),
  );

/** Returns an idle thread on `runner` that the fixture can stream into: a thread of the fixture, not archived. */
async function findIdleThread(fixture: ThreadFixture, runnerId: string, skip: ReadonlySet<string>) {
  const { items } = await fixture.call<{ readonly items: readonly Session[] }>(
    "GET",
    "/sessions?kind=thread&status=idle&archived=false&limit=500",
  );
  const thread = items.find((each) => each.runnerId === runnerId && !skip.has(each.id));
  if (thread === undefined) throw new Error(`runner ${runnerId} has no idle thread to stream into`);
  return thread.id;
}

/**
 * Sends the idle thread `sessionId` a question, which opens a turn, and plays
 * an answer into it for `forMs`: text at full speed, with a usage report after
 * each second of it, as a harness reports its token counts while it writes.
 * The controller pushes a usage-only change of a session about once a second,
 * so the page gets the `session` pushes a working agent causes. Resolves once
 * the turn has completed and the thread is idle again. Fails when it does not
 * become idle within 10 s of the end.
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
    { timeoutMs: 10_000, intervalMs: 50, timeoutMessage: `thread ${sessionId} never became idle` },
  );
}

/**
 * Starts the signed-in app on `userDataDir` as a plain process, warm, on the
 * screen `plan` names, and measures it as the top of this file describes.
 * Fails when the screen does not draw, when a step does not end within its
 * time, or when the app does not quit cleanly.
 */
export async function measureFleetLaunch(
  userDataDir: string,
  fixture: ThreadFixture,
  seeded: SeededFleet,
  plan: FleetLaunchPlan,
): Promise<FleetLaunch> {
  await warmUpApp(userDataDir);
  const loadAtSpawn = loadavg()[0]!;
  const app = await launchPlainApp(userDataDir);
  const { inspectorUrl } = app;
  let measured: FleetLaunch;
  try {
    const pageSocketUrl = await waitForPageSocketUrl(app.endpoint);
    const pageOpenedAt = Date.now();
    const sleepUntil = (msAfterOpen: number) =>
      sleep(Math.max(0, pageOpenedAt + msAfterOpen - Date.now()));
    await sleepUntil(MEMORY_READ_AT_MS);
    const memory: readonly ProcessMemory[] = await readProcessMemory(app.process.pid!);
    const rendererPid = findRendererPid(memory);

    await sleepUntil(VISIBLE_SAMPLE_AT_MS);
    const stopReports = startIdleReports(seeded);
    let samples;
    try {
      samples = await sampleVisibleAndHidden(inspectorUrl, VISIBLE_SAMPLE_MS);
    } finally {
      stopReports();
    }

    const page = await connectInspector(pageSocketUrl);
    let collector: Collector | undefined;
    try {
      const driver: PageDriver = drivePage(page);
      if (!(await driver.evaluate<boolean>(plan.drawn))) {
        throw new Error(`${plan.name}: the screen was not drawn when it was sampled`);
      }
      const fires = await countAgeClockFires(page, samples);
      const idleReads = {
        visible: tallyUrls(
          await driver.evaluate<string[]>(
            buildReadsBetween(samples.visibleFrom, samples.visibleTo),
          ),
        ),
        hidden: tallyUrls(
          await driver.evaluate<string[]>(buildReadsBetween(samples.hiddenFrom, samples.hiddenTo)),
        ),
      };
      collector = await startCollector(pageSocketUrl);
      await page.send("Performance.enable");
      await page.send("Page.enable");
      // The page subscribed and made its first reads before the collector was
      // on, so it loads again with the collector watching.
      const loadFrom = collector.checkpoint();
      await page.send("Page.reload");
      await page.waitForEvent("Page.loadEventFired");
      await driver.waitFor(
        plan.drawn,
        `${plan.name}: the screen did not draw after the reload`,
        20_000,
      );
      await sleep(2_000);
      await collector.waitForQuietReads(1_000);
      const load = tallyReads(collector.since(loadFrom).requests);
      const heldTopics = collector.listHeldTopics();
      const context: StepContext = { page, collector, fixture, rendererPid };

      const nudges = await measureStep(context, NUDGE_COUNT, async () => {
        for (let nudge = 0; nudge < NUDGE_COUNT; nudge += 1) {
          const startedAt = Date.now();
          const runner = plan.reporters[nudge % plan.reporters.length]!;
          runner.reportMetrics(buildMetrics(nudge, runner === seeded.nimbus));
          await sleep(Math.max(0, startedAt + NUDGE_INTERVAL_MS - Date.now()));
        }
      });

      const studio = seeded.runners[0]!.runnerId;
      const streamed = await findIdleThread(fixture, studio, new Set());
      const streaming = await measureStep(context, STREAM_MS / 1_000, () =>
        streamWithUsage(fixture, streamed, STREAM_MS),
      );
      await callWindow(inspectorUrl, "hide");
      await driver.waitFor(`document.visibilityState === "hidden"`, "the page never became hidden");
      const hiddenThread = await findIdleThread(fixture, studio, new Set([streamed]));
      const hiddenStreaming = await measureStep(context, HIDDEN_STREAM_MS / 1_000, () =>
        streamWithUsage(fixture, hiddenThread, HIDDEN_STREAM_MS),
      );
      const shownAgain = await measureStep(context, 1, async () => {
        await callWindow(inspectorUrl, "showInactive");
        await driver.waitFor(
          `document.visibilityState === "visible"`,
          "the page never became visible",
        );
        await sleep(1_000);
      });

      const diskUsage = plan.reportsDiskUsage
        ? await measureStep(context, 1, async () => {
            seeded.nimbus.reportDiskUsage(changeDiskUsage(seeded, 0));
            await collector!.waitForPushes(
              collector!.checkpoint(),
              "workspace",
              1,
              "the disk usage report",
            );
          })
        : null;

      const activity = plan.opensActivity
        ? await measureStep(context, 1, async () => {
            await driver.click(
              buildScrolledIntoView(`document.querySelector(".machine-activity-all")`),
            );
            await driver.waitFor(
              // Recent draws the same rows, so the Activity page is known by its head.
              `document.querySelector(".machine-activity-head") !== null &&
                document.querySelector(".machine-page-head") === null &&
                document.querySelectorAll(".machine-activity-row").length > 0`,
              "the Activity page drew no entry",
            );
          })
        : null;

      const cleanup = plan.cleansUp ? await cleanUpNimbus(context, driver) : null;

      const { items: open } = await fixture.call<{ readonly items: readonly Session[] }>(
        "GET",
        "/sessions?status=queued&status=starting&status=idle&status=busy&limit=500",
      );
      measured = {
        plan,
        loadAtSpawn,
        memory,
        visible: samples.visible,
        visibleMs: samples.visibleTo - samples.visibleFrom,
        hidden: samples.hidden,
        ...fires,
        openSessions: open.length,
        load,
        heldTopics,
        idleReads,
        nudges,
        streaming,
        hiddenStreaming,
        shownAgain,
        diskUsage,
        activity,
        cleanup,
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

/**
 * Wraps the expression `element`, which evaluates to an element or nothing,
 * so that it first scrolls that element to the middle of the view. A click
 * lands at the element's place on screen, and a machine page's lower sections
 * start below the window's bottom edge.
 */
const buildScrolledIntoView = (element: string): string => `(() => {
  const element = ${element};
  element?.scrollIntoView({ block: "center" });
  return element;
})()`;

/**
 * On nimbus's page, presses Storage's Clean up…, waits for the dialog to list
 * its rows, then ticks every row and presses Archive and remove, and waits for
 * the toast that every row is removed. Returns what each of the two presses
 * cost and the toast's text.
 */
async function cleanUpNimbus(context: StepContext, driver: PageDriver) {
  const opening = await measureStep(context, 1, async () => {
    await driver.click(
      buildScrolledIntoView(
        `[...document.querySelectorAll("#machine-storage button")].find((button) => button.textContent.trim() === "Clean up…")`,
      ),
    );
    await driver.waitFor(
      `document.querySelectorAll(".cleanup-dialog .cleanup-row").length === ${String(CLEANUP_THREADS)}`,
      `the cleanup dialog did not list ${String(CLEANUP_THREADS)} workspaces`,
    );
  });
  // The group of Threads not Done opens unticked; its head ticks it whole.
  await driver.evaluate(`(() => {
    for (const box of document.querySelectorAll(".cleanup-dialog .cleanup-group-head input[type=checkbox]")) {
      if (!box.checked) box.click();
    }
  })()`);
  const removal = await measureStep(context, 1, async () => {
    await driver.click(
      `[...document.querySelectorAll(".cleanup-dialog .cleanup-foot-buttons button")].find((button) => button.textContent.startsWith("Archive and remove"))`,
    );
    await driver.waitFor(
      `[...document.querySelectorAll('[role="status"]')].some((status) => status.textContent.includes("removed ${String(CLEANUP_THREADS)} workspaces"))`,
      "the cleanup's toast never said every workspace was removed",
      20_000,
    );
  });
  const toast = await driver.evaluate<string>(
    `[...document.querySelectorAll('[role="status"]')].map((status) => status.textContent).find((text) => text.includes("removed")) ?? ""`,
  );
  return { opening, removal, toast };
}

/** Formats a read tally as "kind: requests (KB)" items, most bytes first. */
function formatTally(tally: ReadTally, per = 1): string {
  if (tally.size === 0) return "none";
  return [...tally]
    .toSorted((a, b) => b[1].bytes - a[1].bytes || b[1].requests - a[1].requests)
    .map(([kind, { requests, bytes }]) => {
      const count = per === 1 ? String(requests) : `${(requests / per).toFixed(2)}`;
      return bytes === 0
        ? `${kind} ${count}`
        : `${kind} ${count} (${(bytes / per / 1_000).toFixed(1)} kB)`;
    })
    .join("; ");
}

/** Prints the rows of one measured step under `name`, per change when `perChange` names the change. */
function printStep(name: string, step: StepCost, perChange: string | null): void {
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
        [`Renderer main thread${unit}`, `${(step.rendererMainThreadMs / per).toFixed(1)} ms`],
        [`Renderer CPU${unit}`, `${(step.rendererCpuMs / per).toFixed(0)} ms`],
        [`Controller CPU${unit}`, `${(step.controllerCpuMs / per).toFixed(0)} ms`],
      ],
    ),
  );
  console.log();
}

/** Prints what one Fleet launch measured. */
export function reportFleetLaunch(measured: FleetLaunch): void {
  printLaunch(
    `## Fleet: ${measured.plan.name}, ${String(measured.openSessions)} sessions open`,
    measured,
    buildAtRestRows(measured, "recorded: a time label on screen may change"),
  );
  console.log(
    formatTable(
      ["Measure", "Result"],
      [
        [
          "Reads while visible, 60 s, one Runner Metrics report every 12 s",
          formatTally(measured.idleReads.visible),
        ],
        ["Reads while hidden, 10 s", formatTally(measured.idleReads.hidden)],
        ["Reads as the page loads again", formatTally(measured.load)],
        ["Live topics held after the reload", measured.heldTopics.join(", ")],
      ],
    ),
  );
  console.log();
  printStep("Runner Metrics reports, a second apart", measured.nudges, "report");
  printStep("a thread streaming, window visible", measured.streaming, "second");
  printStep("a thread streaming, window hidden", measured.hiddenStreaming, "second");
  printStep("the window shown again", measured.shownAgain, null);
  if (measured.diskUsage !== null) {
    printStep(
      `nimbus's disk usage report, ${String(CHANGED_ENTRIES)} of ${String(REPORTED_WORKSPACES)} entries changed`,
      measured.diskUsage,
      null,
    );
  }
  if (measured.activity !== null)
    printStep("the Activity page opened from Recent", measured.activity, null);
  if (measured.cleanup !== null) {
    printStep("Clean up… pressed, until the dialog lists its rows", measured.cleanup.opening, null);
    printStep("Archive and remove pressed, until the toast", measured.cleanup.removal, null);
    console.log(`The toast: ${measured.cleanup.toast}\n`);
  }
}

/**
 * Prints the size of the JSON the Fleet reads answer with, read from Node as
 * the signed-in user, for spec 17's Memory row: every runner, every open
 * session, the hour points of the last 7 days and one machine's five-minute
 * points of the last 24 hours.
 */
export async function reportFleetReadSizes(
  fixture: ThreadFixture,
  studioId: string,
): Promise<void> {
  const readAll = async (path: string) => {
    let bytes = 0;
    let items = 0;
    let cursor: string | undefined;
    let pages = 0;
    do {
      const separator = path.includes("?") ? "&" : "?";
      const page: { items: unknown[]; nextCursor?: string } = await fixture.call(
        "GET",
        `${path}${cursor === undefined ? "" : `${separator}cursor=${encodeURIComponent(cursor)}`}`,
      );
      bytes += JSON.stringify(page).length;
      items += page.items.length;
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined);
    return { bytes, items, pages };
  };
  const now = Date.now();
  // A read may span at most its range, so each starts a little after `now -
  // range`, as the client's own reads start two points after it.
  const since = (ms: number) => encodeURIComponent(new Date(now - ms).toISOString());
  const runners = await fixture.call<{ items: Runner[] }>("GET", "/runners?limit=500");
  const rows = [
    ["runner.query", await readAll("/runners?limit=500")],
    [
      "session.query, every live session",
      await readAll("/sessions?status=queued&status=starting&status=idle&status=busy&limit=500"),
    ],
    [
      "runnerMetrics.query, hour points, 7 days, every runner",
      await readAll(
        `/runner-metrics?resolution=hour&since=${since(7 * DAY_MS - 2 * HOUR_MS)}&limit=500`,
      ),
    ],
    [
      "runnerMetrics.query, hour points, 14 days, every runner",
      await readAll(
        `/runner-metrics?resolution=hour&since=${since(14 * DAY_MS - 2 * HOUR_MS)}&limit=500`,
      ),
    ],
    [
      "runnerMetrics.query, five-minute points, 24 h, studio",
      await readAll(
        `/runner-metrics?resolution=fiveMinutes&runnerId=${studioId}&since=${since(DAY_MS - 10 * MINUTE_MS)}&limit=500`,
      ),
    ],
    ["workspace.query, every workspace", await readAll("/workspaces?limit=500")],
  ] as const;
  console.log(`## Fleet: the size of each read's JSON, ${String(runners.items.length)} machines\n`);
  console.log(
    formatTable(
      ["Read", "Items", "Pages", "JSON bytes"],
      rows.map(([name, { items, pages, bytes }]) => [
        name,
        String(items),
        String(pages),
        String(bytes),
      ]),
    ),
  );
  console.log();
}
