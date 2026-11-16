/**
 * Logs when the window's page stops responding, what its JavaScript was doing
 * then, when it responds again, and when its renderer process ends. A frozen
 * page otherwise leaves no trace: the user quits the app, and nothing says
 * which code held the page.
 *
 * This module imports only types, so unit tests can drive it with a stand-in
 * for the page, without Electron.
 */

/**
 * How long main waits for the page's call stack, in milliseconds. Chromium
 * answers only while JavaScript runs in the page, so a page that is held by
 * something else, such as layout, never answers.
 */
export const CALL_STACK_TIMEOUT_MS = 5000;

/** The parts of Electron's `WebContents` that the hang log uses. */
export interface WatchedPage {
  on(event: "unresponsive" | "responsive", listener: () => void): unknown;
  on(
    event: "render-process-gone",
    listener: (
      event: unknown,
      details: { readonly reason: string; readonly exitCode: number },
    ) => void,
  ): unknown;
  /** Returns the page's address. */
  getURL(): string;
  readonly mainFrame: {
    /**
     * Resolves with the JavaScript call stack running in the frame, or with
     * Chromium's reason when it cannot give one. Never resolves while no
     * JavaScript runs.
     */
    collectJavaScriptCallStack(): Promise<string | void>;
  };
}

/** Where the hang log writes. Each function writes one log line. */
export interface HangLogLines {
  readonly logWarning: (message: string) => void;
  readonly logError: (message: string) => void;
  readonly logInfo: (message: string) => void;
}

/**
 * Returns the part of `url` after its origin, such as `/inbox?list=waits`, to
 * name the screen the page was on. Returns `url` itself when it does not
 * parse.
 */
const describeScreen = (url: string): string => {
  try {
    const { pathname, search, hash } = new URL(url);
    return `${pathname}${search}${hash}`;
  } catch {
    return url;
  }
};

/** The hang under way: when it started. One object per hang, so a stack read for an earlier hang can tell it is late. */
interface Hang {
  readonly startedAt: number;
}

/**
 * Logs the hangs of `page` to `lines` for as long as the page lives:
 *
 * - When Chromium reports the page unresponsive, a warning names the screen at
 *   once, so a user who quits the frozen app still leaves it in the log.
 *   Chromium reports it only after an input event, such as a click, has gone
 *   unanswered for some seconds.
 * - A second warning follows with the JavaScript call stack the page is
 *   running. When no stack comes within `CALL_STACK_TIMEOUT_MS`, it says that
 *   no JavaScript held the page, and something else did, such as layout.
 * - When the page responds again, a line says after how long. A stack that
 *   comes after that is dropped: it shows whatever the page ran after it
 *   recovered, not what held it.
 * - When the page's renderer process ends, an error gives Chromium's reason
 *   and the exit code, and the hang under way, if any, is over: a reloaded
 *   page starts with no hang.
 *
 * The stack holds the renderer bundle's minified names and positions. A build
 * of the same commit with source maps turns them back into source lines.
 *
 * `now` returns the time in milliseconds. It adds no timer and does no work
 * until Chromium reports a hang.
 */
export const logPageHangs = (
  page: WatchedPage,
  lines: HangLogLines,
  now: () => number = Date.now,
): void => {
  let hang: Hang | null = null;

  page.on("unresponsive", () => {
    if (hang !== null) return;
    const thisHang: Hang = { startedAt: now() };
    hang = thisHang;
    lines.logWarning(
      `The window's page stopped responding on ${describeScreen(page.getURL())}. Reading the JavaScript it is running.`,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), CALL_STACK_TIMEOUT_MS);
    });
    void Promise.race([page.mainFrame.collectJavaScriptCallStack(), timeout])
      .catch((error: unknown) => `the stack could not be read: ${String(error)}`)
      .then((stack) => {
        clearTimeout(timer);
        // The page recovered, or its renderer ended, before the stack came.
        if (hang !== thisHang) return;
        lines.logWarning(
          stack === null
            ? `No JavaScript ran in the window's page in the ${String(CALL_STACK_TIMEOUT_MS / 1000)} seconds after it stopped responding, so something else held it, such as layout.`
            : typeof stack === "string" && stack.trim() !== ""
              ? `The window's page was running this JavaScript when it stopped responding:\n${stack.trim()}`
              : "Chromium gave no JavaScript call stack for the window's page.",
        );
      });
  });

  page.on("responsive", () => {
    if (hang === null) return;
    const seconds = ((now() - hang.startedAt) / 1000).toFixed(1);
    hang = null;
    lines.logInfo(`The window's page responds again, ${seconds} seconds after it stopped.`);
  });

  page.on("render-process-gone", (_event, { reason, exitCode }) => {
    hang = null;
    lines.logError(
      `The window's renderer process ended: ${reason}, exit code ${String(exitCode)}.`,
    );
  });
};
