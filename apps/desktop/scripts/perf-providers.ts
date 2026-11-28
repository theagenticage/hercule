/**
 * The desktop perf script's Providers scenario: what one usage update costs
 * while Settings › Providers is open (spec 17 §The Providers page's budgets).
 *
 * A running thread's harness reports the Claude account's 5-hour usage (the
 * fixture's `reportClaudeFiveHourUsage`, which sends the runner protocol's
 * `accountUsageReported` frame), so the controller stores the reading and
 * announces the account on the `provider` topic, as it does for a real
 * report. Ten updates are measured, a second apart. For each update the
 * scenario records:
 *
 * - the reads the page made, from its resource timing entries;
 * - the time from the report until the frame that draws the new reading;
 * - the time the renderer's main thread spent running tasks from the report
 *   until 1 s later, from the page's DevTools performance metrics.
 *   It also holds whatever the renderer did while idle in that time, so it
 *   errs high; the same window with no update is measured first, to read
 *   that noise off;
 * - the longest task the page ran in that time, from a long task observer;
 * - which cards had a change in their markup. React does not touch the
 *   markup of a card it draws again to the same result, so this is the cards
 *   whose output changed, not a count of how often each card's function ran.
 *   The page's integration test counts the calls that work out a card's
 *   usage.
 *
 * It runs on plain Node, like the perf script, so its imports name the `.ts`
 * file.
 */
import { loadavg } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import {
  assertExitedCleanly,
  connectInspector,
  launchPlainApp,
  stopPlainApp,
  type Inspector,
} from "./packaged-app.ts";
import type { ThreadFixture } from "./perf-fixture.ts";
import { warmUpApp, waitForPageSocketUrl } from "./perf-measures.ts";
import { readMainThreadMs } from "./perf-workflows.ts";
import { pollUntil } from "./poll.ts";

/** How many usage updates are measured, and how far apart they start. */
const UPDATE_COUNT = 10;
const UPDATE_INTERVAL_MS = 1_000;

/** How long after an update the page is watched, and then read once. */
const SETTLE_MS = 1_000;

/** The 5-hour usage of the first update, in percent; each later update adds one. */
const FIRST_UPDATE_PERCENT = 40;

/**
 * A script that watches the page's cards. Each change to the markup of a
 * card is recorded as the card's position in the list, and the first change
 * after `arm()` starts the wait for the next frame, so `record.frameAt` is
 * the time, in milliseconds since the epoch, of the frame that follows the
 * change. It also records the longest long task since `arm()`. The script
 * is text, not a function, because this file is type-checked without the
 * browser's types.
 */
const WATCH_CARDS = `(() => {
  const cards = document.querySelector(".pa-cards");
  const record = { changedCards: new Set(), frameAt: null, longestTaskMs: 0 };
  globalThis.usageUpdate = record;
  globalThis.armUsageUpdate = () => {
    performance.clearResourceTimings();
    record.changedCards.clear();
    record.frameAt = null;
    record.longestTaskMs = 0;
  };
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const node = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
      const card = node.closest(".pa-card");
      if (card !== null) record.changedCards.add([...cards.children].indexOf(card));
    }
    requestAnimationFrame(() => {
      record.frameAt ??= performance.timeOrigin + performance.now();
    });
  }).observe(cards, { subtree: true, childList: true, characterData: true, attributes: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) record.longestTaskMs = Math.max(record.longestTaskMs, entry.duration);
  }).observe({ type: "longtask" });
})()`;

/** Reads what `WATCH_CARDS` recorded, and the reads the page made since `armUsageUpdate()`. */
const READ_UPDATE = `({
  changedCards: [...globalThis.usageUpdate.changedCards].toSorted(),
  frameAt: globalThis.usageUpdate.frameAt,
  longestTaskMs: globalThis.usageUpdate.longestTaskMs,
  reads: performance.getEntriesByType("resource").map((entry) => new URL(entry.name).pathname),
})`;

/** What the page recorded after one update. */
interface RecordedUpdate {
  readonly changedCards: readonly number[];
  readonly frameAt: number | null;
  readonly longestTaskMs: number;
  readonly reads: readonly string[];
}

/** What one usage update cost the page. */
interface UpdateCost {
  /** From the report until the frame that draws the new reading, in milliseconds. */
  readonly toFrameMs: number;
  /** The renderer main thread's task time from the report until `SETTLE_MS` later, in milliseconds. */
  readonly mainThreadMs: number;
  /** The longest task the page ran in that time, in milliseconds. */
  readonly longestTaskMs: number;
  /** The paths of the reads the page made. */
  readonly reads: readonly string[];
  /** The positions, in the list of cards, of the cards whose markup changed. */
  readonly changedCards: readonly number[];
}

/** What the scenario measured. */
export interface AccountUsageUpdates {
  readonly loadAtSpawn: number;
  /** How many cards the page drew. */
  readonly cardCount: number;
  /** The renderer main thread's task time over a window with no update, in milliseconds. */
  readonly idleMainThreadMs: number;
  readonly updates: readonly UpdateCost[];
}

/**
 * Measures `UPDATE_COUNT` usage updates of the Claude account with the app
 * open on Settings › Providers, on the launch `fixture.prepareLaunch` made
 * with `providerAccounts`. Returns what they cost.
 *
 * `openProviders` opens Settings › Providers in the app whose inspector and
 * page are at the two URLs it is given, and returns once the section has
 * rendered. Settings is never restored at launch, so the section is opened by
 * the script, as the Providers launch does.
 *
 * Fails when the page draws no card, when an update does not change a card,
 * or when the app does not quit cleanly afterwards.
 */
export async function measureAccountUsageUpdates(
  userDataDir: string,
  fixture: ThreadFixture,
  openProviders: (inspectorUrl: string, pageSocketUrl: string) => Promise<unknown>,
): Promise<AccountUsageUpdates> {
  await warmUpApp(userDataDir);
  const loadAtSpawn = loadavg()[0]!;
  const app = await launchPlainApp(userDataDir);
  let measured: AccountUsageUpdates;
  try {
    const pageSocketUrl = await waitForPageSocketUrl(app.endpoint);
    await openProviders(app.inspectorUrl, pageSocketUrl);
    const page = await connectInspector(pageSocketUrl);
    try {
      measured = await measureUpdates(page, fixture, loadAtSpawn);
    } finally {
      page.close();
    }
  } finally {
    await stopPlainApp(app);
  }
  assertExitedCleanly(app.process);
  return measured;
}

/** Measures the updates over the connection `page` to the app's page, which shows Providers. */
async function measureUpdates(
  page: Inspector,
  fixture: ThreadFixture,
  loadAtSpawn: number,
): Promise<AccountUsageUpdates> {
  const evaluate = (expression: string) =>
    page.evaluate("Runtime.evaluate", { expression, returnByValue: true });
  await pollUntil(
    async () =>
      (await evaluate(`document.querySelectorAll(".pa-card").length`)) === 0 ? undefined : true,
    { timeoutMs: 10_000, intervalMs: 100, timeoutMessage: "Settings › Providers drew no card" },
  );
  const cardCount = (await evaluate(`document.querySelectorAll(".pa-card").length`)) as number;
  await page.send("Performance.enable");
  await evaluate(WATCH_CARDS);
  // Let the page finish what it does when it opens before anything is timed.
  await sleep(3_000);

  const readTaskTime = () => readMainThreadMs(page);
  const idleFrom = await readTaskTime();
  await sleep(SETTLE_MS);
  const idleMainThreadMs = (await readTaskTime()) - idleFrom;

  const updates: UpdateCost[] = [];
  for (let update = 0; update < UPDATE_COUNT; update += 1) {
    await evaluate("globalThis.armUsageUpdate()");
    const taskTimeBefore = await readTaskTime();
    const reportedAt = Date.now();
    fixture.reportClaudeFiveHourUsage(FIRST_UPDATE_PERCENT + update);
    // The page is read once, after the update has settled: polling for the
    // frame would add tasks of its own to the time that is measured.
    await sleep(SETTLE_MS);
    const recorded = (await evaluate(READ_UPDATE)) as RecordedUpdate;
    if (recorded.frameAt === null) {
      throw new Error(
        `usage update ${String(update + 1)} changed no card within ${String(SETTLE_MS)} ms`,
      );
    }
    updates.push({
      toFrameMs: recorded.frameAt - reportedAt,
      mainThreadMs: (await readTaskTime()) - taskTimeBefore,
      longestTaskMs: recorded.longestTaskMs,
      reads: recorded.reads,
      changedCards: recorded.changedCards,
    });
    await sleep(Math.max(0, reportedAt + UPDATE_INTERVAL_MS - Date.now()));
  }
  return { loadAtSpawn, cardCount, idleMainThreadMs, updates };
}

/** Returns the median and the largest of `values`, which must not be empty. */
const summarize = (values: readonly number[]): { median: number; max: number } => {
  const sorted = values.toSorted((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)]!, max: sorted.at(-1)! };
};

/** Returns each distinct string of `values` with how many times it occurs, in the order each first appears. */
const tally = (values: readonly string[]): Array<[string, number]> => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts];
};

/** Prints what the Providers scenario measured, as spec 17 §The Providers page's budgets asks. */
export function reportAccountUsageUpdates(measured: AccountUsageUpdates): void {
  const { updates } = measured;
  const readCounts = summarize(updates.map((update) => update.reads.length));
  const readPaths = tally(updates.flatMap((update) => update.reads))
    .map(([path, count]) => `${path} ${String(count)}`)
    .join(", ");
  const toFrame = summarize(updates.map((update) => update.toFrameMs));
  const mainThread = summarize(updates.map((update) => update.mainThreadMs));
  const longestTask = summarize(updates.map((update) => update.longestTaskMs));
  const changedCards = tally(updates.map((update) => update.changedCards.join("+")))
    .map(([cards, count]) => `card ${cards === "" ? "none" : cards} in ${String(count)}`)
    .join(", ");
  console.log(
    `## Providers: ${String(UPDATE_COUNT)} usage updates of the Claude account with ${String(measured.cardCount)} cards open\n`,
  );
  console.log(
    `Load average over the minute before the launch: ${measured.loadAtSpawn.toFixed(2)}\n`,
  );
  console.log("| Measure | Result |\n| --- | --- |");
  console.log(
    `| Reads an update | median ${String(readCounts.median)}, most ${String(readCounts.max)} (${readPaths} for ${String(UPDATE_COUNT)}) |`,
  );
  console.log(
    `| From the report to the frame that draws it | median ${toFrame.median.toFixed(0)} ms, longest ${toFrame.max.toFixed(0)} ms |`,
  );
  console.log(
    `| Renderer main thread, until ${String(SETTLE_MS)} ms after the report | median ${mainThread.median.toFixed(1)} ms, longest ${mainThread.max.toFixed(1)} ms (the same window with no update: ${measured.idleMainThreadMs.toFixed(1)} ms) |`,
  );
  console.log(
    `| Longest task in that time | median ${longestTask.median.toFixed(1)} ms, longest ${longestTask.max.toFixed(1)} ms |`,
  );
  console.log(`| Cards whose markup changed (position in the list) | ${changedCards} |`);
  console.log();
}
