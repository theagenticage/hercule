import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CALL_STACK_TIMEOUT_MS, logPageHangs, type WatchedPage } from "./page-hang-log";

const STACK =
  "\n    at spin (app://hercule/assets/index-a1b2.js:1:4821)\n    at onClick (app://hercule/assets/index-a1b2.js:1:9120)";

/**
 * A stand-in for the page on `/inbox?list=waits`. `answerStack` settles the
 * call stack Chromium is asked for; until then the request is pending, as it
 * is while no JavaScript runs.
 */
const makePage = () => {
  const listeners = new Map<string, (...args: Array<never>) => void>();
  let answerStack: (stack: string | undefined) => void = () => {};
  let stackRequests = 0;
  const page: WatchedPage = {
    on: (event: string, listener: (...args: Array<never>) => void) =>
      listeners.set(event, listener),
    getURL: () => "app://hercule/inbox?list=waits",
    mainFrame: {
      collectJavaScriptCallStack: () => {
        stackRequests += 1;
        return new Promise((resolve) => {
          answerStack = resolve;
        });
      },
    },
  };
  const emit = (event: string, ...args: ReadonlyArray<unknown>) =>
    listeners.get(event)?.(...(args as Array<never>));
  return {
    page,
    emit,
    answerStack: (stack: string | undefined) => answerStack(stack),
    countStackRequests: () => stackRequests,
  };
};

/** Watches a stand-in page and returns it with every line logged, each prefixed with its level. */
const watchPage = () => {
  const lines: Array<string> = [];
  let clock = 1_000_000;
  const stand = makePage();
  logPageHangs(
    stand.page,
    {
      logWarning: (message) => lines.push(`warn: ${message}`),
      logError: (message) => lines.push(`error: ${message}`),
      logInfo: (message) => lines.push(`info: ${message}`),
    },
    () => clock,
  );
  return {
    ...stand,
    lines,
    advanceClock: (ms: number) => {
      clock += ms;
    },
  };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const STOPPED =
  "warn: The window's page stopped responding on /inbox?list=waits. Reading the JavaScript it is running.";

describe("logPageHangs", () => {
  it("logs the screen at once, then the JavaScript call stack the page is running", async () => {
    const { emit, answerStack, lines } = watchPage();
    emit("unresponsive");
    expect(lines).toEqual([STOPPED]);
    answerStack(STACK);
    await vi.runAllTimersAsync();
    expect(lines).toEqual([
      STOPPED,
      "warn: The window's page was running this JavaScript when it stopped responding:\n" +
        "at spin (app://hercule/assets/index-a1b2.js:1:4821)\n" +
        "    at onClick (app://hercule/assets/index-a1b2.js:1:9120)",
    ]);
  });

  it("says that no JavaScript held the page when no stack comes in time", async () => {
    const { emit, lines } = watchPage();
    emit("unresponsive");
    await vi.advanceTimersByTimeAsync(CALL_STACK_TIMEOUT_MS);
    expect(lines).toEqual([
      STOPPED,
      "warn: No JavaScript ran in the window's page in the 5 seconds after it stopped responding, so something else held it, such as layout.",
    ]);
  });

  it("logs Chromium's answer when it gives no stack", async () => {
    const { emit, answerStack, lines } = watchPage();
    emit("unresponsive");
    answerStack(undefined);
    await vi.runAllTimersAsync();
    expect(lines.at(-1)).toBe(
      "warn: Chromium gave no JavaScript call stack for the window's page.",
    );
  });

  it("logs how long the page was stuck once it responds again", async () => {
    const { emit, answerStack, advanceClock, lines } = watchPage();
    emit("unresponsive");
    answerStack(STACK);
    await vi.runAllTimersAsync();
    advanceClock(42_500);
    emit("responsive");
    expect(lines.at(-1)).toBe(
      "info: The window's page responds again, 42.5 seconds after it stopped.",
    );
  });

  it("drops a stack that comes after the page responded again", async () => {
    const { emit, answerStack, advanceClock, lines } = watchPage();
    emit("unresponsive");
    advanceClock(1000);
    emit("responsive");
    answerStack(STACK);
    await vi.runAllTimersAsync();
    expect(lines).toEqual([
      STOPPED,
      "info: The window's page responds again, 1.0 seconds after it stopped.",
    ]);
  });

  it("reads the stack once per hang", async () => {
    const { emit, answerStack, countStackRequests } = watchPage();
    emit("unresponsive");
    emit("unresponsive");
    answerStack(STACK);
    await vi.runAllTimersAsync();
    expect(countStackRequests()).toBe(1);
    emit("responsive");
    emit("unresponsive");
    expect(countStackRequests()).toBe(2);
  });

  it("logs nothing when the page responds without having stopped", () => {
    const { emit, lines } = watchPage();
    emit("responsive");
    expect(lines).toEqual([]);
  });

  it("logs the reason and the exit code when the renderer process ends", () => {
    const { emit, lines } = watchPage();
    emit("render-process-gone", {}, { reason: "oom", exitCode: 9 });
    expect(lines).toEqual(["error: The window's renderer process ended: oom, exit code 9."]);
  });

  it("watches the reloaded page for hangs after the renderer process ended during one", async () => {
    const { emit, answerStack, countStackRequests, lines } = watchPage();
    emit("unresponsive");
    emit("render-process-gone", {}, { reason: "killed", exitCode: 9 });
    answerStack(STACK);
    await vi.runAllTimersAsync();
    emit("unresponsive");
    expect(countStackRequests()).toBe(2);
    expect(lines).toEqual([
      STOPPED,
      "error: The window's renderer process ended: killed, exit code 9.",
      STOPPED,
    ]);
  });
});
