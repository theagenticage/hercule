/**
 * Driving a vendor's own headless login on this machine.
 *
 * The vendor prints an authorize URL and then blocks on stdin waiting for the
 * code the user pastes back from a browser that may be on another machine
 * entirely. So the child is the whole state of the exchange: the pasted code is
 * only good for the URL that child printed, which is why nothing here is stored
 * and a second login for an instance replaces the first rather than joining it.
 *
 * Every hold is acted on by identity rather than by instance id. A caller that
 * was already waiting when its child was replaced wakes up holding the old one,
 * and killing "whatever is held for this instance" at that moment would take
 * down the login the user is halfway through.
 *
 * The child is reached through an injected spawn seam, because what the runner
 * makes of a login is the part worth stating without an account.
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
} from "@hydra/protocol";
import type { ProviderAdapter, ProviderRunnerContext } from "./index";

/** A vendor login as it is running: two pipes, a keyboard and a way to stop it. */
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

/** What an adapter's login is started as. */
export interface LoginCommand {
  readonly command: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * What the driver answers with: the login frames, minus the request id, which
 * belongs to the connection that asked rather than to the exchange.
 */
export type LoginAnswer =
  Omit<LoginUrl, "requestId"> | Omit<LoginFailed, "requestId"> | Omit<LoginResult, "requestId">;

/**
 * How long a login nobody finished is left holding a child. A tab closed on the
 * URL would otherwise leave the vendor blocked on stdin for the life of the
 * daemon.
 */
export const LOGIN_IDLE: Duration.Duration = Duration.minutes(10);

/**
 * How long a complaint waits to be overtaken by the child ending well. A vendor
 * writes to stderr for reasons other than refusing a code, and an exchange that
 * finished is a finished exchange whatever was said on the way out.
 */
export const COMPLAINT_GRACE: Duration.Duration = Duration.seconds(2);

const NO_LOGIN = "no login in progress";

/** Cut to what the protocol carries; one over-long line would fail the answer. */
const fact = (value: string): string => value.slice(0, MAX_FACT_LENGTH);

/**
 * What the child said, or what to say when it said nothing. The tail rather
 * than the head: whatever went wrong is the last thing a process prints, and a
 * vendor's banner is the first.
 */
const said = (value: string, whenSilent: string): string =>
  value.trim() === "" ? whenSilent : value.trim().slice(-MAX_FACT_LENGTH);

const failed = (message: string): LoginAnswer => ({ _tag: "loginFailed", message: fact(message) });

/**
 * A vendor writes for a terminal: colour, and a URL wrapped in an OSC 8
 * hyperlink whose target sits inside the escape beside the visible copy. Read
 * raw, one printed address becomes two with a control byte between them, which
 * is not something a browser can be handed.
 */
const CONTROL =
  // eslint-disable-next-line no-control-regex
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[ -/]*[@-~]|[\u0000-\u001f\u007f]/g;

const plain = (line: string): string => line.replace(CONTROL, "");

/** Splits a pipe into lines, and answers when the pipe is spent. */
const readLines = async (
  stream: AsyncIterable<string>,
  onLine: (line: string) => void,
): Promise<void> => {
  let buffered = "";
  for await (const chunk of stream) {
    buffered += chunk;
    const parts = buffered.split("\n");
    buffered = parts.pop() ?? "";
    for (const part of parts) onLine(plain(part));
  }
  if (buffered !== "") onLine(plain(buffered));
};

const AUTHORIZE = /https:\/\/\S+/;

/** As much of a chatty vendor's complaining as anyone will ever read. */
const MAX_TRANSCRIPT = 4096;

/** One login this machine is holding, and everything a caller can ask of it. */
interface Held {
  readonly child: LoginChild;
  /** The first authorize URL, or nothing when the child ended without one. */
  readonly url: Promise<string | undefined>;
  /** Resolves with the child's next complaint, and never when it ends first. */
  readonly nextComplaint: () => Promise<string>;
  /** Everything the child has complained about so far. */
  readonly transcript: () => string;
  /** Absent only between the spawn and the first turn of the clock. */
  idle: Fiber.Fiber<void> | undefined;
}

export const logins = (
  spawn: LoginSpawn,
): {
  readonly start: (
    instanceId: string,
    adapter: ProviderAdapter,
    ctx: ProviderRunnerContext,
  ) => Effect.Effect<LoginAnswer>;
  readonly submit: (instanceId: string, code: string) => Effect.Effect<LoginAnswer>;
  /** Ends every login this machine is holding. What shutdown owes the user. */
  readonly stopAll: Effect.Effect<void>;
} => {
  const held = new Map<string, Held>();

  /** Lets go of a login, if it is still the one this instance is holding. */
  const forget = (instanceId: string, login: Held): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (held.get(instanceId) !== login) return Effect.void;
      held.delete(instanceId);
      return login.idle === undefined ? Effect.void : Fiber.interrupt(login.idle);
    });

  /** Ends a login that is still running, whatever it is waiting for. */
  const stop = (instanceId: string, login: Held): Effect.Effect<void> =>
    Effect.suspend(() => {
      login.child.kill();
      return forget(instanceId, login);
    });

  /** Restarts the clock on a login that just showed a sign of life. */
  const keep = (instanceId: string, login: Held): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (login.idle !== undefined) yield* Fiber.interrupt(login.idle);
      login.idle = yield* Effect.forkDetach(
        Effect.andThen(Effect.sleep(LOGIN_IDLE), stop(instanceId, login)),
      );
    });

  const open = (instanceId: string, command: LoginCommand): Effect.Effect<Held> =>
    Effect.gen(function* () {
      const child = spawn(command.command, command.env);
      let found: (url: string | undefined) => void = () => undefined;
      const firstUrl = new Promise<string | undefined>((resolve) => {
        found = resolve;
      });
      const spent = readLines(child.stdout, (line) => {
        const match = AUTHORIZE.exec(line);
        if (match !== null) found(match[0]);
      }).catch(() => undefined);
      const complaints: Array<(line: string) => void> = [];
      let transcript = "";
      void readLines(child.stderr, (line) => {
        transcript = `${transcript}${line}\n`.slice(-MAX_TRANSCRIPT);
        // A blank line is the vendor's formatting, not a complaint, and the
        // protocol will not carry it as one.
        if (line.trim() === "") return;
        for (const waiting of complaints.splice(0)) waiting(line);
      }).catch(() => undefined);
      const login: Held = {
        child,
        // Three ways a URL stops being possible: it arrives, stdout ends, or the
        // child is gone. Killing a child does not always end its pipes, so
        // without the last one a replaced login waits for ever.
        url: Promise.race([
          firstUrl,
          spent.then(() => undefined),
          child.exited.then(() => undefined),
        ]),
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
        .then(() => Effect.runPromise(forget(instanceId, login)))
        .catch(() => undefined);
      yield* keep(instanceId, login);
      return login;
    });

  return {
    start: (instanceId, adapter, ctx) =>
      Effect.gen(function* () {
        if (adapter.login === undefined) {
          return failed(`${adapter.providerId} has no login in this runner build`);
        }
        if (ctx.binary === undefined) {
          return failed(`no ${adapter.binaryName} on this machine`);
        }
        // The code a user pastes is only good for the URL of the child that
        // printed it, so two logins for one instance cannot both be waiting.
        const previous = held.get(instanceId);
        if (previous !== undefined) yield* stop(instanceId, previous);
        const login = yield* open(instanceId, adapter.login(ctx, ctx.binary));
        const url = yield* Effect.promise(() => login.url);
        if (url === undefined) {
          yield* stop(instanceId, login);
          return failed(said(login.transcript(), "the login ended without a URL"));
        }
        // Cutting it would hand the browser an address that cannot complete the
        // login, which is worse than saying the vendor printed something odd.
        if (url.length > MAX_AUTHORIZE_URL_LENGTH) {
          yield* stop(instanceId, login);
          return failed("the login printed an address too long to relay");
        }
        return { _tag: "loginUrl", url };
      }),

    submit: (instanceId, code) =>
      Effect.gen(function* () {
        const login = held.get(instanceId);
        if (login === undefined) return failed(NO_LOGIN);
        yield* keep(instanceId, login);
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
            return { _tag: "loginResult", ok: false, message: fact(outcome.complaint) };
          }
          yield* forget(instanceId, login);
          return finished(after.value, login.transcript());
        }
        yield* forget(instanceId, login);
        return finished(outcome.exit, login.transcript());
      }),

    // Suspended: the map is read when shutdown runs, not when this object is
    // built, which is before any login exists.
    stopAll: Effect.suspend(() =>
      Effect.forEach([...held], ([instanceId, login]) => stop(instanceId, login), {
        discard: true,
      }),
    ),
  };
};

/** What a child that ran to the end says about the login it was driving. */
const finished = (exit: number, transcript: string): LoginAnswer =>
  exit === 0
    ? { _tag: "loginResult", ok: true }
    : {
        _tag: "loginResult",
        ok: false,
        message: said(transcript, "the login ended without finishing"),
      };
