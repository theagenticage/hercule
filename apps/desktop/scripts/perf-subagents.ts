/**
 * The desktop perf script's subagent scenario: one plain launch of the app on
 * a thread with 20 subagents, 4 of them running, which measures the rows of
 * spec 17 §What subagents cost that a script can measure:
 *
 * - processes and memory, with the side pane closed and then open on its 20
 *   rows (see `measureSubagentLaunch`);
 * - each process's CPU and wakeups with the pane open, visible and hidden,
 *   first while 4 subagents run and again once every subagent has ended;
 * - how often each row's duration text changes, in each of those samples:
 *   a running row on screen at most once a second while the window is
 *   visible, and no row ever while hidden or once it has ended (see
 *   `INSTALL_DURATION_OBSERVER`);
 * - which live topics the page holds on the thread's page, on a subagent's
 *   page, with that page's window hidden and shown again, and with no thread
 *   open (see `recordHeldTopics`);
 * - how often the page reads the open thread's subagents again while another
 *   thread's subagent changes, and while one of its own does (see
 *   `measureSubagentNudges`).
 *
 * The scenario runs last, after every other launch, because it leaves the
 * subagents behind: the thread list holds at most 500 threads, so the
 * subagents are played into two of the fixture's idle threads rather than
 * into a new one, and a later `prepareLaunch` would restart the controller
 * under running subagents.
 *
 * The side pane is still being built, so its selectors sit at the top of this
 * file, where they are easy to change.
 *
 * It runs on plain Node, like the perf script, so its imports name the `.ts`
 * file.
 */
import { loadavg } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import type { Session, Subagent } from "../../../packages/contract/src/index";
import {
  assertExitedCleanly,
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
  openThreadOnce,
  readProcessMemory,
  sampleIdleUse,
  waitForPageSocketUrl,
  warmUpApp,
  type ProcessMemory,
  type ProcessUse,
} from "./perf-measures.ts";
import { pollUntil } from "./poll.ts";
import type { ScriptStep } from "./scripted-runner.ts";

/** The header's button that opens the side pane, by its label, as the web's thread header labels it. */
const PANE_TOGGLE_SELECTOR = 'button[aria-label="Show the side pane"]';

/** The side pane, by its label. */
const SIDE_PANE_SELECTOR = '[aria-label="Side pane"]';

/**
 * The link to one subagent's page in the side pane, whose `href` ends in its
 * id. The link holds only the subagent's name; its row is the link's nearest
 * ancestor that is a direct child of a list item (see `INSTALL_DURATION_OBSERVER`).
 */
const PANE_ROW_SELECTOR = 'a[href*="/subagents/"]';

/**
 * The text of a row's duration, as `formatDuration` in `@hercule/client-core`
 * writes it: "31s", "12m 4s" or "1h 4m". A row's duration is the element in
 * the row with no child elements whose whole text matches it. A data hook on
 * the duration would be sturdier; the row has none yet.
 */
const DURATION_PATTERN = String.raw`^(\d+h \d+m|\d+m \d+s|\d+s)$`;

/** A thread's row in the sidebar. */
const SIDEBAR_ROW_SELECTOR = "a.side-row";

/** How many subagents the thread has, and how many of them run. */
const SUBAGENT_COUNT = 20;
const RUNNING_COUNT = 4;

/**
 * The positions, counting from 0 in the order they start, of the subagents
 * that keep running. The pane lists the oldest first, so the first three are
 * at its top, on screen. The last is at its bottom, which is off screen when
 * the pane is too short for 20 rows, so the scenario can check that a running
 * row off screen does not tick.
 */
const RUNNING_POSITIONS: ReadonlySet<number> = new Set([0, 1, 2, SUBAGENT_COUNT - 1]);

/** The positions of the subagents that fail; every other subagent that ends completes. */
const FAILED_POSITIONS: ReadonlySet<number> = new Set([5, 11]);

/** How long a running subagent's command runs: longer than the whole scenario. */
const KEEPS_RUNNING_MS = 3_600_000;

/** The message that opens the turn that starts the subagents. */
const SUBAGENTS_QUESTION = "Review every module before the release.";

/** The message that opens a turn whose one subagent changes quickly (see `buildBurstTurn`). */
const BURST_QUESTION = "Run the quick checks one by one.";

/** How many commands the burst's subagent runs, and how long each takes. */
const BURST_COMMANDS = 40;
const BURST_COMMAND_MS = 250;

/** The burst subagent's id. It is new to each thread the burst plays in. */
const BURST_SUBAGENT_ID = "quick-checks";

/** How long after a navigation, or a change of visibility, the page is given before its topics are read. */
const TOPIC_SETTLE_MS = 2_000;

/** How long the window is shown again before the next reading, so the page has redrawn. */
const SHOW_SETTLE_MS = 3_000;

/**
 * How long after the last subagent ended the samples start. The page reads
 * the subagents again on the nudge that the stop causes, which the controller
 * sends up to a second late, and draws the rows ended.
 */
const ENDED_SETTLE_MS = 5_000;

/** How long after a burst's turn completed its reads are counted, so the last nudge's read is in. */
const BURST_SETTLE_MS = 2_000;

/** Builds the id of the subagent at `position`, counting from 0. */
const buildSubagentId = (position: number): string =>
  `review-${String(position + 1).padStart(2, "0")}`;

/**
 * Builds the turn that starts the thread's subagents: all 20 in the
 * background, so the session's own agent ends its turn at once. The ones at
 * `RUNNING_POSITIONS` run a command for an hour; the others end within a
 * second, those at `FAILED_POSITIONS` failed and the rest completed.
 */
function buildSubagentsTurn(): ScriptStep[] {
  const subagents = Array.from({ length: SUBAGENT_COUNT }, (_, position): ScriptStep => {
    const running = RUNNING_POSITIONS.has(position);
    const steps: ScriptStep[] = [
      { kind: "message", text: `Reading module ${String(position + 1)}.`, deltaMs: 0 },
      { kind: "command", command: "pnpm test", forMs: running ? KEEPS_RUNNING_MS : 0 },
    ];
    if (FAILED_POSITIONS.has(position)) steps.push({ kind: "end", state: "failed" });
    return {
      kind: "subagent",
      subagentId: buildSubagentId(position),
      description: `Review module ${String(position + 1)}`,
      agentType: "Explore",
      brief: `Review module ${String(position + 1)} and list what blocks the release.`,
      background: true,
      steps,
    };
  });
  return [
    { kind: "message", text: "I'll hand each module to a subagent.", deltaMs: 0 },
    ...subagents,
    { kind: "end", state: "completed" },
  ];
}

/**
 * Builds a turn with one subagent, in the foreground, that runs 40 commands
 * of 250 ms each. Each command changes the subagent's activity, so its
 * session's `subagent` record changes four times a second for 10 s.
 */
function buildBurstTurn(): ScriptStep[] {
  return [
    {
      kind: "subagent",
      subagentId: BURST_SUBAGENT_ID,
      description: "Run the quick checks",
      brief: "Run each quick check once.",
      steps: Array.from({ length: BURST_COMMANDS }, (_, index): ScriptStep => ({
        kind: "command",
        command: `pnpm check ${String(index + 1)}`,
        forMs: BURST_COMMAND_MS,
      })),
    },
    { kind: "end", state: "completed" },
  ];
}

/** The topics of one agent's transcript and taps, as `@hercule/contract` builds them. */
const buildThreadTopics = (sessionId: string) => ({
  stream: `session:${sessionId}:stream`,
  tap: `session:${sessionId}:tap`,
});
const buildSubagentTopics = (sessionId: string, subagentId: string) => ({
  stream: `session:${sessionId}:subagent:${subagentId}:stream`,
  tap: `session:${sessionId}:subagent:${subagentId}:tap`,
});

/** How many times each pane row's duration text changed in one sample. */
interface DurationCounts {
  /** How long the count ran, in milliseconds. */
  readonly ms: number;
  /** The changes of each row, by subagent id. A row that did not change counts 0. */
  readonly byRow: ReadonlyMap<string, number>;
}

/** One sample of the app with the pane open: each process's use, and the rows' duration changes. */
interface PaneSample {
  readonly use: ProcessUse[];
  readonly durations: DurationCounts;
}

/** The live topics the page held at one step, and what the step expects. */
interface TopicStep {
  /** The step, such as "a subagent's page, window hidden". */
  readonly name: string;
  /** `document.visibilityState` at the step. */
  readonly visibility: string;
  /** Every topic subscribed since the recording started and not unsubscribed since, sorted. */
  readonly held: readonly string[];
  /** The topics the step expects held. */
  readonly holds: readonly string[];
  /** The topics the step expects not held. */
  readonly lacks: readonly string[];
}

/** What the open thread's subagents were read again for, while a subagent changed for 10 s. */
interface NudgeReads {
  /** How long from the burst's message until its turn completed, in milliseconds. */
  readonly burstMs: number;
  /** How many times the page read the open thread's subagents. */
  readonly openThreadReads: number;
  /** How many times the page read the other thread's subagents. */
  readonly otherThreadReads: number;
  /** How many pushes the page received on its `subagent` subscription. */
  readonly subagentPushes: number;
}

/** What the subagent scenario measured. */
export interface SubagentLaunch {
  /** The thread the app had open: its title, and how many rows the pane showed. */
  readonly threadTitle: string;
  readonly paneRows: number;
  /** The rows that ran in the first two samples, by subagent id, and whether each was on screen. */
  readonly runningRows: ReadonlyMap<string, boolean>;
  readonly loadAtSpawn: number;
  /** Each process's memory, 13 s after the page opened, with the thread open and the pane closed. */
  readonly memoryPaneClosed: ProcessMemory[];
  /** Each process's memory, 13 s after the pane opened. */
  readonly memoryPaneOpen: ProcessMemory[];
  readonly runningVisible: PaneSample;
  readonly runningHidden: PaneSample;
  readonly endedVisible: PaneSample;
  readonly endedHidden: PaneSample;
  readonly topics: readonly TopicStep[];
  /** The reads while another thread's subagent changed. */
  readonly otherThreadBurst: NudgeReads;
  /** The reads while one of the open thread's own subagents changed. */
  readonly openThreadBurst: NudgeReads;
}

/** A thread the scenario uses: its id and its title in the sidebar. */
interface ScenarioThread {
  readonly id: string;
  readonly title: string;
}

/**
 * Plays the scenario's subagents into one idle thread of `fixture`, the
 * thread with id `longThreadId` excepted, opens that thread in the signed-in
 * app on `userDataDir`, and measures one plain launch of the app on it (see
 * the top of this file). Run it after every other launch: it leaves the
 * subagents behind.
 *
 * Fails when the subagents do not settle in 30 s, when the app does not
 * open the thread with its pane closed, when the pane does not show the 20
 * rows, when a topic or a visibility the steps wait for does not come, when
 * the subagents' script fails, or when the app does not quit cleanly.
 */
export async function measureSubagentLaunch(
  userDataDir: string,
  fixture: ThreadFixture,
  longThreadId: string,
): Promise<SubagentLaunch> {
  const { call } = fixture;
  const idle = (
    await call<{ readonly items: readonly Session[] }>("GET", "/sessions?thread=true&limit=500")
  ).items.filter((thread) => thread.status === "idle" && thread.id !== longThreadId);
  const [open, other] = idle;
  if (open === undefined || other === undefined) {
    throw new Error("the controller has fewer than two idle threads to play subagents into");
  }
  const readSubagents = async (sessionId: string): Promise<readonly Subagent[]> =>
    (
      await call<{ readonly items: readonly Subagent[] }>(
        "GET",
        `/sessions/${sessionId}/subagents?limit=100`,
      )
    ).items;

  const { played } = await fixture.playTurn(open.id, SUBAGENTS_QUESTION, buildSubagentsTurn());
  // The script settles only once the running subagents are stopped, so a
  // failure before that is caught here and reported when it is awaited.
  const settled = played.then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
  const runningIds = [...RUNNING_POSITIONS].map(buildSubagentId);
  await pollUntil(
    async () => {
      const subagents = await readSubagents(open.id);
      const running = subagents.filter((subagent) => subagent.status === "running");
      return subagents.length === SUBAGENT_COUNT &&
        running.length === RUNNING_COUNT &&
        running.every((subagent) => runningIds.includes(subagent.id))
        ? true
        : undefined;
    },
    {
      timeoutMs: 30_000,
      intervalMs: 100,
      timeoutMessage: `the thread never had ${String(SUBAGENT_COUNT)} subagents with ${String(RUNNING_COUNT)} running`,
    },
  );

  await openThreadOnce(userDataDir, open.title);
  await warmUpApp(userDataDir);
  const loadAtSpawn = loadavg()[0]!;
  const app = await launchPlainApp(userDataDir);
  const { inspectorUrl } = app;
  let measured: SubagentLaunch;
  try {
    const pageSocketUrl = await waitForPageSocketUrl(app.endpoint);
    const pageOpenedAt = Date.now();
    const sleepUntil = (at: number) => sleep(Math.max(0, at - Date.now()));
    const waitInPage = (expression: string, timeoutMessage: string) =>
      pollUntil(
        async () => ((await evaluateInPage(pageSocketUrl, expression)) === true ? true : undefined),
        { timeoutMs: 10_000, intervalMs: 100, timeoutMessage },
      );
    const callWindow = (method: "hide" | "showInactive") =>
      evaluateInMain(
        inspectorUrl,
        `require("electron").BrowserWindow.getAllWindows()[0]?.${method}()`,
      );

    await waitInPage(READ_THREAD_SHOWN, "the app did not open the last open thread");
    if ((await evaluateInPage(pageSocketUrl, READ_PANE_OPEN)) === true) {
      throw new Error("the side pane was open at launch; each thread starts with it closed");
    }
    await sleepUntil(pageOpenedAt + MEMORY_READ_AT_MS);
    const memoryPaneClosed = await readProcessMemory(app.process.pid!);

    await evaluateInPage(
      pageSocketUrl,
      `document.querySelector(${JSON.stringify(PANE_TOGGLE_SELECTOR)})?.click()`,
    );
    await waitInPage(
      `document.querySelectorAll(${JSON.stringify(`${SIDE_PANE_SELECTOR} ${PANE_ROW_SELECTOR}`)}).length >= ${String(SUBAGENT_COUNT)}`,
      `the side pane did not show ${String(SUBAGENT_COUNT)} rows`,
    );
    const paneOpenedAt = Date.now();
    const rows = (await evaluateInPage(pageSocketUrl, INSTALL_DURATION_OBSERVER)) as {
      id: string;
      onScreen: boolean;
    }[];
    const runningRows = new Map(
      rows.filter((row) => runningIds.includes(row.id)).map((row) => [row.id, row.onScreen]),
    );
    await sleepUntil(paneOpenedAt + MEMORY_READ_AT_MS);
    const memoryPaneOpen = await readProcessMemory(app.process.pid!);

    /**
     * Samples each process's use for 10 s, visible or, after hiding the
     * window and letting it settle, hidden, and counts the rows' duration
     * changes from the start of the sample, or from the moment the page
     * became hidden, to its end. A tick between the call to hide and the
     * page's change of visibility is still a visible tick, so it is not
     * counted as hidden.
     */
    const samplePane = async (hidden: boolean): Promise<PaneSample> => {
      if (hidden) {
        await callWindow("hide");
        await waitInPage(`document.visibilityState === "hidden"`, "the page never became hidden");
      }
      const from = Date.now();
      if (hidden) await sleep(HIDDEN_SETTLE_MS);
      const use = await sampleIdleUse(inspectorUrl);
      const to = Date.now();
      const visible = await evaluateInMain(
        inspectorUrl,
        `require("electron").BrowserWindow.getAllWindows()[0]?.isVisible()`,
      );
      if (visible === hidden) {
        throw new Error(`the window was ${hidden ? "visible" : "hidden"} while sampled`);
      }
      if (hidden) {
        await callWindow("showInactive");
        await sleep(SHOW_SETTLE_MS);
      }
      return { use, durations: await countDurationChanges(pageSocketUrl, from, to) };
    };

    await sleepUntil(Math.max(pageOpenedAt + VISIBLE_SAMPLE_AT_MS, Date.now()));
    const runningVisible = await samplePane(false);
    const runningHidden = await samplePane(true);

    const topics = await recordHeldTopics({
      pageSocketUrl,
      inspectorUrl,
      waitInPage,
      callWindow,
      thread: open,
      subagentId: runningIds[0]!,
    });

    // The topics' steps end on the thread's page, which they drew again, so
    // the observer starts again on the new rows.
    await evaluateInPage(pageSocketUrl, INSTALL_DURATION_OBSERVER);
    for (const subagentId of runningIds) {
      await call("POST", `/sessions/${open.id}/interrupt`, { subagentId });
    }
    const failure = await settled;
    if (failure !== undefined) throw failure;
    await pollUntil(
      async () =>
        (await readSubagents(open.id)).every((subagent) => subagent.status !== "running")
          ? true
          : undefined,
      {
        timeoutMs: 10_000,
        intervalMs: 100,
        timeoutMessage: "a subagent still ran 10 s after its stop",
      },
    );
    await sleep(ENDED_SETTLE_MS);
    const endedVisible = await samplePane(false);
    const endedHidden = await samplePane(true);

    const nudges = await measureSubagentNudges(pageSocketUrl, fixture, open.id, other.id);
    measured = {
      threadTitle: open.title,
      paneRows: rows.length,
      runningRows,
      loadAtSpawn,
      memoryPaneClosed,
      memoryPaneOpen,
      runningVisible,
      runningHidden,
      endedVisible,
      endedHidden,
      topics,
      ...nudges,
    };
  } finally {
    await stopPlainApp(app);
  }
  assertExitedCleanly(app.process);
  return measured;
}

/** An expression that evaluates, in the page, to whether the page shows a thread's transcript. */
const READ_THREAD_SHOWN = `performance.getEntriesByName("first-screen").length > 0 &&
  document.querySelector('section[aria-label="Transcript"]') !== null`;

/** An expression that evaluates, in the page, to whether the side pane is on screen. */
const READ_PANE_OPEN = `document.querySelector(${JSON.stringify(SIDE_PANE_SELECTOR)}) !== null`;

/**
 * An expression that starts counting, in the page's
 * `globalThis.durationChanges`, each change of a pane row's duration text,
 * with the row's subagent id and the time, in milliseconds since the epoch.
 * It evaluates to the pane's rows, each with whether it was inside the pane's
 * visible part. Evaluated again, it stops the earlier count and starts a new
 * one on the rows drawn now.
 *
 * An observer on the pane reads every row's duration again after each change
 * inside the pane, and compares it with the text it read last. React may
 * replace a text node rather than change it, so the rows are compared by
 * their text, not by node.
 */
const INSTALL_DURATION_OBSERVER = `(() => {
  globalThis.durationObserver?.disconnect();
  const pane = document.querySelector(${JSON.stringify(SIDE_PANE_SELECTOR)});
  const pattern = new RegExp(${JSON.stringify(DURATION_PATTERN)});
  const readLinks = () => [...pane.querySelectorAll(${JSON.stringify(PANE_ROW_SELECTOR)})];
  const readId = (link) => link.getAttribute("href").split("/subagents/")[1];
  // The row holds the link and the duration side by side, and its list item
  // also holds the rows of the subagent's own subagents, so the row is the
  // item's child that holds the link, not the item.
  const readDuration = (link) =>
    [...link.closest("li > *").querySelectorAll("*")]
      .find((element) => element.childElementCount === 0 && pattern.test(element.textContent.trim()))
      ?.textContent.trim() ?? null;
  const last = new Map(readLinks().map((link) => [readId(link), readDuration(link)]));
  const changes = [];
  globalThis.durationChanges = changes;
  globalThis.durationObserver = new MutationObserver(() => {
    const at = performance.timeOrigin + performance.now();
    for (const link of readLinks()) {
      const id = readId(link);
      const text = readDuration(link);
      if (last.get(id) !== text) {
        last.set(id, text);
        changes.push({ id, at });
      }
    }
  });
  globalThis.durationObserver.observe(pane, { subtree: true, childList: true, characterData: true });
  const box = pane.getBoundingClientRect();
  return readLinks().map((link) => {
    const rowBox = link.getBoundingClientRect();
    return {
      id: readId(link),
      onScreen: rowBox.top >= box.top && rowBox.bottom <= Math.min(box.bottom, innerHeight),
    };
  });
})()`;

/**
 * Reads the duration changes the page counted (see
 * `INSTALL_DURATION_OBSERVER`) and returns, for each row, how many fell
 * between `from` and `to`, in milliseconds since the epoch.
 */
async function countDurationChanges(
  pageSocketUrl: string,
  from: number,
  to: number,
): Promise<DurationCounts> {
  const changes = (await evaluateInPage(pageSocketUrl, "globalThis.durationChanges")) as {
    id: string;
    at: number;
  }[];
  const byRow = new Map<string, number>();
  for (const { id, at } of changes) {
    if (at >= from && at < to) byRow.set(id, (byRow.get(id) ?? 0) + 1);
  }
  return { ms: to - from, byRow };
}

/**
 * An expression that starts recording the frames the page sends and receives
 * on its WebSockets, as text, in `globalThis.sentFrames` and
 * `globalThis.receivedFrames`. The live connection's socket already exists;
 * it sends through the prototype's `send`, so its frames are recorded too,
 * and its first send adds the listener that records what it receives. The
 * desktop end-to-end suite records the frames the same way.
 */
const RECORD_FRAMES = `(() => {
  const sent = [];
  const received = [];
  globalThis.sentFrames = sent;
  globalThis.receivedFrames = received;
  const listened = new WeakSet();
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (!listened.has(this)) {
      listened.add(this);
      this.addEventListener("message", (event) => {
        received.push(typeof event.data === "string" ? event.data : "");
      });
    }
    sent.push(typeof data === "string" ? data : new TextDecoder().decode(data));
    return send.call(this, data);
  };
})()`;

/**
 * An expression that evaluates, in the page, to the frames `RECORD_FRAMES`
 * recorded, parsed: `sent` and `received`, each a list of RPC messages. A
 * frame may carry one message or a list of them.
 */
const PARSE_FRAMES = `const parse = (frames) => (frames ?? []).flatMap((frame) => {
    try { return [JSON.parse(frame)].flat(); } catch { return []; }
  });
  const sent = parse(globalThis.sentFrames);
  const received = parse(globalThis.receivedFrames);`;

/**
 * An expression that evaluates, in the page, to its visibility and the live
 * topics it holds: each topic of a `Request` the page sent since the
 * recording started, unless the page has since sent an `Interrupt` for that
 * request, which unsubscribes it, or the controller has ended it with an
 * `Exit`. The topics the shell subscribed before the recording started are
 * not among them.
 */
const READ_HELD_TOPICS = `(() => {
  ${PARSE_FRAMES}
  const ended = new Set([
    ...sent.filter((message) => message?._tag === "Interrupt").map((message) => String(message.requestId)),
    ...received.filter((message) => message?._tag === "Exit").map((message) => String(message.requestId)),
  ]);
  const held = sent
    .filter((message) => message?._tag === "Request" && typeof message.payload?.topic === "string")
    .filter((message) => !ended.has(String(message.id)))
    .map((message) => message.payload.topic);
  return { visibility: document.visibilityState, held: [...new Set(held)].sort() };
})()`;

/**
 * An expression that evaluates, in the page, to how many pushes the page has
 * received on its subscriptions to the `subagent` topic since the frames
 * started being recorded.
 */
const COUNT_SUBAGENT_PUSHES = `(() => {
  ${PARSE_FRAMES}
  const ids = new Set(
    sent
      .filter((message) => message?._tag === "Request" && message.payload?.topic === "subagent")
      .map((message) => String(message.id)),
  );
  return received.filter((message) => message?._tag === "Chunk" && ids.has(String(message.requestId))).length;
})()`;

/** What `recordHeldTopics` needs of the launch. */
interface TopicRecording {
  readonly pageSocketUrl: string;
  readonly inspectorUrl: string;
  /** Waits until an expression evaluates to true in the page, and fails with the message after 10 s. */
  readonly waitInPage: (expression: string, timeoutMessage: string) => Promise<true>;
  readonly callWindow: (method: "hide" | "showInactive") => Promise<unknown>;
  /** The open thread. */
  readonly thread: ScenarioThread;
  /** The running subagent whose page is opened. */
  readonly subagentId: string;
}

/**
 * Records which live topics the page holds as it moves between pages, and
 * returns each step's topics with what the step expects. The page starts on
 * the thread's page with the pane open, and ends there.
 *
 * The recorder sees only the frames sent after it starts, and the thread's
 * subscriptions were made at launch. So the first step leaves the thread for
 * Settings and comes back, which subscribes the thread's topics again in
 * front of the recorder. The steps are:
 *
 * 1. the thread's page, back from Settings;
 * 2. a running subagent's page, opened from its pane row;
 * 3. the same page with the window hidden;
 * 4. the same page with the window shown again;
 * 5. the thread's page again, opened from the sidebar;
 * 6. Settings, where no thread is open;
 * 7. the thread's page, from the sidebar, where the scenario goes on.
 *
 * Settings opens through the `openSettings` menu command, which main sends
 * without showing the window, so the run does not take the keyboard focus.
 */
async function recordHeldTopics({
  pageSocketUrl,
  inspectorUrl,
  waitInPage,
  callWindow,
  thread,
  subagentId,
}: TopicRecording): Promise<TopicStep[]> {
  const threadTopics = buildThreadTopics(thread.id);
  const subagentTopics = buildSubagentTopics(thread.id, subagentId);
  const title = JSON.stringify(thread.title);
  const steps: TopicStep[] = [];
  const recordStep = async (
    name: string,
    { holds, lacks }: { readonly holds: readonly string[]; readonly lacks: readonly string[] },
  ) => {
    await sleep(TOPIC_SETTLE_MS);
    const { visibility, held } = (await evaluateInPage(pageSocketUrl, READ_HELD_TOPICS)) as {
      visibility: string;
      held: string[];
    };
    steps.push({ name, visibility, held, holds, lacks });
  };
  const openSettings = async () => {
    await evaluateInMain(
      inspectorUrl,
      `require("electron").BrowserWindow.getAllWindows()[0].webContents.send("menu.command", "openSettings")`,
    );
    await waitInPage(
      `document.querySelector('section[aria-label="Transcript"]') === null`,
      "Settings did not open",
    );
  };
  const openThreadFromSidebar = async () => {
    await waitInPage(
      `(() => {
        const row = [...document.querySelectorAll(${JSON.stringify(SIDEBAR_ROW_SELECTOR)})].find((link) =>
          [...link.querySelectorAll("*")].some(
            (element) => element.childElementCount === 0 && element.textContent.trim() === ${title},
          ),
        );
        row?.click();
        return row !== undefined;
      })()`,
      `the sidebar shows no row for ${thread.title}`,
    );
    await waitInPage(
      `${READ_THREAD_SHOWN} && ${READ_PANE_OPEN}`,
      `${thread.title} did not open with its side pane`,
    );
  };
  const onThreadPage = {
    holds: ["subagent", threadTopics.stream, threadTopics.tap],
    lacks: [subagentTopics.stream, subagentTopics.tap],
  };

  await evaluateInPage(pageSocketUrl, RECORD_FRAMES);
  await openSettings();
  await openThreadFromSidebar();
  await recordStep("the thread's page", onThreadPage);

  await waitInPage(
    `(() => {
      const row = document.querySelector(${JSON.stringify(`${SIDE_PANE_SELECTOR} ${PANE_ROW_SELECTOR}`)} + '[href$="/subagents/${subagentId}"]');
      row?.click();
      return row !== undefined;
    })()`,
    `the side pane shows no row for ${subagentId}`,
  );
  await recordStep(`${subagentId}'s page`, {
    holds: ["subagent", subagentTopics.stream, subagentTopics.tap],
    lacks: [threadTopics.stream, threadTopics.tap],
  });

  await callWindow("hide");
  await waitInPage(`document.visibilityState === "hidden"`, "the page never became hidden");
  await recordStep(`${subagentId}'s page, window hidden`, {
    holds: [subagentTopics.stream],
    lacks: [subagentTopics.tap, threadTopics.tap],
  });

  await callWindow("showInactive");
  await waitInPage(`document.visibilityState === "visible"`, "the page never became visible");
  await recordStep(`${subagentId}'s page, window shown again`, {
    holds: [subagentTopics.stream, subagentTopics.tap],
    lacks: [threadTopics.stream, threadTopics.tap],
  });

  await openThreadFromSidebar();
  await recordStep("the thread's page again", onThreadPage);

  await openSettings();
  await recordStep("Settings, no thread open", {
    holds: [],
    lacks: [
      "subagent",
      threadTopics.stream,
      threadTopics.tap,
      subagentTopics.stream,
      subagentTopics.tap,
    ],
  });

  await openThreadFromSidebar();
  return steps;
}

/**
 * Plays a burst into the other thread `otherId`, then into the open thread
 * `openId` (see `buildBurstTurn`), and returns, for each, how often the page
 * read each thread's subagents and how many `subagent` pushes it received
 * from the burst's message until 2 s after its turn completed.
 *
 * The other thread's burst should cause no read: a nudge causes a read only
 * when it names the open thread. The open thread's should cause at most one
 * read a second, because the controller sends at most one nudge per session
 * per second. The reads are counted from the page's resource timing entries,
 * which are cleared first: the browser keeps only 250 of them, and the launch
 * has made many requests by then.
 */
async function measureSubagentNudges(
  pageSocketUrl: string,
  fixture: ThreadFixture,
  openId: string,
  otherId: string,
): Promise<{ readonly otherThreadBurst: NudgeReads; readonly openThreadBurst: NudgeReads }> {
  const countReads = async (sessionId: string): Promise<number> =>
    (await evaluateInPage(
      pageSocketUrl,
      `performance.getEntriesByType("resource").filter(
        (entry) => new URL(entry.name).pathname === "/api/v1/sessions/${sessionId}/subagents",
      ).length`,
    )) as number;
  const countPushes = async (): Promise<number> =>
    (await evaluateInPage(pageSocketUrl, COUNT_SUBAGENT_PUSHES)) as number;

  const playBurst = async (sessionId: string): Promise<NudgeReads> => {
    await evaluateInPage(pageSocketUrl, "performance.clearResourceTimings()");
    const pushesBefore = await countPushes();
    const startedAt = Date.now();
    const { played } = await fixture.playTurn(sessionId, BURST_QUESTION, buildBurstTurn());
    await played;
    const burstMs = Date.now() - startedAt;
    await sleep(BURST_SETTLE_MS);
    return {
      burstMs,
      openThreadReads: await countReads(openId),
      otherThreadReads: await countReads(otherId),
      subagentPushes: (await countPushes()) - pushesBefore,
    };
  };

  return { otherThreadBurst: await playBurst(otherId), openThreadBurst: await playBurst(openId) };
}

/** Sums the footprint of every process, and returns it with the renderer's, in MB. */
function sumFootprints(memory: readonly ProcessMemory[]): { summed: number; renderer: number } {
  return {
    summed: memory.reduce((sum, sample) => sum + sample.footprintMb, 0),
    renderer: memory.find((sample) => sample.label === "Tab")?.footprintMb ?? 0,
  };
}

/** Formats each row's duration changes for the rows in `ids`, such as "review-01 10, review-02 9". */
function formatRowChanges(durations: DurationCounts, ids: readonly string[]): string {
  if (ids.length === 0) return "no such row";
  return ids.map((id) => `${id} ${String(durations.byRow.get(id) ?? 0)}`).join(", ");
}

/** Prints what the subagent scenario measured, against spec 17 §What subagents cost. */
export function reportSubagentLaunch(measured: SubagentLaunch): void {
  const { runningVisible, runningHidden, endedVisible, endedHidden } = measured;
  const closed = sumFootprints(measured.memoryPaneClosed);
  const opened = sumFootprints(measured.memoryPaneOpen);
  const processes = Math.max(measured.memoryPaneClosed.length, measured.memoryPaneOpen.length);
  const rendererLimit = `no wakeups from the app (at most ${String(BUDGET.rendererWakeups)}/s)`;
  const readWakeups = (sample: PaneSample, type: string) =>
    findProcessUse(sample.use, type)?.wakeupsPerSecond ?? 0;

  const onScreen = [...measured.runningRows].filter(([, shown]) => shown).map(([id]) => id);
  const offScreen = [...measured.runningRows].filter(([, shown]) => !shown).map(([id]) => id);
  const runningIds = [...measured.runningRows.keys()];
  // A duration under an hour changes once a second, so a 10 s count sees 9
  // to 11 changes, depending on where the count starts within a second.
  const visibleSeconds = runningVisible.durations.ms / 1_000;
  const minTicks = Math.floor(visibleSeconds) - 1;
  const maxTicks = Math.ceil(visibleSeconds) + 1;
  const ticksWithin = onScreen.every((id) => {
    const ticks = runningVisible.durations.byRow.get(id) ?? 0;
    return ticks >= minTicks && ticks <= maxTicks;
  });
  const endedIds = (sample: PaneSample) =>
    [...sample.durations.byRow.keys()].filter((id) => !runningIds.includes(id));
  const countAll = (sample: PaneSample) =>
    [...sample.durations.byRow.values()].reduce((sum, count) => sum + count, 0);
  const { otherThreadBurst, openThreadBurst } = measured;
  const burstSeconds = openThreadBurst.burstMs / 1_000;
  const maxNudges = Math.ceil(burstSeconds) + 1;

  // Budget, limit, measured, and whether the measurement is within the
  // limit, or null for a measure that is recorded but has no budget.
  const budgets: [string, string, string, boolean | null][] = [
    [
      "Processes",
      `none added: ${String(BUDGET.processes)}`,
      `${String(processes)}: ${measured.memoryPaneOpen.map((sample) => sample.label).join(", ")}`,
      processes <= BUDGET.processes,
    ],
    [
      "Footprint, summed, pane closed",
      `at most ${String(BUDGET.summedFootprintMb)} MB`,
      `${closed.summed.toFixed(0)} MB`,
      closed.summed <= BUDGET.summedFootprintMb,
    ],
    [
      "Footprint, renderer, pane closed",
      `at most ${String(BUDGET.rendererFootprintMb)} MB`,
      `${closed.renderer.toFixed(0)} MB`,
      closed.renderer <= BUDGET.rendererFootprintMb,
    ],
    [
      `Footprint, summed, pane open on ${String(measured.paneRows)} rows`,
      `at most ${String(BUDGET.summedFootprintMb)} MB`,
      `${opened.summed.toFixed(0)} MB (${(opened.summed - closed.summed).toFixed(1)} MB more)`,
      opened.summed <= BUDGET.summedFootprintMb,
    ],
    [
      `Footprint, renderer, pane open on ${String(measured.paneRows)} rows`,
      `at most ${String(BUDGET.rendererFootprintMb)} MB`,
      `${opened.renderer.toFixed(0)} MB (${(opened.renderer - closed.renderer).toFixed(1)} MB more)`,
      opened.renderer <= BUDGET.rendererFootprintMb,
    ],
    [
      "Idle visible, renderer, 4 running",
      "recorded; running rows tick",
      `${readWakeups(runningVisible, "Tab").toFixed(1)}/s`,
      null,
    ],
    [
      "Idle visible, GPU, 4 running",
      "recorded; running rows tick",
      `${readWakeups(runningVisible, "GPU").toFixed(1)}/s`,
      null,
    ],
    [
      "Idle hidden, renderer, 4 running",
      rendererLimit,
      `${readWakeups(runningHidden, "Tab").toFixed(1)}/s`,
      readWakeups(runningHidden, "Tab") <= BUDGET.rendererWakeups,
    ],
    [
      "Idle visible, renderer, every subagent ended",
      rendererLimit,
      `${readWakeups(endedVisible, "Tab").toFixed(1)}/s`,
      readWakeups(endedVisible, "Tab") <= BUDGET.rendererWakeups,
    ],
    [
      "Idle visible, GPU, every subagent ended",
      `at most ${String(BUDGET.gpuWakeupsVisible)} wakeups/s`,
      `${readWakeups(endedVisible, "GPU").toFixed(1)}/s`,
      readWakeups(endedVisible, "GPU") <= BUDGET.gpuWakeupsVisible,
    ],
    [
      "Idle hidden, renderer, every subagent ended",
      rendererLimit,
      `${readWakeups(endedHidden, "Tab").toFixed(1)}/s`,
      readWakeups(endedHidden, "Tab") <= BUDGET.rendererWakeups,
    ],
    [
      `Durations, running rows on screen, visible ${visibleSeconds.toFixed(1)} s`,
      `once a second: ${String(minTicks)} to ${String(maxTicks)} changes each`,
      formatRowChanges(runningVisible.durations, onScreen),
      onScreen.length === 0 ? null : ticksWithin,
    ],
    [
      "Durations, running rows off screen, visible",
      "0 changes",
      offScreen.length === 0
        ? "not checked: every running row was on screen"
        : formatRowChanges(runningVisible.durations, offScreen),
      offScreen.length === 0
        ? null
        : offScreen.every((id) => (runningVisible.durations.byRow.get(id) ?? 0) === 0),
    ],
    [
      "Durations, ended rows, 4 running, visible",
      "0 changes",
      endedIds(runningVisible).length === 0
        ? "0"
        : formatRowChanges(runningVisible.durations, endedIds(runningVisible)),
      endedIds(runningVisible).length === 0,
    ],
    [
      "Durations, every row, 4 running, hidden",
      "0 changes",
      String(countAll(runningHidden)),
      countAll(runningHidden) === 0,
    ],
    [
      "Durations, every row, every subagent ended",
      "0 changes, visible and hidden",
      `${String(countAll(endedVisible))} visible, ${String(countAll(endedHidden))} hidden`,
      countAll(endedVisible) === 0 && countAll(endedHidden) === 0,
    ],
    [
      "Nudges, another thread's subagent changes",
      "0 reads of the open thread's subagents",
      `${String(otherThreadBurst.openThreadReads)} in ${(otherThreadBurst.burstMs / 1_000).toFixed(1)} s ` +
        `(${String(otherThreadBurst.otherThreadReads)} of the other thread's, ${String(otherThreadBurst.subagentPushes)} pushes)`,
      otherThreadBurst.openThreadReads === 0 && otherThreadBurst.otherThreadReads === 0,
    ],
    [
      "Nudges, the open thread's subagent changes 4 times a second",
      `at most one push and one read a second: ${String(maxNudges)}`,
      `${String(openThreadBurst.subagentPushes)} pushes, ${String(openThreadBurst.openThreadReads)} reads in ${burstSeconds.toFixed(1)} s`,
      openThreadBurst.subagentPushes <= maxNudges && openThreadBurst.openThreadReads <= maxNudges,
    ],
  ];

  const topicRows = measured.topics.map((step) => {
    const missing = step.holds.filter((topic) => !step.held.includes(topic));
    const extra = step.lacks.filter((topic) => step.held.includes(topic));
    const problems = [
      ...missing.map((topic) => `missing ${topic}`),
      ...extra.map((topic) => `also ${topic}`),
    ];
    return [
      step.name,
      step.visibility,
      step.held.length === 0 ? "none" : step.held.join(", "),
      problems.length === 0 ? "yes" : problems.join("; "),
    ];
  });

  const processLabels = [
    ...new Map(
      [runningVisible, runningHidden, endedVisible, endedHidden]
        .flatMap((sample) => sample.use)
        .map((sample) => [sample.pid, sample.label]),
    ),
  ];
  const useRows = processLabels.map(([pid, label]) => [
    label,
    String(pid),
    ...[runningVisible, runningHidden, endedVisible, endedHidden].map((sample) => {
      const use = sample.use.find((entry) => entry.pid === pid);
      return use === undefined
        ? "-"
        : `${use.cpuPercent.toFixed(1)} / ${use.wakeupsPerSecond.toFixed(1)}`;
    }),
  ]);

  console.log(
    `## Subagents: ${measured.threadTitle} open, ${String(SUBAGENT_COUNT)} subagents, ${String(RUNNING_COUNT)} running`,
  );
  console.log();
  console.log(`Load average over the minute before the launch: ${measured.loadAtSpawn.toFixed(2)}`);
  console.log();
  console.log("Memory, 13 s after the page opened (pane closed) and 13 s after the pane opened:");
  console.log(
    formatTable(
      ["Process", "PID", "Footprint MB, pane closed", "Footprint MB, pane open"],
      measured.memoryPaneOpen.map((sample) => [
        sample.label,
        String(sample.pid),
        measured.memoryPaneClosed
          .find((entry) => entry.label === sample.label)
          ?.footprintMb.toFixed(1) ?? "-",
        sample.footprintMb.toFixed(1),
      ]),
    ),
  );
  console.log();
  console.log("CPU % / wakeups a second over 10 s, with the pane open:");
  console.log(
    formatTable(
      [
        "Process",
        "PID",
        "4 running, visible",
        "4 running, hidden",
        "all ended, visible",
        "all ended, hidden",
      ],
      useRows,
    ),
  );
  console.log();
  console.log(
    "Live topics the page held at each step. The shell's own topics were subscribed before the recording started, so they are not listed:",
  );
  console.log(formatTable(["Step", "Visibility", "Held", "As expected"], topicRows));
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
