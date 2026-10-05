/**
 * Fills a scratch controller with threads for the desktop perf script, and
 * sets how old they look. The threads are made through the fleet of scripted
 * runners in `fleet.ts`, as the end-to-end suite makes them:
 *
 * - two runners, "studio" and "laptop", each holding half of the threads;
 * - four projects, each holding a quarter of them;
 * - in each project, one thread that stays busy;
 * - in the first two projects, one more thread, waiting on a Request;
 * - every other thread idle.
 *
 * On request, `growTranscript` also plays turns into one idle thread until its
 * transcript is long, and `streamTurn` streams a long answer into it.
 *
 * An idle thread's row shows its age, and the perf script counts how often
 * the app's age clock fires while nothing happens. For that count to mean
 * something, every age on screen must be hours old, so that no label changes
 * during the count. The controller stamps a thread's last activity with its
 * own clock, and no operation sets it. So before each launch,
 * `prepareLaunch` stops the controller, writes the idle threads' last
 * activity into its database, and starts it again on the same port. That
 * write is the only thing done to the database directly: the threads, and
 * every state they are in, come from the fleet.
 *
 * It runs on plain Node, like the perf script, so its imports name the `.ts`
 * file.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Project, Runner, Session } from "../../../packages/contract/src/index";
import {
  deleteMasterKeyItem,
  findCompiledBinary,
  startController,
  startSetUpController,
} from "../../../scripts/controller-process.ts";
import type { ScriptedRunner, ScriptStep } from "./scripted-runner.ts";
import { connectFleet } from "./fleet.ts";
import { pollUntil } from "./poll.ts";

/** The projects the threads are spread over, in the order they are created. */
const PROJECT_NAMES = ["Webshop", "Payments", "Ops", "Docs"] as const;

/**
 * The most threads each runner holds. An idle thread keeps its slot, so the
 * two runners together hold the 500 threads the script measures at most.
 */
const RUNNER_CAPACITY = 250;

/** The most threads one read of the thread list returns, which the controller allows. */
const THREAD_PAGE = 500;

const HOUR_MS = 3_600_000;

/**
 * How many different whole hours the idle threads' ages spread over. The
 * oldest thread then looks 6 hours and 31 minutes old. That must stay under
 * a session's absolute timeout, 8 hours by default: when the controller
 * starts, it ends every session that has been silent longer than that on a
 * runner that is not connected, and the runners connect only after it has
 * started.
 */
const AGE_HOURS = 6;

/** How far back a thread's last activity is set for the one row that shows minutes. */
const TWO_MINUTES_MS = 120_000;

/** The controller's database, inside its Hercule Home. */
const DATABASE_PATH = ["data", "hercule.db"] as const;

/** What the user asks in each turn `growTranscript` plays. */
const LONG_THREAD_QUESTION = "The checkout test fails again. Can you find out why?";

/**
 * The agent's answer at the end of each turn `growTranscript` plays: a
 * paragraph with inline code and bold, a list and a code block, so the
 * transcript renders every kind of Markdown block a real answer has.
 */
const LONG_THREAD_ANSWER = [
  "The checkout test fails because `fetchOrders` resolves after the test's timeout. " +
    "The mock server answers in **120 ms**, and the test waits 100 ms.",
  "",
  "- The timeout comes from `vitest.config.ts`.",
  "- The mock's delay comes from `mocks/orders.ts`.",
  "- Nothing else in the suite waits on the mock server.",
  "",
  "```ts",
  "const orders = await fetchOrders({ retry: 2 });",
  "expect(orders).toHaveLength(3);",
  "```",
  "",
  "I added a retry, and the test passes now.",
].join("\n");

/**
 * Each turn `growTranscript` plays: a message, a command, a file change, the
 * command again and the answer, which the transcript shows as a message, a
 * work stretch and a message. The text is written without a delay between
 * words, so the thread grows fast; nothing measures these turns.
 */
const LONG_THREAD_TURN: ReadonlyArray<ScriptStep> = [
  { kind: "message", text: "Let me run the failing test first.", deltaMs: 0 },
  { kind: "command", command: "pnpm test checkout" },
  { kind: "file_change", path: "src/checkout/orders.test.ts" },
  { kind: "command", command: "pnpm test checkout" },
  { kind: "message", text: LONG_THREAD_ANSWER, deltaMs: 0 },
  { kind: "end", state: "completed" },
];

/** What the user asks in the turn `streamTurn` plays. */
const STREAM_QUESTION = "Explain where the time goes when a thread streams.";

/** A thread whose transcript `growTranscript` grew. */
export interface LongThread {
  readonly id: string;
  readonly title: string;
  /** How many rows its transcript holds. */
  readonly rowCount: number;
}

/** A controller full of threads, and what the perf script does to it between launches. */
export interface ThreadFixture {
  /** The controller's URL. It stays the same when the controller restarts. */
  readonly url: string;
  /**
   * Spawns threads until the controller holds `count`, spread over the
   * projects and the runners as the top of this file describes, and returns
   * once each new thread has settled. The first call picks the busy and the
   * waiting threads; every thread spawned after that is left idle.
   */
  readonly growTo: (count: number) => Promise<void>;
  /**
   * Readies the controller for a launch: closes the open Requests, restarts
   * the controller with every idle thread's last activity set hours back,
   * and opens the Requests again. With `twoMinuteRow`, one idle thread in the
   * first project is set only two minutes back instead, so exactly one row on
   * screen shows minutes. Fails when a thread is not in its expected state
   * afterwards.
   */
  readonly prepareLaunch: (options: { readonly twoMinuteRow: boolean }) => Promise<void>;
  /**
   * Moves the first project's busy thread to idle, or back to busy, which
   * makes the controller push one change to the app.
   */
  readonly nudge: () => void;
  /** Returns the process ID of the running controller. It changes when `prepareLaunch` restarts the controller. */
  readonly readControllerPid: () => number;
  /**
   * Plays turns into one idle thread until its transcript holds at least
   * `rowCount` rows, and returns the thread. Each turn is the user's question
   * and the agent's work and answer. The thread is idle again afterwards, so
   * `prepareLaunch` finds every thread in the state it expects.
   *
   * The thread is the idle thread the controller lists first, which is in
   * the first project. `prepareLaunch` sets that one the least far back of
   * all the idle threads but the two-minute row, so it is among the first
   * project's three newest idle threads, which the sidebar always shows.
   */
  readonly growTranscript: (rowCount: number) => Promise<LongThread>;
  /**
   * Sends the idle thread `sessionId` a question, which opens a turn, and
   * streams one long answer of generated Markdown into that turn for `forMs`,
   * a word every 2 ms, which is full speed. Resolves once the turn has
   * completed.
   */
  readonly streamTurn: (sessionId: string, forMs: number) => Promise<void>;
}

/**
 * Starts a controller from the compiled binary in a scratch Hercule Home,
 * completes its setup, enlists the fleet's two runners and creates the
 * projects, then runs `use` with the fixture. Stops the controller and
 * deletes the Home afterwards. Fails when there is no compiled binary.
 */
export async function runWithThreadFixture<T>(
  use: (fixture: ThreadFixture) => Promise<T>,
): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "hercule-desktop-perf-home-"));
  try {
    let controller = await startSetUpController({ home });
    const runners: ScriptedRunner[] = [];
    try {
      const { url } = controller;
      const fleet = await connectFleet(url);
      const { call } = fleet;
      runners.push(
        await fleet.enlistRunner("studio", { maxConcurrentSessions: RUNNER_CAPACITY }),
        await fleet.enlistRunner("laptop", { maxConcurrentSessions: RUNNER_CAPACITY }),
      );
      const projects: Project[] = [];
      for (const name of PROJECT_NAMES) projects.push(await fleet.createProject(name));

      const listThreads = async (): Promise<readonly Session[]> =>
        (
          await call<{ readonly items: readonly Session[] }>(
            "GET",
            `/sessions?thread=true&limit=${String(THREAD_PAGE)}`,
          )
        ).items;

      /** The runner each thread is pinned to, by session id. */
      const runnerBySessionId = new Map<string, ScriptedRunner>();
      /** The idle threads in the first project, the first of which becomes the two-minute row. */
      const firstProjectIdle: string[] = [];
      /** One busy thread per project, in project order; the first is the one `nudge` moves. */
      const busyIds: string[] = [];
      /** The threads that wait on a Request, in project order. */
      const waitingIds: string[] = [];
      /** Each waiting thread's open Request, by session id. */
      const openRequests = new Map<string, string>();
      let nudgedIsBusy = true;
      let threadCount = 0;

      const growTo = async (count: number): Promise<void> => {
        const perProject = (count - threadCount) / projects.length;
        const picksStates = threadCount === 0;
        const spawned: Session[] = [];
        for (const [index, project] of projects.entries()) {
          // Alternating which runner takes the odd thread keeps the two even.
          const onFirst = index % 2 === 0 ? Math.ceil(perProject / 2) : Math.floor(perProject / 2);
          const inProject: Session[] = [];
          for (const [runner, share] of [
            [runners[0]!, onFirst],
            [runners[1]!, perProject - onFirst],
          ] as const) {
            const threads = await fleet.spawnThreads(share, { runner, projectId: project.id });
            for (const thread of threads) runnerBySessionId.set(thread.id, runner);
            inProject.push(...threads);
          }
          const [busy, waiting, ...rest] = inProject;
          const idle = picksStates ? rest : inProject;
          if (picksStates) {
            busyIds.push(busy!.id);
            if (index < 2) waitingIds.push(waiting!.id);
            else idle.unshift(waiting!);
          }
          if (index === 0) firstProjectIdle.push(...idle.map((thread) => thread.id));
          spawned.push(...inProject);
        }
        threadCount = count;

        // A spawned thread settles busy, running the turn its prompt opened.
        const spawnedIds = new Set(spawned.map((thread) => thread.id));
        await waitForThreads(
          listThreads,
          (threads) =>
            threads.filter((thread) => spawnedIds.has(thread.id) && thread.status === "busy")
              .length === spawnedIds.size,
          `all ${String(spawnedIds.size)} new threads busy`,
        );
        const staying = new Set([...busyIds, ...waitingIds]);
        for (const id of spawnedIds)
          if (!staying.has(id)) runnerBySessionId.get(id)!.completeTurn(id);
        await waitForThreads(
          listThreads,
          (threads) =>
            threads.filter((thread) => thread.status === "idle").length === count - staying.size,
          `${String(count - staying.size)} threads idle`,
        );
      };

      const prepareLaunch = async ({ twoMinuteRow }: { readonly twoMinuteRow: boolean }) => {
        // A Request is answered before the restart and opened again after it,
        // so the restart never has to decide what happens to one.
        for (const [id, requestId] of openRequests) {
          await call("POST", `/sessions/${id}/respond-to-approval-request`, {
            requestId,
            decision: "allow",
          });
        }
        openRequests.clear();
        await waitForThreads(
          listThreads,
          (threads) => threads.every((thread) => thread.openRequests.length === 0),
          "no Request open",
        );
        // The nudged thread is busy again, so every launch starts from the same states.
        if (!nudgedIsBusy) nudge();
        await waitForThreads(
          listThreads,
          (threads) => threads.find((thread) => thread.id === busyIds[0])?.status === "busy",
          "the nudged thread busy",
        );

        const idleIds = (await listThreads())
          .filter((thread) => thread.status === "idle")
          .map((thread) => thread.id);
        const { port } = controller;
        const stopped = await controller.stop();
        if (stopped !== 0) {
          throw new Error(`the controller exited with ${String(stopped)}:\n${controller.output()}`);
        }
        setLastActivity(home, idleIds, twoMinuteRow ? firstProjectIdle[0]! : null);
        controller = await startController({ home, binary: findCompiledBinary(), port });
        await Promise.all(runners.map((runner) => runner.reconnect()));
        for (const runner of runners) {
          await waitFor(
            async () =>
              (await call<Runner>("GET", `/runners/${runner.runnerId}`)).connectivity === "online",
            `runner ${runner.runnerId} online`,
          );
        }
        // A runner is online once the controller answers its hello, before the
        // controller has matched the sessions the runner reports to its threads.
        await waitForCensus(listThreads, {
          busy: busyIds.length + waitingIds.length,
          idle: idleIds.length,
          waiting: 0,
        });

        // The second project's Request is opened first, and has landed before
        // the first project's opens, so the first project holds the newest
        // activity and is listed first, with the two-minute row in it.
        for (const id of waitingIds.toReversed()) {
          openRequests.set(id, runnerBySessionId.get(id)!.openRequest(id, "command_approval"));
          await waitForThreads(
            listThreads,
            (threads) => (threads.find((thread) => thread.id === id)?.openRequests.length ?? 0) > 0,
            `a Request open on ${id}`,
          );
        }
        await waitForCensus(listThreads, {
          busy: busyIds.length + waitingIds.length,
          idle: idleIds.length,
          waiting: waitingIds.length,
        });
      };

      const nudge = (): void => {
        const id = busyIds[0]!;
        const runner = runnerBySessionId.get(id)!;
        if (nudgedIsBusy) runner.completeTurn(id);
        else runner.startTurn(id);
        nudgedIsBusy = !nudgedIsBusy;
      };

      const readControllerPid = (): number => controller.pid;

      /** Returns how many rows the transcript of the thread `sessionId` holds. */
      const countTranscriptRows = async (sessionId: string): Promise<number> =>
        (await fleet.readTranscript(sessionId)).length;

      /** Waits until the thread `sessionId` is idle, so its next question opens a turn rather than queueing. */
      const waitForIdle = (sessionId: string): Promise<void> =>
        waitFor(
          async () => (await call<Session>("GET", `/sessions/${sessionId}`)).status === "idle",
          `thread ${sessionId} idle`,
        );

      const growTranscript = async (rowCount: number): Promise<LongThread> => {
        const thread = (await listThreads()).find((candidate) => candidate.status === "idle");
        if (thread === undefined) throw new Error("the controller has no idle thread to grow");
        const runner = runnerBySessionId.get(thread.id)!;
        let rows = await countTranscriptRows(thread.id);
        while (rows < rowCount) {
          await call("POST", `/sessions/${thread.id}/input`, { text: LONG_THREAD_QUESTION });
          await runner.playScript(thread.id, LONG_THREAD_TURN);
          await waitForIdle(thread.id);
          rows = await countTranscriptRows(thread.id);
        }
        return { id: thread.id, title: thread.title, rowCount: rows };
      };

      const streamTurn = async (sessionId: string, forMs: number): Promise<void> => {
        await call("POST", `/sessions/${sessionId}/input`, { text: STREAM_QUESTION });
        await runnerBySessionId.get(sessionId)!.playScript(sessionId, [
          { kind: "stream", forMs },
          { kind: "end", state: "completed" },
        ]);
        await waitForIdle(sessionId);
      };

      return await use({
        url,
        growTo,
        prepareLaunch,
        nudge,
        readControllerPid,
        growTranscript,
        streamTurn,
      });
    } finally {
      await Promise.all(runners.map((runner) => runner.goOffline()));
      await controller.stop();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    deleteMasterKeyItem(home);
  }
}

/**
 * Writes the last activity of every thread in `idleIds` into the stopped
 * controller's database in the Home `home`.
 *
 * The thread at position `i` is set `(1 + i mod 6)` hours, 30 minutes and
 * `i mod 60` seconds back. Every idle row then shows hours, and each
 * age is at least 29 minutes from the moment its label next changes, so no
 * label changes during a launch. `twoMinuteThreadId`, when given, is set two
 * minutes back instead, so its label changes once a minute.
 *
 * A session's id is stored as 16 bytes, so each row is found by the hex form
 * of the id without its dashes. Fails when a thread is not found.
 */
function setLastActivity(
  home: string,
  idleIds: readonly string[],
  twoMinuteThreadId: string | null,
): void {
  const database = new DatabaseSync(join(home, ...DATABASE_PATH));
  try {
    const update = database.prepare(
      "UPDATE sessions SET last_activity_at = ? WHERE hex(id) = upper(replace(?, '-', ''))",
    );
    const now = Date.now();
    database.exec("BEGIN");
    for (const [index, id] of idleIds.entries()) {
      const backMs =
        id === twoMinuteThreadId
          ? TWO_MINUTES_MS
          : (1 + (index % AGE_HOURS)) * HOUR_MS + HOUR_MS / 2 + (index % 60) * 1_000;
      const { changes } = update.run(new Date(now - backMs).toISOString(), id);
      if (changes !== 1) throw new Error(`the database has no session ${id}`);
    }
    database.exec("COMMIT");
  } finally {
    database.close();
  }
}

/** Waits until `isReady` returns true, checking every 50 ms, and fails after 30 s naming `what`. */
async function waitFor(isReady: () => Promise<boolean>, what: string): Promise<void> {
  await pollUntil(async () => ((await isReady()) ? true : undefined), {
    timeoutMs: 30_000,
    intervalMs: 50,
    timeoutMessage: `gave up waiting for ${what}`,
  });
}

/** How many threads are busy, how many idle, and how many wait on a Request. */
interface Census {
  readonly busy: number;
  readonly idle: number;
  readonly waiting: number;
}

/**
 * Waits until the thread list, read with `listThreads`, holds `expected`.
 * Fails after 30 s with the count of threads in each status.
 */
async function waitForCensus(
  listThreads: () => Promise<readonly Session[]>,
  expected: Census,
): Promise<void> {
  const countStatus = (threads: readonly Session[], status: Session["status"]) =>
    threads.filter((thread) => thread.status === status).length;
  const countWaiting = (threads: readonly Session[]) =>
    threads.filter((thread) => thread.openRequests.length > 0).length;
  const holds = (threads: readonly Session[]) =>
    countStatus(threads, "busy") === expected.busy &&
    countStatus(threads, "idle") === expected.idle &&
    countWaiting(threads) === expected.waiting;
  try {
    await waitForThreads(listThreads, holds, JSON.stringify(expected));
  } catch (error) {
    const threads = await listThreads();
    const counts = [...new Set(threads.map((thread) => thread.status))].map(
      (status) => `${String(countStatus(threads, status))} ${status}`,
    );
    throw new Error(
      `the threads never reached ${JSON.stringify(expected)}: ${counts.join(", ")}, ` +
        `${String(countWaiting(threads))} waiting`,
      { cause: error },
    );
  }
}

/** Waits until the thread list, read with `listThreads`, passes `isReady`. */
function waitForThreads(
  listThreads: () => Promise<readonly Session[]>,
  isReady: (threads: readonly Session[]) => boolean,
  what: string,
): Promise<void> {
  return waitFor(async () => isReady(await listThreads()), what);
}
