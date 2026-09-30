import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge } from "../../ipc/bridge";
import { reportFirstScreen, waitForPresentedFrame } from "./presented-frame";

/**
 * A stand-in for Chromium's `PerformanceObserver`, which jsdom lacks. Each
 * observer it creates is kept in `observers`, and a test delivers Element
 * Timing entries to it with `deliver`.
 */
class FakePerformanceObserver {
  static observers: Array<FakePerformanceObserver> = [];
  readonly callback: PerformanceObserverCallback;
  observed: PerformanceObserverInit | undefined;
  disconnected = false;

  constructor(callback: PerformanceObserverCallback) {
    this.callback = callback;
    FakePerformanceObserver.observers.push(this);
  }

  observe(options: PerformanceObserverInit): void {
    this.observed = options;
  }

  disconnect(): void {
    this.disconnected = true;
  }

  /** Calls the observer's callback with an Element Timing entry for `element`. */
  deliver(element: Element, renderTime: number): void {
    const entry = { entryType: "element", element, renderTime };
    this.callback(
      { getEntries: () => [entry] } as unknown as PerformanceObserverEntryList,
      this as unknown as PerformanceObserver,
    );
  }
}

/** Returns the sentinel the wait has added to the page, or null when there is none. */
const findSentinel = (): Element | null => document.querySelector("[elementtiming]");

/** Returns the one observer the wait has created. */
const readObserver = (): FakePerformanceObserver => {
  expect(FakePerformanceObserver.observers).toHaveLength(1);
  return FakePerformanceObserver.observers[0]!;
};

/**
 * Holds `document.fonts.ready` pending, as it is while a font loads, and
 * returns the function that resolves it.
 */
const holdFontsLoading = (): (() => void) => {
  let finishLoading = () => {};
  const ready = new Promise<void>((resolve) => (finishLoading = resolve));
  vi.spyOn(document, "fonts", "get").mockReturnValue({ ready } as unknown as FontFaceSet);
  return finishLoading;
};

/** Lets every promise callback that is ready to run, run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  FakePerformanceObserver.observers = [];
  vi.stubGlobal("PerformanceObserver", FakePerformanceObserver);
});

afterEach(() => {
  // A test that ends before its wait does leaves the sentinel behind, and the
  // next test would find it instead of its own.
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("waitForPresentedFrame", () => {
  it("adds its sentinel only once the fonts have loaded", async () => {
    const finishLoading = holdFontsLoading();
    let presentedAt: number | undefined;
    void waitForPresentedFrame().then((time) => (presentedAt = time));

    await settle();
    expect(findSentinel()).toBeNull();
    expect(FakePerformanceObserver.observers).toEqual([]);

    finishLoading();
    await settle();
    expect(findSentinel()).not.toBeNull();
    expect(readObserver().observed).toEqual({ type: "element" });
    expect(presentedAt).toBeUndefined();
  });

  it("returns when the frame that painted its sentinel was presented, and removes the sentinel", async () => {
    let presentedAt: number | undefined;
    void waitForPresentedFrame().then((time) => (presentedAt = time));
    await settle();
    const sentinel = findSentinel()!;

    readObserver().deliver(sentinel, 123.4);
    await settle();
    expect(presentedAt).toBe(123.4);
    expect(readObserver().disconnected).toBe(true);
    expect(findSentinel()).toBeNull();
  });

  it("ignores the entry of another element", async () => {
    let presentedAt: number | undefined;
    void waitForPresentedFrame().then((time) => (presentedAt = time));
    await settle();

    readObserver().deliver(document.createElement("span"), 50);
    await settle();
    expect(presentedAt).toBeUndefined();
    expect(findSentinel()).not.toBeNull();
  });
});

describe("reportFirstScreen", () => {
  /** Returns a bridge whose `firstScreen.report` runs `report`. */
  const makeBridge = (report: () => Promise<undefined>) =>
    ({ firstScreen: { report } }) as unknown as Bridge;

  it("reports the first screen once its frame was presented, and returns when", async () => {
    const report = vi.fn(() => Promise.resolve(undefined));
    let presentedAt: number | null | undefined;
    void reportFirstScreen(makeBridge(report)).then((time) => (presentedAt = time));
    await settle();
    expect(report).not.toHaveBeenCalled();

    readObserver().deliver(findSentinel()!, 80);
    await settle();
    expect(report).toHaveBeenCalledOnce();
    expect(presentedAt).toBe(80);
  });

  it("logs a failed report and returns null", async () => {
    const error = new Error("main refused the message");
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    let presentedAt: number | null | undefined;
    void reportFirstScreen(makeBridge(() => Promise.reject(error))).then(
      (time) => (presentedAt = time),
    );
    await settle();

    readObserver().deliver(findSentinel()!, 80);
    await settle();
    expect(presentedAt).toBeNull();
    expect(logError).toHaveBeenCalledWith(
      "Could not report the first screen to main, so main's time limit will show the window instead:",
      error,
    );
  });
});
