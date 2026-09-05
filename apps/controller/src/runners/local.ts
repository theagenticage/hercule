/**
 * The runner the controller runs beside itself, and keeps running.
 *
 * Every Hydra is a fleet of at least one: the machine the controller is on can
 * host sessions, and it should be able to without anybody enlisting it by hand.
 * So the boot spawns one child - the same binary, told to be a runner - and
 * holds it for as long as the controller is up.
 *
 * The child is a fleet member like any other. Nothing records that it is local,
 * no column marks it and no setting names it: it joins over loopback with a
 * single-use token, holds an ordinary socket, and the only thing this module
 * knows about it is what it said on its stdout when it started. The token
 * travels on stdin because that is the one channel that is neither in `ps` nor
 * inherited by everything the child starts.
 *
 * What supervision means here is narrow. A child that exits was not asked to,
 * so it is started again, waiting longer each time; a child that keeps dying is
 * written down once per window and announced through a seam, because a machine
 * whose runner cannot stay up is something an operator has to hear about. A
 * child that was asked to stop is neither.
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
 * What the controller spawns. Spawn, never fork: a forked Hydra would share
 * this process's database handle and its signal handlers, and `process.execPath`
 * is how a compiled binary starts another copy of itself.
 */
export const LOCAL_RUNNER_COMMAND: ReadonlyArray<string> = [process.execPath, "runner", "--local"];

/** Bun's own marker for an entry script that lives inside a compiled binary. */
const EMBEDDED = "/$bunfs/";

/**
 * The same command, for a Hydra that has not been compiled yet: the executable
 * is then Bun rather than Hydra, and Bun has to be told which script to run.
 * Without this, `hydra serve` from a checkout has no local runner at all.
 */
const spawnCommand = (): ReadonlyArray<string> =>
  Bun.main.startsWith(EMBEDDED)
    ? LOCAL_RUNNER_COMMAND
    : [process.execPath, Bun.main, "runner", "--local"];

/** How long the controller waits before starting a child that died again. */
export const LOCAL_RUNNER_BACKOFF = {
  first: Duration.seconds(1),
  cap: Duration.seconds(30),
} as const;

/**
 * How long a child that was asked to stop is given before it is killed. The
 * same ten seconds the listener's own drain takes, because they are the same
 * shutdown.
 */
export const LOCAL_RUNNER_STOP_DEADLINE: Duration.Duration = Duration.seconds(10);

/**
 * How long the child has to say who it is. Long enough for a cold start on a
 * loaded machine, short enough that a wedged child is not what the boot is
 * waiting on: nothing binds until the handshake is over.
 */
const HANDSHAKE_DEADLINE: Duration.Duration = Duration.seconds(30);

/** How many deaths inside the window make a loop rather than a bad afternoon. */
export const CRASH_LOOP_LIMIT = 3;

/** The window those deaths have to fall inside. */
export const CRASH_LOOP_WINDOW: Duration.Duration = Duration.minutes(5);

/** What the supervisor needs to know. */
export interface LocalRunnerOptions {
  /**
   * The command to spawn. Injected because the shipped one is the binary this
   * process is, which under a test runner is the test runner: a supervisor that
   * could not be handed another child could not be tested at all.
   */
  readonly command: ReadonlyArray<string>;
  readonly backoff: { readonly first: Duration.Duration; readonly cap: Duration.Duration };
  readonly stopDeadline: Duration.Duration;
  /** How long the child has to say who it is. The shipped value unless a test says otherwise. */
  readonly handshakeDeadline?: Duration.Duration;
}

/** The shipped supervision, which everything but a test wants. */
export const LOCAL_RUNNER: LocalRunnerOptions = {
  command: spawnCommand(),
  backoff: LOCAL_RUNNER_BACKOFF,
  stopDeadline: LOCAL_RUNNER_STOP_DEADLINE,
};

/**
 * Whoever should hear that a machine's runner cannot stay up.
 *
 * Optional, and resolved with `Effect.serviceOption` as `AfterCommit` is: a
 * controller that provides none logs instead. The durable record is the audit
 * row, which is written either way; this is the part that reaches a person, and
 * what reaching a person means belongs to notifications.
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

/** The controller cannot supervise a child it does not understand. */
export class LocalRunnerFailed extends Schema.TaggedError<LocalRunnerFailed>()(
  "LocalRunnerFailed",
  { message: Schema.String },
) {}

/** The local runner, for as long as this controller holds it. */
export interface LocalRunner {
  /**
   * Which runner the child says it is, once it has joined and said so. Held
   * here and nowhere else: a controller and its runner are one machine, and the
   * fleet has no idea which of its members that is.
   */
  readonly runnerId: () => string | undefined;
  /** Asks the child to stop, and waits for it. Saying it twice changes nothing. */
  readonly stop: Effect.Effect<void>;
}

const decodeAnnouncement = Schema.decodeUnknownEffect(LocalAnnouncement);
const encodeEnrolment = Schema.encodeUnknownSync(LocalEnrolment);

/**
 * Counts deaths against a window, and says when they add up to a loop.
 *
 * Its own function because the window is the whole idea, and a supervisor
 * driven by the wall clock cannot be asked to skip five minutes: this can be
 * handed any times at all.
 */
export const crashCounter = (
  limit: number,
  windowMs: number,
): { readonly record: (at: number) => number | undefined } => {
  const deaths: Array<number> = [];
  let reportedAt: number | undefined;
  return {
    /** How many deaths to report, or nothing while there is nothing to say. */
    record: (at: number): number | undefined => {
      deaths.push(at);
      while (deaths[0] !== undefined && at - deaths[0] > windowMs) deaths.shift();
      if (deaths.length < limit) return undefined;
      // A child that goes on dying is one story rather than one per death, and
      // a window that has passed since the last telling is a new story.
      if (reportedAt !== undefined && at - reportedAt <= windowMs) return undefined;
      reportedAt = at;
      return deaths.length;
    },
  };
};

/**
 * The child's first line, and everything after it passed through to the
 * controller's own stdout.
 *
 * The pipe has to be read whether or not anything is listening for a line on
 * it: a child whose stdout filled up would block on its next log line and never
 * be heard from again.
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
      // A pipe that broke mid-read is a child that is gone. Waiting out the
      // handshake deadline for it would hold the boot for half a minute.
      process.stderr.write(`hydra: the local runner's output ended: ${String(cause)}\n`);
    }
    if (!heard) said(undefined);
  })();
  return first;
};

/**
 * Spawns the local runner and holds it up.
 *
 * The first child is started here, so a handshake that cannot be completed
 * stops the boot rather than leaving a controller running beside a child
 * nothing understands. Every child after it is the supervisor's, and a failure
 * there is a crash like any other.
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
     * The last resort. The drain's own deadline calls `process.exit`, which
     * runs no finalizer, and a runner that outlived its controller would hold a
     * credential and go on dialing an address nobody answers on.
     */
    const orphanGuard = (): void => {
      child?.kill("SIGKILL");
    };

    /** Spawns one child and answers whatever it says it is. */
    const start = Effect.gen(function* () {
      const spawned = Bun.spawn([...options.command], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
        // The home, because the child resolves its own and the controller's is
        // not always the default one. Never the token: everything this child
        // starts would inherit it.
        env: { ...process.env, HYDRA_HOME: home },
      });
      child = spawned;

      const line = yield* Effect.raceFirst(
        Effect.promise(() => announcement(spawned.stdout)),
        Effect.as(Effect.sleep(options.handshakeDeadline ?? HANDSHAKE_DEADLINE), undefined),
      );
      // A child that said nothing died, or is wedged saying nothing. Killing it
      // makes the two the same thing - a death the supervisor answers - and the
      // controller goes on booting either way: one that refused to start over a
      // runner would hold its whole API hostage to a file it may not even read.
      if (line === undefined) {
        spawned.kill("SIGKILL");
        return yield* Effect.logWarning("The local runner started without saying who it is.");
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

      // Whatever is written to a child that has already gone is written to a
      // broken pipe, which is that child's death and not this one's failure.
      const answer = (enrolment?: string): Effect.Effect<void> =>
        Effect.ignore(
          Effect.tryPromise(async () => {
            if (enrolment !== undefined) await spawned.stdin.write(enrolment);
            await spawned.stdin.end();
          }),
        );

      if ("runnerId" in said) {
        announced = said.runnerId;
        // Nothing to hand a child that already knows who it is, and a pipe left
        // open is a child that goes on waiting for one.
        return yield* answer();
      }
      // A machine that has never joined, which on the first boot of an empty
      // home is every machine. The token is good for one enlistment and for an
      // hour, and the child is the only thing that ever sees it.
      const invitation = yield* joinTokens.create(yield* nowIso);
      yield* answer(
        `${JSON.stringify(encodeEnrolment({ controllerUrl, token: invitation.token }))}\n`,
      );
    });

    /** Records a death, and says so when enough of them fall together. */
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

    /** Starts the child again for as long as nobody asked it to stop. */
    const supervise = Effect.gen(function* () {
      const cap = Duration.toMillis(options.backoff.cap);
      let wait = Duration.toMillis(options.backoff.first);
      while (true) {
        const held = child;
        // Only if the first spawn never got as far as one, which is a machine
        // that cannot start a process at all.
        if (held === undefined) return;
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
        yield* Effect.catchCause(start, (cause) =>
          Effect.gen(function* () {
            // A child that will not complete the handshake is no more use than
            // one that exited, and it is the loop's next death rather than
            // anything the boot can still be told about.
            yield* Effect.logWarning("The local runner could not be started.", cause);
            child?.kill("SIGKILL");
          }),
        );
      }
    });

    /**
     * Asks the child to stop, waits for it, and kills it if it will not go.
     *
     * Cached, so the drain and the scope that closes behind it are one stop:
     * the second caller waits out the first rather than walking past a child
     * still in its grace period.
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

    yield* start;
    supervisor = yield* Effect.forkChild(supervise);

    return { runnerId: () => announced, stop };
  });
