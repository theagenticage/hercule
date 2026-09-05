/**
 * The runner the controller runs beside itself, so every Hydra is a fleet of at
 * least one without anybody enlisting a machine by hand.
 *
 * The child is a fleet member like any other: nothing records that it is local,
 * and all this module knows is what it said on stdout. Its token travels on
 * stdin, the one channel neither in `ps` nor inherited by what the child starts.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { LocalAnnouncement, LocalEnrolment } from "@hydra/protocol";
import { SYSTEM_ACTOR } from "../actor";
import { nowIso } from "../db";
import { AuditLog } from "../events";
import { JoinTokens } from "./join-tokens";

/**
 * Spawn, never fork: a forked Hydra would share this process's database handle
 * and its signal handlers.
 */
export const LOCAL_RUNNER_COMMAND: ReadonlyArray<string> = [process.execPath, "runner", "--local"];

const EMBEDDED = "/$bunfs/";

/**
 * For a Hydra that has not been compiled, whose executable is Bun rather than
 * Hydra. Without this, `hydra serve` from a checkout has no local runner.
 */
const spawnCommand = (): ReadonlyArray<string> =>
  Bun.main.startsWith(EMBEDDED)
    ? LOCAL_RUNNER_COMMAND
    : [process.execPath, Bun.main, "runner", "--local"];

export const LOCAL_RUNNER_BACKOFF = {
  first: Duration.seconds(1),
  cap: Duration.seconds(30),
} as const;

/** The listener's drain takes the same ten seconds, because it is the same shutdown. */
export const LOCAL_RUNNER_STOP_DEADLINE: Duration.Duration = Duration.seconds(10);

/** Nothing binds until the handshake is over, so a wedged child cannot hold the boot. */
const HANDSHAKE_DEADLINE: Duration.Duration = Duration.seconds(30);

/** How many deaths inside the window make a loop rather than a bad afternoon. */
export const CRASH_LOOP_LIMIT = 3;

export const CRASH_LOOP_WINDOW: Duration.Duration = Duration.minutes(5);

export interface LocalRunnerOptions {
  /** Injected: the shipped command is this binary, which under a test is the runner. */
  readonly command: ReadonlyArray<string>;
  readonly backoff: { readonly first: Duration.Duration; readonly cap: Duration.Duration };
  readonly stopDeadline: Duration.Duration;
  readonly handshakeDeadline: Duration.Duration;
}

export const LOCAL_RUNNER: LocalRunnerOptions = {
  command: spawnCommand(),
  backoff: LOCAL_RUNNER_BACKOFF,
  stopDeadline: LOCAL_RUNNER_STOP_DEADLINE,
  handshakeDeadline: HANDSHAKE_DEADLINE,
};

/**
 * Optional: a controller providing none logs instead, and the durable record is
 * the audit row either way. Reaching a person belongs to notifications.
 */
export interface RunnerAlertListener {
  readonly crashLooping: (
    runnerId: string | undefined,
    count: number,
  ) => Effect.Effect<void, never, never>;
}

export class RunnerAlerts extends Context.Service<RunnerAlerts, RunnerAlertListener>()(
  "hydra/controller/runners/RunnerAlerts",
) {}

export class LocalRunnerFailed extends Schema.TaggedError<LocalRunnerFailed>()(
  "LocalRunnerFailed",
  { message: Schema.String },
) {}

export interface LocalRunner {
  /** Held here and nowhere else: no column in the fleet says which member is local. */
  readonly runnerId: () => string | undefined;
  /** Saying it twice changes nothing. */
  readonly stop: Effect.Effect<void>;
}

const decodeAnnouncement = Schema.decodeUnknownEffect(LocalAnnouncement);
const encodeEnrolment = Schema.encodeUnknownSync(LocalEnrolment);

/** Its own function because a supervisor on the wall clock cannot skip five minutes. */
export const crashCounter = (
  limit: number,
  windowMs: number,
): { readonly record: (at: number) => number | undefined } => {
  const deaths: Array<number> = [];
  let reportedAt: number | undefined;
  return {
    record: (at: number): number | undefined => {
      deaths.push(at);
      while (deaths[0] !== undefined && at - deaths[0] > windowMs) deaths.shift();
      if (deaths.length < limit) return undefined;
      // One story rather than one per death, and a passed window is a new story.
      if (reportedAt !== undefined && at - reportedAt <= windowMs) return undefined;
      reportedAt = at;
      return deaths.length;
    },
  };
};

/**
 * The pipe is read whether or not anyone wants a line off it: a child whose
 * stdout filled up would block on its next log line.
 */
const announcement = (stdout: ReadableStream<Uint8Array>): Promise<string | undefined> => {
  let said: (line: string | undefined) => void = () => undefined;
  const first = new Promise<string | undefined>((resolve) => {
    said = resolve;
  });
  void (async () => {
    const decoder = new TextDecoder();
    let head = "";
    let heard = false;
    try {
      for await (const chunk of stdout) {
        const text = decoder.decode(chunk, { stream: true });
        if (heard) {
          process.stdout.write(text);
          continue;
        }
        head += text;
        const newline = head.indexOf("\n");
        if (newline < 0) continue;
        heard = true;
        said(head.slice(0, newline));
        process.stdout.write(head.slice(newline + 1));
      }
    } catch (cause) {
      // A broken pipe is a child that is gone; waiting the handshake deadline
      // out for it would hold the boot for half a minute.
      process.stderr.write(`hydra: the local runner's output ended: ${String(cause)}\n`);
    }
    if (!heard) said(undefined);
  })();
  return first;
};

/**
 * The first child is started here, so a handshake that cannot be completed stops
 * the boot rather than leaving a controller beside a child nothing understands.
 */
export const startLocalRunner = (
  options: LocalRunnerOptions,
  controllerUrl: string,
  home: string,
): Effect.Effect<LocalRunner, LocalRunnerFailed | SqlError, Scope.Scope | JoinTokens | AuditLog> =>
  Effect.gen(function* () {
    const joinTokens = yield* JoinTokens;
    const audit = yield* AuditLog;
    const alerts = yield* Effect.serviceOption(RunnerAlerts);

    let child: Bun.Subprocess<"pipe", "pipe", "inherit"> | undefined;
    let announced: string | undefined;
    let supervisor: Fiber.Fiber<void> | undefined = undefined;
    let stopping = false;
    const loop = crashCounter(CRASH_LOOP_LIMIT, Duration.toMillis(CRASH_LOOP_WINDOW));

    /**
     * The drain's deadline calls `process.exit`, which runs no finalizer, and an
     * orphan would hold a credential and go on dialing nobody.
     */
    const orphanGuard = (): void => {
      child?.kill("SIGKILL");
    };

    const start = Effect.gen(function* () {
      const spawned = Bun.spawn([...options.command], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
        // The controller's home is not always the default one. Never the token:
        // everything this child starts would inherit it.
        env: { ...process.env, HYDRA_HOME: home },
      });
      child = spawned;

      const line = yield* Effect.raceFirst(
        Effect.promise(() => announcement(spawned.stdout)),
        Effect.as(Effect.sleep(options.handshakeDeadline), undefined),
      );
      // A child that said nothing died, or is wedged saying nothing; killing it
      // makes the two one death the supervisor answers. The boot goes on either
      // way, rather than holding the whole API hostage to a runner.
      if (line === undefined) {
        spawned.kill("SIGKILL");
        yield* Effect.logWarning("The local runner started without saying who it is.");
        return spawned;
      }
      const said = yield* Effect.mapError(
        Effect.flatMap(
          Effect.try({ try: () => JSON.parse(line) as unknown, catch: () => undefined }),
          decodeAnnouncement,
        ),
        () =>
          new LocalRunnerFailed({
            message: `the local runner opened with ${JSON.stringify(line)}, which is not something this build understands`,
          }),
      );

      // A write to a child that has gone is that child's death, not a failure here.
      const answer = (enrolment?: string): Effect.Effect<void> =>
        Effect.ignore(
          Effect.tryPromise(async () => {
            if (enrolment !== undefined) await spawned.stdin.write(enrolment);
            await spawned.stdin.end();
          }),
        );

      if ("runnerId" in said) {
        announced = said.runnerId;
        // A pipe left open is a child that goes on waiting for an enrolment.
        yield* answer();
        return spawned;
      }
      // The token is good for one enlistment and for an hour, and this child is
      // the only thing that ever sees it.
      const invitation = yield* joinTokens.create(yield* nowIso);
      yield* answer(
        `${JSON.stringify(encodeEnrolment({ controllerUrl, token: invitation.token }))}\n`,
      );
      return spawned;
    });

    const died = Effect.gen(function* () {
      const count = loop.record(yield* Clock.currentTimeMillis);
      if (count === undefined) return;
      yield* audit.append({
        kind: "runner.crashLooping",
        actor: SYSTEM_ACTOR,
        payload: { runnerId: announced, count },
      });
      yield* Option.match(alerts, {
        onNone: () =>
          Effect.logWarning(
            `The local runner has stopped ${String(count)} times in ${String(Duration.toMinutes(CRASH_LOOP_WINDOW))} minutes and is being started again.`,
          ),
        onSome: (listener) => listener.crashLooping(announced, count),
      });
    });

    const supervise = (first: Bun.Subprocess) =>
      Effect.gen(function* () {
        const cap = Duration.toMillis(options.backoff.cap);
        let wait = Duration.toMillis(options.backoff.first);
        let held = first;
        while (true) {
          const code = yield* Effect.promise(() => held.exited);
          if (stopping) return;
          yield* Effect.logWarning(
            `The local runner exited with ${String(code)}; starting it again.`,
          );
          yield* died.pipe(
            Effect.tapCause((cause) =>
              Effect.logWarning("The local runner's crash could not be recorded.", cause),
            ),
            Effect.ignore,
          );
          yield* Effect.sleep(Duration.millis(wait));
          wait = Math.min(wait * 2, cap);
          if (stopping) return;
          held = yield* Effect.catchCause(start, (cause) =>
            Effect.gen(function* () {
              // No more use than one that exited, and the boot is long past being
              // able to hear about it.
              yield* Effect.logWarning("The local runner could not be started.", cause);
              child?.kill("SIGKILL");
              // Nothing new to wait on, so the loop waits the dead one out again.
              return held;
            }),
          );
        }
      });

    /**
     * Cached, so the drain and the scope that closes behind it are one stop: the
     * second caller waits the first out rather than walking past a child still
     * inside its grace period.
     */
    const stop = yield* Effect.cached(
      Effect.gen(function* () {
        stopping = true;
        if (supervisor !== undefined) yield* Fiber.interrupt(supervisor);
        const leaving = child;
        if (leaving === undefined) return;
        leaving.kill("SIGTERM");
        const gone = Effect.promise(() => leaving.exited);
        const ended = yield* Effect.raceFirst(
          Effect.as(gone, true),
          Effect.as(Effect.sleep(options.stopDeadline), false),
        );
        if (ended) return;
        yield* Effect.logWarning("The local runner is still running; stopping it anyway.");
        leaving.kill("SIGKILL");
        yield* gone;
      }),
    );

    // Registered before anything is spawned, because a handshake that fails is
    // one of the ways a child comes to exist without a supervisor: however this
    // controller ends - the drain, a failure further in, a test that finished -
    // the child goes with it.
    process.on("exit", orphanGuard);
    yield* Effect.addFinalizer(() =>
      Effect.andThen(
        stop,
        Effect.sync(() => {
          process.off("exit", orphanGuard);
        }),
      ),
    );

    supervisor = yield* Effect.forkChild(supervise(yield* start));

    return { runnerId: () => announced, stop };
  });
