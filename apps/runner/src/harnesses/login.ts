/**
 * Runs a vendor's headless login. The login prints a URL, then waits on stdin
 * for a code the user pastes back from the browser. A pasted code only works
 * with the URL its own child process printed, so nothing is stored and a
 * second login replaces the first.
 *
 * Every operation on a held login checks that it is the same login object,
 * not just the same Provider Account id. Otherwise a caller that was still waiting
 * when its login was replaced would kill the login the user is halfway
 * through.
 *
 * A device login reads nothing back, so no request is waiting when it ends.
 * Its end is reported instead, through `attachConnection`, so the controller can probe
 * the account and learn whether the user finished it in the browser.
 *
 * A terminal login runs its command in a pseudo-terminal, because the vendor
 * draws a text UI that prints nothing on plain pipes. The runner reads the
 * screen that UI draws (see `TerminalScreen`), not its raw output. A login
 * that makes a token returns the token in its success result.
 */
import { rmSync } from "node:fs";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import {
  MAX_AUTHORIZE_URL_LENGTH,
  MAX_FACT_LENGTH,
  type LoginEnded,
  type LoginFailed,
  type LoginMethod,
  type LoginResult,
  type LoginUrl,
} from "@hercule/protocol";
import type { HarnessAdapter, HarnessRunnerContext } from "./index";
import { STOP_GRACE } from "./process";
import { TerminalScreen } from "./terminal-screen";
import { truncateFact } from "./text";

export interface LoginChild {
  readonly stdout: AsyncIterable<string>;
  readonly stderr: AsyncIterable<string>;
  /** Writes text to the child's stdin unchanged. */
  readonly write: (text: string) => void;
  readonly kill: () => void;
  readonly exited: Promise<number>;
}

/** How a login process is started, beyond its command and environment. */
export interface LoginSpawnOptions {
  /** The directory the process runs in. Left out, it runs in the runner's own. */
  readonly cwd?: string;
  /**
   * The size of the pseudo-terminal to run the process in. Left out, the
   * process gets plain pipes. A process in a terminal has one output stream,
   * which `LoginChild.stdout` carries, and `stderr` is empty.
   */
  readonly terminal?: { readonly cols: number; readonly rows: number };
}

export type LoginSpawn = (
  command: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
  options?: LoginSpawnOptions,
) => LoginChild;

export interface LoginCommand {
  readonly command: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * Set by a vendor that prints a one-time code for the user to type in the
   * browser. Such a login reads nothing back: it ends when its child does.
   */
  readonly userCode?: RegExp;
  /**
   * Runs the command in a pseudo-terminal of this size, and reads the screen
   * it draws instead of lines. Width matters: a text UI wraps its lines at the
   * width of the terminal, so a wide one keeps a URL or token on one line.
   *
   * A terminal login writes the code followed by Enter. A vendor UI that shows
   * a rejected code starts a new sign-in with a new URL when the user presses
   * Enter, so the URL already shown is useless afterwards. A rejected code
   * therefore ends the login (see `refusal`).
   */
  readonly terminal?: { readonly cols: number; readonly rows: number };
  /**
   * A folder made for this login alone. It is the command's working directory,
   * and the runner removes it when the login ends, however it ends: the
   * command exiting, being killed, or failing to start.
   */
  readonly scratchFolder?: string;
  /**
   * For a terminal login: matches a screen line where the vendor says it
   * refused the pasted code. Such a line ends the login with a failed result.
   * Only a line that appeared or changed after the code was written is
   * tested, so it can be worded to match the vendor's own refusal and need not
   * avoid every other message the vendor draws.
   */
  readonly refusal?: RegExp;
  /**
   * Set by a login that makes a token. Matches the token as it appears on the
   * screen; the first match is returned in the success result. Matches are
   * also removed from every message the login reports, so a token never
   * reaches a log or the controller's error text. It must not match
   * whitespace, and it should not have the `g` flag.
   */
  readonly tokenPattern?: RegExp;
}

/** The login frames minus the request id, which belongs to the connection. */
export type LoginAnswer =
  | Omit<LoginUrl, "requestId">
  | Omit<LoginFailed, "requestId">
  | Omit<LoginResult, "requestId">;

/**
 * How long a login may sit idle before it is killed. Without a limit, a
 * browser tab closed on the URL would leave the vendor blocked on stdin forever.
 */
export const LOGIN_IDLE: Duration.Duration = Duration.minutes(10);

/**
 * How long a device login may run. A device login prints nothing between its
 * code and its exit, so the idle timeout does not apply to it. The limit is how
 * long the printed code stays valid.
 */
export const LOGIN_CODE_LIFETIME: Duration.Duration = Duration.minutes(15);

/**
 * How long to wait after a stderr line before treating it as a rejected code.
 * A vendor also writes to stderr as it exits, so the exit may follow closely.
 */
export const COMPLAINT_GRACE: Duration.Duration = Duration.seconds(2);

const NO_LOGIN = "no login in progress";

/**
 * Returns the end of `value`, cut to the length the protocol allows, or
 * `whenSilent` when `value` is blank. The end rather than the start, because
 * the vendor prints its banner first and the failure last.
 */
const readTail = (value: string, whenSilent: string): string =>
  value.trim() === "" ? whenSilent : value.trim().slice(-MAX_FACT_LENGTH);

const buildLoginFailed = (message: string): LoginAnswer => ({
  _tag: "loginFailed",
  message: truncateFact(message),
});

/**
 * Matches terminal escape sequences and control characters. Vendors print the
 * URL inside an OSC 8 hyperlink, so the raw line holds the address twice with
 * control bytes between the copies.
 */
const CONTROL =
  // eslint-disable-next-line no-control-regex
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[ -/]*[@-~]|[\u0000-\u001f\u007f]/g;

const stripControlCharacters = (line: string): string => line.replace(CONTROL, "");

const readLines = async (
  stream: AsyncIterable<string>,
  onLine: (line: string) => void,
): Promise<void> => {
  let buffered = "";
  for await (const chunk of stream) {
    buffered += chunk;
    const parts = buffered.split("\n");
    buffered = parts.pop() ?? "";
    for (const part of parts) onLine(stripControlCharacters(part));
  }
  if (buffered !== "") onLine(stripControlCharacters(buffered));
};

const AUTHORIZE = /https:\/\/\S+/;

const MAX_TRANSCRIPT = 4096;

/**
 * Reads the output of a terminal login into `screen`. After each chunk it
 * calls `onScreen` with the lines the cursor has moved past. A line the
 * program is still writing is not passed: a URL cut in the middle by the
 * chunk boundary is not the URL. When the output ends, every line is passed,
 * because nothing more will be written to the last one.
 */
const readScreen = async (
  stream: AsyncIterable<string>,
  screen: TerminalScreen,
  onScreen: (lines: ReadonlyArray<string>) => void,
): Promise<void> => {
  for await (const chunk of stream) {
    screen.feed(chunk);
    onScreen(screen.readFinishedLines());
  }
  onScreen(screen.readLines());
};

/** Returns `text` with every token the command's `tokenPattern` matches replaced by a placeholder. */
const removeToken = (command: LoginCommand, text: string): string =>
  command.tokenPattern === undefined
    ? text
    : text.replace(new RegExp(command.tokenPattern.source, "g"), "[token removed]");

interface Printed {
  readonly url: string;
  readonly userCode: string | undefined;
}

interface Held {
  /** The request id of the `loginStart` that started this login. Its `LoginEnded` carries it. */
  readonly requestId: string;
  readonly child: LoginChild;
  /**
   * The URL, plus the code when the vendor prints one. Resolves to `undefined`
   * when the child stops printing before both have appeared.
   */
  readonly printed: Promise<Printed | undefined>;
  /**
   * The URL on its own. It tells a login that printed only the URL apart from one that printed
   * nothing.
   */
  readonly address: () => string | undefined;
  /** Resolves `printed` with `undefined`, for a child that was killed before it printed. */
  readonly abandon: () => void;
  /** Resolves with the child's next complaint, and never when it ends first. */
  readonly nextComplaint: () => Promise<string>;
  /** What the child showed, ending with the latest. A token the command printed is removed. */
  readonly transcript: () => string;
  /** Resolves once everything the child printed has been read. */
  readonly finished: Promise<void>;
  /** Whether the child runs in a pseudo-terminal, which takes Enter, not a newline, to end a line. */
  readonly terminal: boolean;
  /** Whether the login makes a token, which the success result must then carry. */
  readonly makesToken: boolean;
  /** Returns the token on the screen, or `undefined` when there is none. */
  readonly readToken: () => string | undefined;
  /** Removes the login's scratch folder, if it has one. Safe to call more than once. */
  readonly removeScratchFolder: () => void;
  /** Resolves once the child has exited and its scratch folder is removed. */
  readonly cleanedUp: Promise<void>;
  /**
   * When a device login's code stops being valid, in milliseconds on this
   * machine's clock. Undefined for a login that reads a code back, so it also
   * tells the two kinds apart (see `isDeviceLogin`).
   */
  readonly expiresAt: number | undefined;
  /** The expiry timer. Undefined only between the spawn and the first call to `armExpiry`. */
  idle: Fiber.Fiber<void> | undefined;
}

/**
 * Checks whether a held login is a device login: one that prints a code for
 * the user to type in the browser and reads nothing back, so nothing can be
 * submitted to it. Only a device login has an expiry instant.
 */
const isDeviceLogin = (login: Held): boolean => login.expiresAt !== undefined;

/** Sends a `LoginEnded` frame to the controller. */
type ReportLoginEnded = (frame: LoginEnded) => Effect.Effect<void, unknown>;

export interface Logins {
  readonly start: (
    requestId: string,
    providerAccountId: string,
    adapter: HarnessAdapter,
    ctx: HarnessRunnerContext,
    method: LoginMethod,
  ) => Effect.Effect<LoginAnswer>;
  readonly submit: (providerAccountId: string, code: string) => Effect.Effect<LoginAnswer>;
  /**
   * Reports through `report` each device login that ends, for as long as the
   * scope is open. A login that ends while nothing is attached is not
   * reported: the controller probes every account when a runner connects, so
   * the next connection makes up for it.
   */
  readonly attachConnection: (report: ReportLoginEnded) => Effect.Effect<void, never, Scope.Scope>;
  readonly stopAll: Effect.Effect<void>;
}

export const makeLogins = (spawn: LoginSpawn): Logins => {
  const held = new Map<string, Held>();
  let reporting: ReportLoginEnded | undefined;

  /**
   * Reports that a device login ended, under the request id that started it,
   * so the controller knows which of its logins ended. A failed send is dropped: the
   * connection is going away, and the next one probes every account anyway.
   */
  const reportEnded = (login: Held): Effect.Effect<void> =>
    Effect.suspend(() =>
      reporting === undefined
        ? Effect.void
        : Effect.ignore(reporting({ _tag: "loginEnded", requestId: login.requestId })),
    );

  const forgetLogin = (providerAccountId: string, login: Held): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (held.get(providerAccountId) !== login) return Effect.void;
      held.delete(providerAccountId);
      return login.idle === undefined ? Effect.void : Fiber.interrupt(login.idle);
    });

  const stopLogin = (providerAccountId: string, login: Held): Effect.Effect<void> =>
    Effect.suspend(() => {
      login.child.kill();
      // A killed child's pipes do not always close, so the stdout reader cannot
      // be relied on to resolve `printed`.
      login.abandon();
      return forgetLogin(providerAccountId, login);
    });

  /**
   * Restarts the expiry timer of a login that just showed activity. A device
   * login shows none, because nothing is ever written to it. Its timer is the
   * lifetime of the code it printed, started once and never restarted, and
   * its expiry is reported like any other end, so nobody keeps waiting for a
   * code that no longer works.
   */
  const armExpiry = (providerAccountId: string, login: Held): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (login.idle !== undefined) yield* Fiber.interrupt(login.idle);
      login.idle = yield* Effect.forkDetach(
        Effect.sleep(isDeviceLogin(login) ? LOGIN_CODE_LIFETIME : LOGIN_IDLE).pipe(
          // Clear the timer first: stopping the login interrupts the timer it
          // holds, and this fiber must not interrupt itself before it reports.
          Effect.andThen(
            Effect.sync(() => {
              login.idle = undefined;
            }),
          ),
          Effect.andThen(stopLogin(providerAccountId, login)),
          Effect.andThen(isDeviceLogin(login) ? reportEnded(login) : Effect.void),
        ),
      );
    });

  const openLogin = (
    requestId: string,
    providerAccountId: string,
    command: LoginCommand,
  ): Effect.Effect<Held> =>
    Effect.gen(function* () {
      const removeScratchFolder = (): void => {
        if (command.scratchFolder === undefined) return;
        try {
          rmSync(command.scratchFolder, { recursive: true, force: true });
        } catch {
          // Nothing else can be done about a folder that will not go away, and
          // the login's own result matters more than its leftovers.
        }
      };
      const child = yield* Effect.sync(() =>
        spawn(command.command, command.env, {
          ...(command.scratchFolder === undefined ? {} : { cwd: command.scratchFolder }),
          ...(command.terminal === undefined ? {} : { terminal: command.terminal }),
        }),
      ).pipe(Effect.onError(() => Effect.sync(removeScratchFolder)));
      // Remove the folder only once the child is gone: a child that is still
      // running could write into it again.
      const cleanedUp = child.exited.then(removeScratchFolder, removeScratchFolder);
      const pattern = command.userCode;
      const screen =
        command.terminal === undefined ? undefined : new TerminalScreen(command.terminal.cols);
      const complaints: Array<(line: string) => void> = [];
      // The screen's lines when the code was written. The refusal is a line
      // that is not among them, so a warning the vendor drew before it asked
      // for the code cannot refuse the code.
      let linesBeforeCode = new Set<string>();
      let transcript = "";
      let url: string | undefined;
      let userCode: string | undefined;
      let settle: (printed: Printed | undefined) => void = () => undefined;
      const printed = new Promise<Printed | undefined>((resolve) => {
        settle = resolve;
      });
      /**
       * Returns the URL and code only once both have been read. Returning the
       * URL before its code would send the user to a page they cannot get past.
       * For a command with no code pattern, the URL alone is complete.
       */
      const buildPrinted = (): Printed | undefined =>
        url === undefined || (pattern !== undefined && userCode === undefined)
          ? undefined
          : { url, userCode };
      const scanLine = (line: string): void => {
        if (pattern !== undefined && userCode === undefined) {
          const code = pattern.exec(line);
          if (code !== null) userCode = code[0];
        }
        if (url === undefined) {
          const match = AUTHORIZE.exec(line);
          if (match !== null) url = match[0];
        }
        const found = buildPrinted();
        if (found !== undefined) settle(found);
      };
      const readToken = (): string | undefined => {
        if (command.tokenPattern === undefined || screen === undefined) return undefined;
        for (const line of screen.readLines()) {
          const match = command.tokenPattern.exec(line);
          if (match !== null) return match[0];
        }
        return undefined;
      };
      const spent = (
        screen === undefined
          ? readLines(child.stdout, scanLine)
          : readScreen(child.stdout, screen, (lines) => {
              for (const line of lines) scanLine(line);
              if (command.refusal === undefined || complaints.length === 0) return;
              const refused = lines.find(
                (line) => !linesBeforeCode.has(line) && command.refusal!.test(line),
              );
              if (refused === undefined) return;
              for (const waiting of complaints.splice(0)) waiting(removeToken(command, refused));
            })
      ).catch(() => undefined);
      // Treat the end of stdout, not the process exit, as the end of the
      // output: a child that exits right after printing its code has still
      // printed both.
      void spent.then(() => {
        settle(buildPrinted());
      });
      void readLines(child.stderr, (line) => {
        transcript = `${transcript}${line}\n`.slice(-MAX_TRANSCRIPT);
        // A blank line is formatting, not an error message, and the protocol
        // does not accept an empty message.
        if (line.trim() === "") return;
        for (const waiting of complaints.splice(0)) waiting(line);
      }).catch(() => undefined);
      const login: Held = {
        requestId,
        child,
        address: () => url,
        abandon: () => {
          settle(undefined);
        },
        printed,
        nextComplaint: () =>
          new Promise<string>((resolve) => {
            linesBeforeCode = new Set(screen?.readLines());
            complaints.push(resolve);
          }),
        transcript: () =>
          removeToken(
            command,
            screen === undefined
              ? transcript
              : screen
                  .readLines()
                  .filter((line) => line.trim() !== "")
                  .join("\n")
                  .slice(-MAX_TRANSCRIPT),
          ),
        finished: spent,
        terminal: screen !== undefined,
        makesToken: command.tokenPattern !== undefined,
        readToken,
        removeScratchFolder,
        cleanedUp,
        expiresAt:
          pattern === undefined
            ? undefined
            : (yield* Clock.currentTimeMillis) + Duration.toMillis(LOGIN_CODE_LIFETIME),
        idle: undefined,
      };
      held.set(providerAccountId, login);
      // Once the vendor exits on its own, nobody can finish this login. A
      // device login exits on its own when the user finishes it in the
      // browser, so its exit is reported. A login that is no longer held was
      // stopped or replaced, and its end means nothing.
      void child.exited
        .then(() =>
          Effect.runPromise(
            Effect.suspend(() =>
              held.get(providerAccountId) === login && isDeviceLogin(login)
                ? Effect.andThen(forgetLogin(providerAccountId, login), reportEnded(login))
                : forgetLogin(providerAccountId, login),
            ),
          ),
        )
        .catch(() => undefined);
      yield* armExpiry(providerAccountId, login);
      return login;
    });

  return {
    start: (requestId, providerAccountId, adapter, ctx, method) =>
      Effect.gen(function* () {
        if (adapter.login === undefined) {
          return buildLoginFailed(
            `The harness ${adapter.harnessId} has no login in this runner build`,
          );
        }
        if (ctx.binary === undefined) {
          return buildLoginFailed(`no ${adapter.binaryName} on this machine`);
        }
        // The hook may make a scratch folder, so nothing that can fail runs
        // between it and `openLogin`, which removes the folder if the spawn fails.
        const command = adapter.login(ctx, ctx.binary, method);
        if (command === undefined) {
          return buildLoginFailed(
            `The harness ${adapter.harnessId} cannot ${method === "create-token" ? "create a token" : "sign in"} in this runner build`,
          );
        }
        // A pasted code only works with the URL of the child that printed it,
        // so only one login per Provider Account can be waiting.
        const previous = held.get(providerAccountId);
        if (previous !== undefined) yield* stopLogin(providerAccountId, previous);
        const login = yield* openLogin(requestId, providerAccountId, command);
        const printed = yield* Effect.promise(() => login.printed);
        if (printed === undefined) {
          yield* stopLogin(providerAccountId, login);
          // A device login that printed its URL but no code fails for a
          // different reason than one that printed nothing, so the messages differ.
          return buildLoginFailed(
            readTail(
              login.transcript(),
              login.address() === undefined
                ? "the login ended without a URL"
                : "the login printed no code to type",
            ),
          );
        }
        // A truncated URL cannot complete the login in the browser, so fail with
        // a clear message instead.
        if (printed.url.length > MAX_AUTHORIZE_URL_LENGTH) {
          yield* stopLogin(providerAccountId, login);
          return buildLoginFailed("the login printed a URL that is too long to pass on");
        }
        if (printed.userCode === undefined || login.expiresAt === undefined) {
          return { _tag: "loginUrl", url: printed.url };
        }
        const now = yield* Clock.currentTimeMillis;
        return {
          _tag: "loginUrl",
          url: printed.url,
          userCode: printed.userCode,
          // At least one second: the code was valid a moment ago, and the
          // protocol does not accept zero.
          expiresInSeconds: Math.max(1, Math.floor((login.expiresAt - now) / 1000)),
        };
      }),

    attachConnection: (report) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          reporting = report;
        }),
        () =>
          Effect.sync(() => {
            if (reporting === report) reporting = undefined;
          }),
      ),

    submit: (providerAccountId, code) =>
      Effect.gen(function* () {
        const login = held.get(providerAccountId);
        if (login === undefined) return buildLoginFailed(NO_LOGIN);
        // For a device login the user types the code into the browser, and the
        // browser completes the login with the vendor. The child reads nothing,
        // so there is nothing to submit and nothing to wait for.
        if (isDeviceLogin(login))
          return buildLoginFailed(
            "this login does not accept a code here; type the code it showed into the browser",
          );
        yield* armExpiry(providerAccountId, login);
        yield* Effect.sync(() => {
          // End the line: the vendor reads a whole line, and without it the
          // child would wait forever for a code it already has. A terminal's
          // Enter key sends a carriage return.
          login.child.write(`${code}${login.terminal ? "\r" : "\n"}`);
        });
        const ended = Effect.promise(() => login.child.exited);
        const outcome = yield* Effect.promise(() =>
          Promise.race([
            login.nextComplaint().then((line) => ({ complaint: line })),
            login.child.exited.then((exit) => ({ exit })),
          ]),
        );
        if ("complaint" in outcome && login.terminal) {
          // The vendor's own screen answers a refused code with a new sign-in
          // and a new URL, so the URL the user holds is dead.
          yield* stopLogin(providerAccountId, login);
          const reason = truncateFact(outcome.complaint.trim()).replace(/[.\s]+$/, "");
          return buildLoginFailed(
            `${reason}. This sign-in cannot take another code; start it again for a new link.`,
          );
        }
        if ("complaint" in outcome) {
          // The vendor also writes to stderr as it exits, so a stderr line only
          // means the code was rejected if the child is still running after the
          // grace period.
          const after = yield* Effect.timeoutOption(ended, COMPLAINT_GRACE);
          if (after._tag === "None") {
            // The vendor asks again rather than exiting, so keep the child: the
            // user can try again with the same URL.
            return { _tag: "loginResult", ok: false, message: truncateFact(outcome.complaint) };
          }
          yield* forgetLogin(providerAccountId, login);
          return yield* finishLogin(login, after.value);
        }
        yield* forgetLogin(providerAccountId, login);
        return yield* finishLogin(login, outcome.exit);
      }),

    // Suspend, so the map is read when shutdown runs rather than when this
    // object is built, which is before any login exists.
    stopAll: Effect.suspend(() => {
      const entries = [...held];
      const logins = entries.map(([, login]) => login);
      return Effect.forEach(
        entries,
        ([providerAccountId, login]) => stopLogin(providerAccountId, login),
        {
          discard: true,
        },
      ).pipe(
        // The runner is about to exit, and a folder whose removal is still
        // waiting on a child's exit would be left behind.
        Effect.andThen(
          Effect.timeoutOption(
            Effect.promise(() => Promise.all(logins.map((login) => login.cleanedUp))),
            STOP_GRACE,
          ),
        ),
        Effect.andThen(Effect.sync(() => logins.forEach((login) => login.removeScratchFolder()))),
      );
    }),
  };
};

/**
 * Returns the answer for a login whose child has exited. A non-zero exit fails
 * with the end of what the child showed. A login that makes a token also needs
 * the token on the screen: an exit without one is a failure, because the
 * controller would otherwise store nothing and report the account signed in.
 */
const finishLogin = (login: Held, exit: number): Effect.Effect<LoginAnswer> =>
  Effect.gen(function* () {
    if (exit !== 0) {
      return {
        _tag: "loginResult",
        ok: false,
        message: readTail(login.transcript(), "the login ended without finishing"),
      };
    }
    if (!login.makesToken) return { _tag: "loginResult", ok: true };
    // The token is the last thing the child prints, so read it only once the
    // output has ended. The wait is bounded because a pipe may stay open.
    yield* Effect.timeoutOption(
      Effect.promise(() => login.finished),
      COMPLAINT_GRACE,
    );
    const token = login.readToken();
    return token === undefined
      ? { _tag: "loginResult", ok: false, message: "the login finished without printing a token" }
      : { _tag: "loginResult", ok: true, token };
  });
