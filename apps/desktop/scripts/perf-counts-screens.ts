/**
 * The screens part of the counts check (scripts/perf-counts.ts): drives the
 * Inbox and Work on the counts page (src/renderer/specimens/perf-counts.tsx)
 * in one Playwright Chromium, step by step, and returns what each step cost.
 *
 * For each step it counts:
 *
 * - `requests`: the requests the app sent the fake controller;
 * - `restyled`: the elements Chromium restyled, summed over every style
 *   recalculation of the step, read from a trace of the step;
 * - `renders`: the components React rendered, and `rowRenders`, those of the
 *   screen's row or card component alone;
 * - `elements`: the elements in the document once the step has settled.
 *
 * After the screen opens and has been quiet for a second, it also counts what
 * would keep the page working while idle: the running intervals, the pending
 * timeouts (within a second, and later), and the pending animation frames.
 *
 * Every step checks that it did what it is named for, such as a row becoming
 * current or a thing leaving the list, so a step that did nothing cannot pass
 * with a count of zero. A step has settled when what it waits for is on
 * screen, no read or write is running, no animation frame or animation that
 * ends is pending, and two frames have passed with no new request.
 *
 * It runs on plain Node, like the other scripts, so its imports name the
 * `.ts` file.
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { CDPSession, Page } from "playwright";
import type { PerfCountsPage, ProbeReading } from "../src/renderer/specimens/perf-counts-page.ts";
import { launchCaptureBrowser } from "./ui-capture.ts";

/** The window the page is drawn in, the app's default size. */
const WINDOW = { width: 1440, height: 900 } as const;

/** How long a step may take to settle before the check fails, in milliseconds. */
const STEP_TIMEOUT_MS = 30_000;

/** How many rows the J walk steps over. The Inbox holds 300, so the walk never reaches the end. */
const INBOX_WALK = 50;

/** How many cards the J walk on Work steps over. */
const WORK_WALK = 10;

/** What one step cost. */
export interface StepCounts {
  readonly requests: number;
  readonly restyled: number;
  readonly renders: number;
  readonly rowRenders: number;
  readonly elements: number;
  /** The requests of the step, as `METHOD /path`, for the report. */
  readonly requestList: readonly string[];
  /** The renders of each component in the step, by name, for the report and `steps.json`. */
  readonly renderList: Readonly<Record<string, number>>;
}

/** What the page keeps pending while idle. */
export type IdleCounts = Omit<ProbeReading, "renders">;

/** What one screen cost: each step in order, and the idle reading. */
export interface ScreenCounts {
  readonly steps: ReadonlyArray<readonly [string, StepCounts]>;
  readonly idle: IdleCounts;
}

/** One screen's measurement: what the page should show once open, its row component, and its steps. */
interface ScreenPlan {
  readonly drawn: string;
  readonly rowComponent: string;
  readonly measureSteps: (driver: StepDriver) => Promise<void>;
}

/** The page under test and the step measure, as a screen's steps use them. */
interface StepDriver {
  readonly page: Page;
  /**
   * Runs `act`, waits until `settled` is true in the page and the page is
   * quiet, and records the step as `name`. Fails with `name` in the message
   * when the page does not settle in time.
   */
  readonly measure: (name: string, act: () => Promise<void>, settled: string) => Promise<void>;
}

/** Reads the counts page's object in the page. */
const PAGE = "window.perfCounts";

/**
 * Calls `read` with the counts page's object in `page` and returns what it
 * returns. `read` is sent to the page as its source, so it may use nothing
 * but its argument.
 */
const callPage = <T>(page: Page, read: (perf: PerfCountsPage) => T): Promise<T> =>
  page.evaluate<T>(`(${read.toString()})(${PAGE})`);

/** Waits for two frames in `page`, so what a step changed has been styled, laid out and painted. */
const waitTwoFrames = (page: Page): Promise<void> =>
  page.evaluate<void>(
    "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))",
  );

/** An expression that is true while the page is quiet: no read or write runs, and nothing moves. */
const QUIET = `${PAGE}.isIdle() && ${PAGE}.isStill()`;

/**
 * Waits until `settled` is true in `page` and the page is quiet: no read or
 * write runs, nothing moves (see `isStill`), and two frames later that still
 * holds with no new request. Fails after `STEP_TIMEOUT_MS`, naming `name`.
 */
async function waitForSettled(page: Page, settled: string, name: string): Promise<void> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  for (;;) {
    try {
      await page.waitForFunction(`(${settled}) && ${QUIET}`, undefined, {
        timeout: Math.max(1, deadline - Date.now()),
      });
    } catch (error) {
      throw new Error(`The step "${name}" did not settle: ${settled} never held.`, {
        cause: error,
      });
    }
    const before = await callPage(page, (perf) => perf.listRequests().length);
    await waitTwoFrames(page);
    const after = await page.evaluate<number | false>(`${QUIET} && ${PAGE}.listRequests().length`);
    if (after === before) return;
    if (Date.now() > deadline) throw new Error(`The step "${name}" kept sending requests.`);
  }
}

/** One event of a Chromium trace, as far as the check reads it. */
interface TraceEvent {
  readonly name: string;
  readonly args?: { readonly elementCount?: unknown };
}

/** Starts a trace of the style recalculations in the page `cdp` is attached to. */
async function startStyleTrace(cdp: CDPSession): Promise<() => Promise<number>> {
  const events: TraceEvent[] = [];
  const collect = (data: { value: ReadonlyArray<object> }) => {
    events.push(...(data.value as TraceEvent[]));
  };
  cdp.on("Tracing.dataCollected", collect);
  await cdp.send("Tracing.start", {
    traceConfig: { includedCategories: ["devtools.timeline"] },
    transferMode: "ReportEvents",
  });
  // Ends the trace and returns the elements restyled, summed over every recalculation.
  return async () => {
    const complete = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
    await cdp.send("Tracing.end");
    await complete;
    cdp.off("Tracing.dataCollected", collect);
    let restyled = 0;
    for (const event of events) {
      if (event.name !== "UpdateLayoutTree") continue;
      const count = event.args?.elementCount;
      // A Chromium that stops reporting the count must fail the check, not read as no restyle.
      if (typeof count !== "number") {
        throw new Error(
          `A style recalculation in the trace has no element count: ${JSON.stringify(event)}. ` +
            "Chromium's trace format changed; update startStyleTrace in scripts/perf-counts-screens.ts.",
        );
      }
      restyled += count;
    }
    return restyled;
  };
}

/** An expression for the Inbox row at the 1-based `position` in the list, or null. */
const inboxRowAt = (position: number): string =>
  `document.querySelector('.ib-rows > .ib-row[aria-posinset="${String(position)}"]')`;

/** An expression for the position of the Inbox's current row, or 0 when none is mounted. */
const INBOX_CURRENT = `Number(document.querySelector(".ib-rows > .ib-row.is-current")?.getAttribute("aria-posinset") ?? 0)`;

/** An expression for the title the Inbox's pane shows, or null. */
const INBOX_PANE_TITLE = `(document.querySelector('[aria-label="The open thing"] .open-card-title')?.textContent ?? null)`;

/** An expression that is true while a row with the External Ref `ref` is mounted in the Inbox's list. */
const isInboxRowMounted = (ref: string): string =>
  `[...document.querySelectorAll(".ib-rows > .ib-row")].some((row) => row.dataset.ref === ${JSON.stringify(ref)})`;

const INBOX: ScreenPlan = {
  drawn: `${inboxRowAt(1)} !== null && ${PAGE}.isLive()`,
  rowComponent: "InboxRow",
  measureSteps: async ({ page, measure }) => {
    const title = await page.evaluate<string>(
      `${inboxRowAt(4)}.querySelector(".ib-row-title").textContent`,
    );
    await measure(
      "open a card",
      () => page.click('.ib-rows > .ib-row[aria-posinset="4"]'),
      `${INBOX_PANE_TITLE} === ${JSON.stringify(title)}`,
    );
    await measure(
      "click the first row",
      () => page.click('.ib-rows > .ib-row[aria-posinset="1"]'),
      `${INBOX_CURRENT} === 1`,
    );
    await measure(
      `J x${String(INBOX_WALK)}`,
      async () => {
        for (let position = 2; position <= INBOX_WALK + 1; position += 1) {
          await page.keyboard.press("j");
          await page.waitForFunction(`${INBOX_CURRENT} === ${String(position)}`);
          await waitTwoFrames(page);
        }
      },
      `${INBOX_CURRENT} === ${String(INBOX_WALK + 1)}`,
    );
    const ref = await page.evaluate<string>(
      `document.querySelector(".ib-rows > .ib-row.is-current").dataset.ref`,
    );
    await measure(
      "E dismisses the current thing",
      () => page.keyboard.press("e"),
      `!(${isInboxRowMounted(ref)})`,
    );
    await measure("Cmd+Z undoes it", () => page.keyboard.press("Meta+z"), isInboxRowMounted(ref));
    const readsBefore = await callPage(page, (perf) => perf.listRequests().length);
    await measure(
      "a push about a thing the list holds",
      () => callPage(page, (perf) => perf.push("externalEntity", [])),
      `${PAGE}.listRequests().length > ${String(readsBefore)}`,
    );
    await measure(
      "a push with a new arrival",
      () =>
        callPage(page, (perf) => {
          perf.changeWorld("arrive");
          perf.push("externalEntity", []);
        }),
      `document.querySelector(".ib-newbar-count") !== null`,
    );
    await measure(
      "Show the arrival",
      () => page.click(".ib-newbar-count"),
      `document.querySelector(".ib-newbar-count") === null && ${inboxRowAt(1)}.querySelector(".ib-row-title").textContent.startsWith("Review request 301:")`,
    );
  },
};

/** An expression for the card that has the keyboard focus on Work, or null. */
const WORK_FOCUSED = `document.activeElement?.closest(".desk-card") ?? null`;

const WORK: ScreenPlan = {
  drawn: `document.querySelector(".desk-card") !== null && ${PAGE}.isLive()`,
  rowComponent: "WorkCardView",
  measureSteps: async ({ page, measure }) => {
    await measure(
      "focus the first card",
      async () => {
        await page.focus(".board-scroll");
        await page.keyboard.press("ArrowDown");
      },
      `${WORK_FOCUSED} !== null`,
    );
    await measure(
      `J x${String(WORK_WALK)}`,
      async () => {
        for (let step = 0; step < WORK_WALK; step += 1) {
          const before = await page.evaluate<string>(`${WORK_FOCUSED}.textContent`);
          await page.keyboard.press("j");
          await page.waitForFunction(`${WORK_FOCUSED}?.textContent !== ${JSON.stringify(before)}`);
          await waitTwoFrames(page);
        }
      },
      `${WORK_FOCUSED} !== null`,
    );
    await measure(
      "Shift+Right moves the card a stage",
      () => page.keyboard.press("Shift+ArrowRight"),
      `document.body.textContent.includes("Moved \\"")`,
    );
    await measure(
      "a push renames a card",
      () =>
        callPage(page, (perf) => {
          perf.changeWorld("rename");
          perf.push("task", []);
        }),
      `document.body.textContent.includes(", renamed")`,
    );
  },
};

/** The screens the check measures, by the name the page takes in `?screen=`. */
const SCREENS = { inbox: INBOX, work: WORK } as const;

/**
 * Checks that every counter saw the screen open: it sent requests, React
 * rendered components and among them the screen's row component, and
 * Chromium restyled elements. A later step may count zero, but the open never
 * does. Fails naming the counter otherwise, so a renamed row component, a lost
 * React hook or a changed trace cannot pass the check by counting nothing.
 */
function checkCounters(screen: string, plan: ScreenPlan, counts: StepCounts): void {
  const broken = [
    counts.requests === 0 ? "no request was counted" : "",
    counts.renders === 0 ? "no React render was counted, so the probe's hook is not called" : "",
    counts.rowRenders === 0
      ? `no render of ${plan.rowComponent} was counted; if the row component was renamed, update rowComponent in scripts/perf-counts-screens.ts`
      : "",
    counts.restyled === 0 ? "no restyled element was counted in the trace" : "",
  ].filter((problem) => problem !== "");
  if (broken.length > 0) {
    throw new Error(`The counts check cannot count ${screen} as it opens: ${broken.join("; ")}.`);
  }
}

/**
 * Opens `screen` on the counts page at `pageUrl` in `page`, measures the open
 * and every step, and returns the counts. Fails when a step does not settle
 * or the app sends a request the fake controller does not answer.
 */
async function measureScreen(
  page: Page,
  pageUrl: string,
  screen: keyof typeof SCREENS,
): Promise<ScreenCounts> {
  const plan = SCREENS[screen];
  const cdp = await page.context().newCDPSession(page);
  const steps: Array<readonly [string, StepCounts]> = [];
  const measure = async (name: string, act: () => Promise<void>, settled: string) => {
    const requestsBefore =
      name === "open" ? 0 : await callPage(page, (perf) => perf.listRequests().length);
    if (name !== "open") await callPage(page, (perf) => perf.readProbe());
    const endTrace = await startStyleTrace(cdp);
    await act();
    await waitForSettled(page, settled, name);
    const restyled = await endTrace();
    const [requestList, probe, elements, unknown] = await Promise.all([
      callPage(page, (perf) => perf.listRequests()),
      callPage(page, (perf) => perf.readProbe()),
      page.evaluate<number>(`document.getElementsByTagName("*").length`),
      callPage(page, (perf) => perf.listUnknownRequests()),
    ]);
    if (unknown.length > 0) {
      throw new Error(
        `The app sent requests the counts page's fake controller does not answer: ${unknown.join(", ")}. ` +
          "Add a handler for each to src/renderer/specimens/perf-counts.tsx.",
      );
    }
    const stepRequests = requestList.slice(requestsBefore);
    const counts: StepCounts = {
      requests: stepRequests.length,
      restyled,
      renders: Object.values(probe.renders).reduce((total, count) => total + count, 0),
      rowRenders: probe.renders[plan.rowComponent] ?? 0,
      elements,
      requestList: stepRequests,
      renderList: probe.renders,
    };
    if (name === "open") checkCounters(screen, plan, counts);
    steps.push([name, counts]);
  };
  await measure(
    "open",
    async () => {
      await page.goto(`${pageUrl}?screen=${screen}`, { timeout: 180_000 });
    },
    plan.drawn,
  );
  // The idle reading: what stays pending once the screen has been quiet for a second.
  await sleep(1_000);
  const reading = await callPage(page, (perf) => perf.readProbe());
  const idle: IdleCounts = {
    intervals: reading.intervals,
    shortTimeouts: reading.shortTimeouts,
    longTimeouts: reading.longTimeouts,
    frames: reading.frames,
  };
  await plan.measureSteps({ page, measure });
  await cdp.detach();
  return { steps, idle };
}

/**
 * Measures every screen in one Chromium, each in a fresh browser context, on
 * the counts page served at `specimensUrl`. Returns the counts by screen.
 */
export async function measureScreens(specimensUrl: string): Promise<Record<string, ScreenCounts>> {
  const browser = await launchCaptureBrowser();
  try {
    const result: Record<string, ScreenCounts> = {};
    for (const screen of Object.keys(SCREENS) as Array<keyof typeof SCREENS>) {
      const context = await browser.newContext({
        viewport: WINDOW,
        timezoneId: "UTC",
        locale: "en-US",
      });
      try {
        result[screen] = await measureScreen(
          await context.newPage(),
          `${specimensUrl}perf-counts.html`,
          screen,
        );
      } finally {
        await context.close();
      }
    }
    return result;
  } finally {
    await browser.close();
  }
}
