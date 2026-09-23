/**
 * Driving a vendor's headless login: it prints a URL, then blocks on stdin for a
 * code the user pastes back. A pasted code is only good for the URL its own
 * child printed, so nothing is stored and a second login replaces the first.
 *
 * Every hold is acted on by identity, never by instance id: a caller that was
 * waiting when its child was replaced would otherwise kill the login the user is
 * halfway through.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import {
  MAX_AUTHORIZE_URL_LENGTH,
  MAX_FACT_LENGTH,
  type LoginFailed,
  type LoginResult,
  type LoginUrl,
} from "@hercule/protocol";
import type { ProviderAdapter, ProviderRunnerContext } from "./index";
import { truncateFact } from "./text";

export interface LoginChild {
  readonly stdout: AsyncIterable<string>;
  readonly stderr: AsyncIterable<string>;
  /** Written to the child's stdin verbatim. */
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

/** A tab closed on the URL would otherwise block the vendor on stdin for ever. */
export const LOGIN_IDLE: Duration.Duration = Duration.minutes(10);

/**
 * A device login is silent from its code to its exit, so the idle clock
 * cannot reach it; what bounds it is how long the code it printed is good for.
 */
export const LOGIN_CODE_LIFETIME: Duration.Duration = Duration.minutes(15);

/** A vendor writes to stderr on its way out too, so a complaint may be overtaken. */
export const COMPLAINT_GRACE: Duration.Duration = Duration.seconds(2);

const NO_LOGIN = "no login in progress";

/** The tail, not the head: the failure prints last, the vendor's banner first. */
const readTail = (value: string, whenSilent: string): string =>
  value.trim() === "" ? whenSilent : value.trim().slice(-MAX_FACT_LENGTH);

const buildLoginFailed = (message: string): LoginAnswer => ({
  _tag: "loginFailed",
  message: truncateFact(message),
});

/**
 * Vendors print the URL inside an OSC 8 hyperlink, so read raw one address
 * becomes two with a control byte between them.
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
  readonly child: LoginChild;
  /**
   * The address, with the code beside it where the vendor prints one, or
   * nothing when the child ended before it had printed both.
   */
  readonly printed: Promise<Printed | undefined>;
  /** A login that prints a code reads nothing back: nobody submits to it. */
  readonly device: boolean;
  /** The address on its own, which is what tells a half-printed login from a silent one. */
  readonly address: () => string | undefined;
  /** Gives up on `printed`, for a child that was killed before it printed. */
  readonly abandon: () => void;
  /** Resolves with the child's next complaint, and never when it ends first. */
  readonly nextComplaint: () => Promise<string>;
  readonly transcript: () => string;
  /** Absent only between the spawn and the first turn of the clock. */
  idle: Fiber.Fiber<void> | undefined;
}

export const makeLogins = (
  spawn: LoginSpawn,
): {
  readonly start: (
    instanceId: string,
    adapter: ProviderAdapter,
    ctx: ProviderRunnerContext,
  ) => Effect.Effect<LoginAnswer>;
  readonly submit: (instanceId: string, code: string) => Effect.Effect<LoginAnswer>;
  readonly stopAll: Effect.Effect<void>;
} => {
  const held = new Map<string, Held>();

  const forgetLogin = (instanceId: string, login: Held): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (held.get(instanceId) !== login) return Effect.void;
      held.delete(instanceId);
      return login.idle === undefined ? Effect.void : Fiber.interrupt(login.idle);
    });

  const stopLogin = (instanceId: string, login: Held): Effect.Effect<void> =>
    Effect.suspend(() => {
      login.child.kill();
      // A killed child's pipes do not always end, so the reader cannot be the
      // one to say this login has nothing more to print.
      login.abandon();
      return forgetLogin(instanceId, login);
    });

  /**
   * Restarts the clock on a login that just showed a sign of life. A device
   * login shows none - it is read from, never written to - so its clock is the
   * lifetime of the code it printed, armed once here and never restarted.
   */
  const armExpiry = (instanceId: string, login: Held): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (login.idle !== undefined) yield* Fiber.interrupt(login.idle);
      login.idle = yield* Effect.forkDetach(
        Effect.andThen(
          Effect.sleep(login.device ? LOGIN_CODE_LIFETIME : LOGIN_IDLE),
          stopLogin(instanceId, login),
        ),
      );
    });

  const openLogin = (instanceId: string, command: LoginCommand): Effect.Effect<Held> =>
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
       * Both halves or neither: an address answered before the code beside it
       * has been read would send the user to a page they cannot get past. A
       * command that names no pattern is complete at the address.
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
      // The reader, not the exit, is what says a child has stopped printing: a
      // child that exits on the line after its code has still printed both.
      void spent.then(() => {
        settle(buildPrinted());
      });
      void readLines(child.stderr, (line) => {
        transcript = `${transcript}${line}\n`.slice(-MAX_TRANSCRIPT);
        // A blank line is the vendor's formatting, not a complaint, and the
        // protocol will not carry it as one.
        if (line.trim() === "") return;
        for (const waiting of complaints.splice(0)) waiting(line);
      }).catch(() => undefined);
      const login: Held = {
        child,
        device: pattern !== undefined,
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
        idle: undefined,
      };
      held.set(instanceId, login);
      // A vendor that gave up on its own is not a login anyone can still finish.
      void child.exited
        .then(() => Effect.runPromise(forgetLogin(instanceId, login)))
        .catch(() => undefined);
      yield* armExpiry(instanceId, login);
      return login;
    });

  return {
    start: (instanceId, adapter, ctx) =>
      Effect.gen(function* () {
        if (adapter.login === undefined) {
          return buildLoginFailed(`${adapter.providerId} has no login in this runner build`);
        }
        if (ctx.binary === undefined) {
          return buildLoginFailed(`no ${adapter.binaryName} on this machine`);
        }
        // The code a user pastes is only good for the URL of the child that
        // printed it, so two logins for one instance cannot both be waiting.
        const previous = held.get(instanceId);
        if (previous !== undefined) yield* stopLogin(instanceId, previous);
        const login = yield* openLogin(instanceId, adapter.login(ctx, ctx.binary));
        const printed = yield* Effect.promise(() => login.printed);
        if (printed === undefined) {
          yield* stopLogin(instanceId, login);
          // A device login that printed its address and stopped is a login with
          // no code to show, which is not the same as one that printed nothing.
          return buildLoginFailed(
            readTail(
              login.transcript(),
              login.address() === undefined
                ? "the login ended without a URL"
                : "the login printed no code to type",
            ),
          );
        }
        // Cutting it would hand the browser an address that cannot complete the
        // login, which is worse than saying the vendor printed something odd.
        if (printed.url.length > MAX_AUTHORIZE_URL_LENGTH) {
          yield* stopLogin(instanceId, login);
          return buildLoginFailed("the login printed an address too long to relay");
        }
        return {
          _tag: "loginUrl",
          url: printed.url,
          ...(printed.userCode === undefined ? {} : { userCode: printed.userCode }),
        };
      }),

    submit: (instanceId, code) =>
      Effect.gen(function* () {
        const login = held.get(instanceId);
        if (login === undefined) return buildLoginFailed(NO_LOGIN);
        // The user types this login's code into the browser, and the browser
        // finishes it with the vendor: there is nothing here to hand a code to
        // and nothing to wait for.
        if (login.device) return buildLoginFailed("this login takes no code");
        yield* armExpiry(instanceId, login);
        yield* Effect.sync(() => {
          // The newline is what makes it a line: the vendor is reading one, and
          // without it the child waits for ever on a code it already has.
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
          // The vendor writes to stderr on its way out too, so a complaint only
          // means a refused code once the child has proved it is staying.
          const after = yield* Effect.timeoutOption(ended, COMPLAINT_GRACE);
          if (after._tag === "None") {
            // It re-prompts rather than giving up, so the child stays and the
            // user gets another go at the same URL.
            return { _tag: "loginResult", ok: false, message: truncateFact(outcome.complaint) };
          }
          yield* forgetLogin(instanceId, login);
          return buildLoginResult(after.value, login.transcript());
        }
        yield* forgetLogin(instanceId, login);
        return buildLoginResult(outcome.exit, login.transcript());
      }),

    // Suspended: the map is read when shutdown runs, not when this object is
    // built, which is before any login exists.
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
