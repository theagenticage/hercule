/**
 * Runs a vendor's headless login. The login prints a URL, then waits on stdin
 * for a code the user pastes back from the browser. A pasted code only works
 * with the URL its own child process printed, so nothing is stored and a
 * second login replaces the first.
 *
 * Every operation on a held login checks that it is the same login object,
 * not just the same instance id. Otherwise a caller that was still waiting
 * when its login was replaced would kill the login the user is halfway
 * through.
 *
 * A device login reads nothing back, so no request is waiting when it ends.
 * Its end is reported instead, through `attachConnection`, so the controller can probe
 * the instance and learn whether the user finished it in the browser.
 */
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
  type LoginResult,
  type LoginUrl,
} from "@hercule/protocol";
import type { ProviderAdapter, ProviderRunnerContext } from "./index";
import { truncateFact } from "./text";

export interface LoginChild {
  readonly stdout: AsyncIterable<string>;
  readonly stderr: AsyncIterable<string>;
  /** Writes text to the child's stdin unchanged. */
  readonly write: (text: string) => void;
  readonly kill: () => void;
  readonly exited: Promise<number>;
}

export type LoginSpawn = (
  command: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
) => LoginChild;

export interface LoginCommand {
  readonly command: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * Set by a vendor that prints a one-time code for the user to type in the
   * browser. Such a login reads nothing back: it ends when its child does.
   */
  readonly userCode?: RegExp;
}

/** The login frames minus the request id, which belongs to the connection. */
export type LoginAnswer =
  Omit<LoginUrl, "requestId"> | Omit<LoginFailed, "requestId"> | Omit<LoginResult, "requestId">;

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
  readonly transcript: () => string;
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
    instanceId: string,
    adapter: ProviderAdapter,
    ctx: ProviderRunnerContext,
  ) => Effect.Effect<LoginAnswer>;
  readonly submit: (instanceId: string, code: string) => Effect.Effect<LoginAnswer>;
  /**
   * Reports through `report` each device login that ends, for as long as the
   * scope is open. A login that ends while nothing is attached is not
   * reported: the controller probes every instance when a runner connects, so
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
   * connection is going away, and the next one probes every instance anyway.
   */
  const reportEnded = (login: Held): Effect.Effect<void> =>
    Effect.suspend(() =>
      reporting === undefined
        ? Effect.void
        : Effect.ignore(reporting({ _tag: "loginEnded", requestId: login.requestId })),
    );

  const forgetLogin = (instanceId: string, login: Held): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (held.get(instanceId) !== login) return Effect.void;
      held.delete(instanceId);
      return login.idle === undefined ? Effect.void : Fiber.interrupt(login.idle);
    });

  const stopLogin = (instanceId: string, login: Held): Effect.Effect<void> =>
    Effect.suspend(() => {
      login.child.kill();
      // A killed child's pipes do not always close, so the stdout reader cannot
      // be relied on to resolve `printed`.
      login.abandon();
      return forgetLogin(instanceId, login);
    });

  /**
   * Restarts the expiry timer of a login that just showed activity. A device
   * login shows none, because nothing is ever written to it. Its timer is the
   * lifetime of the code it printed, started once and never restarted, and
   * its expiry is reported like any other end, so nobody keeps waiting for a
   * code that no longer works.
   */
  const armExpiry = (instanceId: string, login: Held): Effect.Effect<void> =>
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
          Effect.andThen(stopLogin(instanceId, login)),
          Effect.andThen(isDeviceLogin(login) ? reportEnded(login) : Effect.void),
        ),
      );
    });

  const openLogin = (
    requestId: string,
    instanceId: string,
    command: LoginCommand,
  ): Effect.Effect<Held> =>
    Effect.gen(function* () {
      const child = spawn(command.command, command.env);
      const pattern = command.userCode;
      const complaints: Array<(line: string) => void> = [];
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
      const spent = readLines(child.stdout, (line) => {
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
      }).catch(() => undefined);
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
            complaints.push(resolve);
          }),
        transcript: () => transcript,
        expiresAt:
          pattern === undefined
            ? undefined
            : (yield* Clock.currentTimeMillis) + Duration.toMillis(LOGIN_CODE_LIFETIME),
        idle: undefined,
      };
      held.set(instanceId, login);
      // Once the vendor exits on its own, nobody can finish this login. A
      // device login exits on its own when the user finishes it in the
      // browser, so its exit is reported. A login that is no longer held was
      // stopped or replaced, and its end means nothing.
      void child.exited
        .then(() =>
          Effect.runPromise(
            Effect.suspend(() =>
              held.get(instanceId) === login && isDeviceLogin(login)
                ? Effect.andThen(forgetLogin(instanceId, login), reportEnded(login))
                : forgetLogin(instanceId, login),
            ),
          ),
        )
        .catch(() => undefined);
      yield* armExpiry(instanceId, login);
      return login;
    });

  return {
    start: (requestId, instanceId, adapter, ctx) =>
      Effect.gen(function* () {
        if (adapter.login === undefined) {
          return buildLoginFailed(`${adapter.providerId} has no login in this runner build`);
        }
        if (ctx.binary === undefined) {
          return buildLoginFailed(`no ${adapter.binaryName} on this machine`);
        }
        // A pasted code only works with the URL of the child that printed it,
        // so only one login per instance can be waiting.
        const previous = held.get(instanceId);
        if (previous !== undefined) yield* stopLogin(instanceId, previous);
        const login = yield* openLogin(requestId, instanceId, adapter.login(ctx, ctx.binary));
        const printed = yield* Effect.promise(() => login.printed);
        if (printed === undefined) {
          yield* stopLogin(instanceId, login);
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
          yield* stopLogin(instanceId, login);
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

    submit: (instanceId, code) =>
      Effect.gen(function* () {
        const login = held.get(instanceId);
        if (login === undefined) return buildLoginFailed(NO_LOGIN);
        // For a device login the user types the code into the browser, and the
        // browser completes the login with the vendor. The child reads nothing,
        // so there is nothing to submit and nothing to wait for.
        if (isDeviceLogin(login))
          return buildLoginFailed(
            "this login does not accept a code here; type the code it showed into the browser",
          );
        yield* armExpiry(instanceId, login);
        yield* Effect.sync(() => {
          // Add a newline: the vendor reads a whole line, and without it the
          // child would wait forever for a code it already has.
          login.child.write(`${code}\n`);
        });
        const ended = Effect.promise(() => login.child.exited);
        const outcome = yield* Effect.promise(() =>
          Promise.race([
            login.nextComplaint().then((line) => ({ complaint: line })),
            login.child.exited.then((exit) => ({ exit })),
          ]),
        );
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
          yield* forgetLogin(instanceId, login);
          return buildLoginResult(after.value, login.transcript());
        }
        yield* forgetLogin(instanceId, login);
        return buildLoginResult(outcome.exit, login.transcript());
      }),

    // Suspend, so the map is read when shutdown runs rather than when this
    // object is built, which is before any login exists.
    stopAll: Effect.suspend(() =>
      Effect.forEach([...held], ([instanceId, login]) => stopLogin(instanceId, login), {
        discard: true,
      }),
    ),
  };
};

const buildLoginResult = (exit: number, transcript: string): LoginAnswer =>
  exit === 0
    ? { _tag: "loginResult", ok: true }
    : {
        _tag: "loginResult",
        ok: false,
        message: readTail(transcript, "the login ended without finishing"),
      };
