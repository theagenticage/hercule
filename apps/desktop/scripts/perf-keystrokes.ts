/**
 * Measures the desktop perf script's keystroke scenario: how much work the
 * renderer's main thread does for each key typed into the composer's message
 * field. It runs one plain launch that reopens a thread with a long
 * transcript, so nothing is attached to the app while any other measurement
 * reads memory, CPU or wakeups. In that launch it:
 *
 * - finds the message field by its `role` and `aria-label` attributes, so the
 *   same code measures a `<textarea>` and a contenteditable editor, and
 *   focuses it;
 * - types `TYPED_SENTENCE` one key at a time with `Input.dispatchKeyEvent`,
 *   `KEY_INTERVAL_MS` apart, so each key lands in frames of its own;
 * - records a Chromium trace over the typing and, for each key, adds up the
 *   tasks the renderer's main thread ran from that key's `keydown` until the
 *   next key's (for the last key, until one key interval later);
 * - clears the field again, so later steps and later launches start empty.
 *
 * It runs on plain Node, like the perf script, so its imports name the `.ts`
 * file.
 */
import { loadavg } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import {
  assertExitedCleanly,
  connectInspector,
  formatTable,
  launchPlainApp,
  stopPlainApp,
  type Inspector,
} from "./packaged-app.ts";
import {
  findRendererMainTasks,
  readTrace,
  TIMELINE_CATEGORY,
  waitForPageSocketUrl,
} from "./perf-measures.ts";
import { pollUntil } from "./poll.ts";

/**
 * The text typed into the field: about 200 characters, with lowercase letters,
 * spaces, commas and periods only, so that every key has a simple key code
 * and the text holds no key that sends the message.
 */
export const TYPED_SENTENCE =
  "the quick brown fox jumps over the lazy dog, and then it runs back across the field to find the other foxes. " +
  "they all gather by the river, where the water is cold and clear, and they talk until dark.";

/**
 * How long the script waits after each key, in milliseconds: several frames
 * at 60 Hz, so the work of one key is over before the next key starts.
 */
const KEY_INTERVAL_MS = 50;

/** How long the launch settles before the typing starts, in milliseconds. */
const LAUNCH_SETTLE_MS = 5_000;

/** The name the page gives each `keydown` in the trace, with `console.timeStamp`. */
const KEYDOWN_MARK = "keystroke";

/** The trace categories of the typing: the tasks, and the page's `console.timeStamp` marks. */
const TRACE_CATEGORIES = [TIMELINE_CATEGORY, "devtools.timeline"];

/** The keys `TYPED_SENTENCE` uses, with the `code` and the key code the DevTools protocol needs for each. */
const PUNCTUATION_KEYS: Readonly<Record<string, { code: string; keyCode: number }>> = {
  " ": { code: "Space", keyCode: 32 },
  ",": { code: "Comma", keyCode: 188 },
  ".": { code: "Period", keyCode: 190 },
};

/** What typing `TYPED_SENTENCE` cost the renderer's main thread. */
export interface KeystrokeWork {
  /** The machine's load average over the minute before the app was spawned. */
  readonly loadAtSpawn: number;
  /** How many keys were typed. */
  readonly keyCount: number;
  /** The time between two keys, in milliseconds. */
  readonly keyIntervalMs: number;
  /** The time the main thread was busy per key, the mean over all keys, in milliseconds. */
  readonly meanBusyMs: number;
  /** The time the main thread was busy per key, the 95th percentile, in milliseconds. */
  readonly p95BusyMs: number;
  /** The longest task the main thread ran from the first key to the last key's interval, in milliseconds. */
  readonly longestTaskMs: number;
}

/**
 * Types `TYPED_SENTENCE` into the message field of the thread that the
 * signed-in app on `userDataDir` reopens, and returns what the typing cost.
 * Fails when the transcript does not show within 15 s, when the page does
 * not have exactly one text box named "Message", when the field does not
 * hold the sentence after the typing or is not empty after the clearing,
 * when the trace lost events or holds a different number of marks than keys,
 * or when the app does not quit cleanly afterwards.
 */
export async function measureKeystrokeWork(userDataDir: string): Promise<KeystrokeWork> {
  const loadAtSpawn = loadavg()[0]!;
  const app = await launchPlainApp(userDataDir);
  let measured: KeystrokeWork;
  try {
    const page = await connectInspector(await waitForPageSocketUrl(app.endpoint));
    try {
      const evaluate = (expression: string) =>
        page.evaluate("Runtime.evaluate", { expression, returnByValue: true });
      await pollUntil(
        async () =>
          (await evaluate(`document.querySelector('section[aria-label="Transcript"]') !== null`))
            ? true
            : undefined,
        { timeoutMs: 15_000, intervalMs: 50, timeoutMessage: "the app did not reopen the thread" },
      );
      await sleep(LAUNCH_SETTLE_MS);
      const readField = await focusMessageField(page);
      await evaluate(
        `document.addEventListener("keydown", () => console.timeStamp(${JSON.stringify(KEYDOWN_MARK)}), true)`,
      );

      await page.send("Tracing.start", {
        transferMode: "ReturnAsStream",
        traceConfig: { includedCategories: TRACE_CATEGORIES },
      });
      for (const character of TYPED_SENTENCE) {
        await typeCharacter(page, character);
        await sleep(KEY_INTERVAL_MS);
      }
      await page.send("Tracing.end");
      const events = await readTrace(page);

      if ((await readField()) !== TYPED_SENTENCE) {
        throw new Error(
          "the message field does not hold the typed sentence, so the keys did not land",
        );
      }
      await clearMessageField(page);
      if ((await readField()) !== "")
        throw new Error("the message field is not empty after clearing");

      const marks = events
        .filter((event) => event.name === "TimeStamp" && event.args?.data?.message === KEYDOWN_MARK)
        .map((event) => event.ts)
        .toSorted((a, b) => a - b);
      if (marks.length !== TYPED_SENTENCE.length) {
        throw new Error(
          `the trace holds ${String(marks.length)} keydown marks for ${String(TYPED_SENTENCE.length)} keys`,
        );
      }
      measured = {
        loadAtSpawn,
        keyCount: marks.length,
        keyIntervalMs: KEY_INTERVAL_MS,
        ...summarizeKeystrokeTasks(findRendererMainTasks(events), marks, KEY_INTERVAL_MS),
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
 * Adds up, for each key, the renderer main thread's tasks that belong to it,
 * and returns the mean and the 95th percentile of those sums, and the longest
 * task, all in milliseconds. `markTimes` holds the time of each key's
 * `keydown`, sorted, in the trace's microseconds. `keyIntervalMs` is the time
 * between two keys.
 *
 * A task belongs to the last key whose `keydown` came before the task ended.
 * The task that runs the `keydown` handler starts before the mark the handler
 * writes, so it must belong to that key, not to the one before. A key's window
 * ends at the next key's mark; the last key's ends one key interval after its
 * mark. A task that ended before the first key, or after the last key's
 * window (such as the work of stopping the trace), belongs to no key.
 */
export function summarizeKeystrokeTasks(
  tasks: ReadonlyArray<{ readonly ts: number; readonly dur?: number }>,
  markTimes: ReadonlyArray<number>,
  keyIntervalMs: number,
): Pick<KeystrokeWork, "meanBusyMs" | "p95BusyMs" | "longestTaskMs"> {
  const busyMs = markTimes.map(() => 0);
  const windowEnd = markTimes.at(-1)! + keyIntervalMs * 1_000;
  let longestTaskMs = 0;
  for (const task of tasks) {
    const durationMs = (task.dur ?? 0) / 1_000;
    const endsAt = task.ts + (task.dur ?? 0);
    const keyIndex = markTimes.findLastIndex((markTime) => markTime <= endsAt);
    if (keyIndex === -1 || endsAt > windowEnd) continue;
    busyMs[keyIndex] = busyMs[keyIndex]! + durationMs;
    longestTaskMs = Math.max(longestTaskMs, durationMs);
  }
  const sorted = busyMs.toSorted((a, b) => a - b);
  return {
    meanBusyMs: busyMs.reduce((sum, ms) => sum + ms, 0) / busyMs.length,
    p95BusyMs: sorted[Math.ceil(0.95 * sorted.length) - 1]!,
    longestTaskMs,
  };
}

/** Matches the composer's message field, a `<textarea>` or a contenteditable element alike. */
const MESSAGE_FIELD_SELECTOR = '[role="textbox"][aria-label="Message"]';

/**
 * Finds the page's message field by its role and accessible name, "Message",
 * focuses it, and returns a function that reads the text it holds. It reads
 * the DOM attributes with `Runtime.evaluate` rather than querying the
 * accessibility tree, because that query can switch Chromium's accessibility
 * mode on, which would add work to every key measured. Fails when the page has
 * no such field or more than one.
 */
async function focusMessageField(page: Inspector): Promise<() => Promise<string>> {
  const evaluate = (expression: string) =>
    page.evaluate("Runtime.evaluate", { expression, returnByValue: true });
  const fieldCount = await evaluate(
    `(() => {
      const fields = document.querySelectorAll(${JSON.stringify(MESSAGE_FIELD_SELECTOR)});
      if (fields.length === 1) fields[0].focus();
      return fields.length;
    })()`,
  );
  if (fieldCount !== 1) {
    throw new Error(
      `the page has ${String(fieldCount)} text boxes named "Message", and the keystroke scenario needs exactly one`,
    );
  }
  // A textarea holds its text in `value`; a contenteditable element holds it as children.
  return async () =>
    (await evaluate(
      `(() => {
        const field = document.querySelector(${JSON.stringify(MESSAGE_FIELD_SELECTOR)});
        return "value" in field ? field.value : field.textContent;
      })()`,
    )) as string;
}

/** Presses and releases the key that types `character`, one of those in `TYPED_SENTENCE`. */
async function typeCharacter(page: Inspector, character: string): Promise<void> {
  const punctuation = PUNCTUATION_KEYS[character];
  const key = {
    key: character,
    code: punctuation?.code ?? `Key${character.toUpperCase()}`,
    windowsVirtualKeyCode: punctuation?.keyCode ?? character.toUpperCase().charCodeAt(0),
  };
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    ...key,
    text: character,
    unmodifiedText: character,
  });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
}

/**
 * Empties the focused message field with ⌘A and Backspace, so the draft the
 * app saved while the sentence was typed is empty again. Chromium on macOS
 * runs an editing shortcut sent over the DevTools protocol only when the
 * event names the editing command.
 */
async function clearMessageField(page: Inspector): Promise<void> {
  const META_KEY = 4;
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    modifiers: META_KEY,
    commands: ["selectAll"],
  });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    modifiers: META_KEY,
  });
  for (const type of ["rawKeyDown", "keyUp"]) {
    await page.send("Input.dispatchKeyEvent", {
      type,
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
    });
  }
  await sleep(200);
}

/** Prints what typing into the composer cost, as a table. The spec has no budget for it, so none is checked. */
export function reportKeystrokeWork(measured: KeystrokeWork): void {
  console.log(
    `\n### Typing into the composer, a thread of 500 transcript rows open (load ${measured.loadAtSpawn.toFixed(1)})\n`,
  );
  console.log(
    `${String(measured.keyCount)} keys, one every ${String(measured.keyIntervalMs)} ms, typed with Input.dispatchKeyEvent.\n`,
  );
  console.log(
    formatTable(
      ["Measure", "Limit", "Measured"],
      [
        [
          "Renderer main thread busy per key, mean",
          "recorded; not budgeted",
          `${measured.meanBusyMs.toFixed(2)} ms`,
        ],
        [
          "Renderer main thread busy per key, 95th percentile",
          "recorded; not budgeted",
          `${measured.p95BusyMs.toFixed(2)} ms`,
        ],
        [
          "Renderer main thread, longest task",
          "recorded; not budgeted",
          `${measured.longestTaskMs.toFixed(2)} ms`,
        ],
      ],
    ),
  );
}
