/**
 * The local runner: a runner the controller starts as a child process, so
 * every Hercule has a fleet of at least one runner without anybody joining a
 * machine by hand.
 *
 * The child is a fleet member like any other: nothing records that it is
 * local, and this module knows only what it printed on stdout. Its join token
 * is sent on stdin, the one channel that neither shows in `ps` nor is inherited
 * by the processes the child starts.
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
import { LocalAnnouncement, LocalEnrolment } from "@hercule/protocol";
import { SYSTEM_ACTOR } from "../actor";
import { nowIso } from "../db";
import { AuditLog } from "../events";
import { JoinTokens } from "./join-tokens";

/**
 * The command that starts the local runner. It is spawned, never forked: a
 * forked Hercule would share this process's database handle and signal
 * handlers.
 */
export const LOCAL_RUNNER_COMMAND: ReadonlyArray<string> = [process.execPath, "runner", "--local"];

/** The path prefix Bun uses for an entry script inside a compiled binary. */
const EMBEDDED = "/$bunfs/";

/**
 * Builds the spawn command. When Hercule is not compiled, the executable is Bun
 * rather than Hercule, so the entry script must be passed too. Without this,
 * `hercule serve` from a checkout has no local runner.
 */
const buildSpawnCommand = (): ReadonlyArray<string> =>
  Bun.main.startsWith(EMBEDDED)
    ? LOCAL_RUNNER_COMMAND
    : [process.execPath, Bun.main, "runner", "--local"];

export const LOCAL_RUNNER_BACKOFF = {
  first: Duration.seconds(1),
  cap: Duration.seconds(30),
} as const;

/** How long a stop waits for the child. The server's drain also takes ten seconds, because it is the same shutdown. */
export const LOCAL_RUNNER_STOP_DEADLINE: Duration.Duration = Duration.seconds(10);

/**
 * How long the boot waits for the child's first line. Long enough for a cold
 * start on a busy machine, short enough that a stuck child does not hold up the
 * boot: the server does not listen until the handshake is over.
 */
const HANDSHAKE_DEADLINE: Duration.Duration = Duration.seconds(30);

/** How many exits within `CRASH_LOOP_WINDOW` count as a crash loop rather than bad luck. */
export const CRASH_LOOP_LIMIT = 3;

export const CRASH_LOOP_WINDOW: Duration.Duration = Duration.minutes(5);

export interface LocalRunnerOptions {
  /** Passed in, because the default command runs this binary, which under a test is the test runner. */
  readonly command: ReadonlyArray<string>;
  readonly backoff: { readonly first: Duration.Duration; readonly cap: Duration.Duration };
  readonly stopDeadline: Duration.Duration;
  readonly handshakeDeadline: Duration.Duration;
}

export const LOCAL_RUNNER: LocalRunnerOptions = {
  command: buildSpawnCommand(),
  backoff: LOCAL_RUNNER_BACKOFF,
  stopDeadline: LOCAL_RUNNER_STOP_DEADLINE,
  handshakeDeadline: HANDSHAKE_DEADLINE,
};

/**
 * An optional listener for crash-loop alerts. Without one, the controller logs
 * a warning instead; the audit entry is written either way. Notifying a person
 * is the notifications domain's job.
 */
export interface RunnerAlertListener {
  readonly crashLooping: (
    runnerId: string | undefined,
    count: number,
  ) => Effect.Effect<void, never, never>;
}

export class RunnerAlerts extends Context.Service<RunnerAlerts, RunnerAlertListener>()(
  "hercule/controller/runners/RunnerAlerts",
) {}

export class LocalRunnerFailed extends Schema.TaggedError<LocalRunnerFailed>()(
  "LocalRunnerFailed",
  { message: Schema.String },
) {}

export interface LocalRunner {
  /** Returns the local runner's id. It is kept only here: no column says which runner is local. */
  readonly runnerId: () => string | undefined;
  /** Stops the local runner. Calling it twice has the same effect as once. */
  readonly stop: Effect.Effect<void>;
}

const decodeAnnouncement = Schema.decodeUnknownEffect(LocalAnnouncement);
const encodeEnrolment = Schema.encodeUnknownSync(LocalEnrolment);

/**
 * Creates a counter of child exits. `record` returns the number of exits in
 * the window once it reaches `limit`, at most once per window, and `undefined`
 * otherwise. It is a separate function so tests can pass their own times,
 * because a supervisor on the real clock cannot skip five minutes.
 */
export const createCrashCounter = (
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
      // Report once per window, not once per exit; after the window passes, a new report is allowed.
      if (reportedAt !== undefined && at - reportedAt <= windowMs) return undefined;
      reportedAt = at;
      return deaths.length;
    },
  };
};

/**
 * Returns the child's first stdout line, or `undefined` if the output ends
 * first. The rest of the output is copied to this process's stdout. The pipe
 * is read to the end either way, because a child whose stdout buffer fills up
 * would block on its next log line.
 */
const readAnnouncement = (stdout: ReadableStream<Uint8Array>): Promise<string | undefined> => {
  let resolveAnnouncement: (line: string | undefined) => void = () => undefined;
  const first = new Promise<string | undefined>((resolve) => {
    resolveAnnouncement = resolve;
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
        resolveAnnouncement(head.slice(0, newline));
        process.stdout.write(head.slice(newline + 1));
      }
    } catch (cause) {
      // A broken pipe means the child is gone. Waiting for the handshake
      // deadline would hold up the boot for half a minute.
      process.stderr.write(`hercule: the local runner's output ended: ${String(cause)}\n`);
    }
    if (!heard) resolveAnnouncement(undefined);
  })();
  return first;
};

/**
 * Starts the local runner and supervises it, restarting it when it exits.
 * Fails with `LocalRunnerFailed` when the first child's announcement cannot be
 * read. The first child is started here, so a failed handshake stops the boot
 * rather than leaving the controller next to a child it cannot understand.
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
    const loop = createCrashCounter(CRASH_LOOP_LIMIT, Duration.toMillis(CRASH_LOOP_WINDOW));

    /**
     * Kills the child when the process exits. The drain's deadline calls
     * `process.exit`, which runs no finalizer, and an orphaned child would keep
     * its credential and keep trying to connect to a controller that is gone.
     */
    const killOrphan = (): void => {
      child?.kill("SIGKILL");
    };

    const start = Effect.gen(function* () {
      const spawned = Bun.spawn([...options.command], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
        // The controller's home is not always the default one. The token is
        // never put in the environment: every process the child starts would
        // inherit it.
        env: { ...process.env, HERCULE_HOME: home },
      });
      child = spawned;

      const line = yield* Effect.raceFirst(
        Effect.promise(() => readAnnouncement(spawned.stdout)),
        Effect.as(Effect.sleep(options.handshakeDeadline), undefined),
      );
      // A child that printed nothing either died or is stuck. Killing it turns
      // both cases into one exit, which the supervisor handles. The boot goes
      // on either way, rather than making the whole API wait for a runner.
      if (line === undefined) {
        spawned.kill("SIGKILL");
        yield* Effect.logWarning("The local runner started but did not print its announcement.");
        return spawned;
      }
      const said = yield* Effect.mapError(
        Effect.flatMap(
          Effect.try({ try: () => JSON.parse(line) as unknown, catch: () => undefined }),
          decodeAnnouncement,
        ),
        () =>
          new LocalRunnerFailed({
            message: `the local runner's first line was ${JSON.stringify(line)}, which this build cannot read`,
          }),
      );

      // A failed write means the child has exited, which the supervisor handles; it is not a failure here.
      const writeEnrolment = (enrolment?: string): Effect.Effect<void> =>
        Effect.ignore(
          Effect.tryPromise(async () => {
            if (enrolment !== undefined) await spawned.stdin.write(enrolment);
            await spawned.stdin.end();
          }),
        );

      if ("runnerId" in said) {
        announced = said.runnerId;
        // Close the pipe, or the child keeps waiting for an enrolment.
        yield* writeEnrolment();
        return spawned;
      }
      // The token is valid for one join and for an hour, and only this child
      // ever sees it.
      const invitation = yield* joinTokens.create(yield* nowIso);
      yield* writeEnrolment(
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
              // A child that failed to start is no more useful than one that
              // exited, and the boot is long over, so it cannot be reported
              // there.
              yield* Effect.logWarning("The local runner could not be started.", cause);
              child?.kill("SIGKILL");
              // There is no new child, so the loop waits on the old one, which has already exited.
              return held;
            }),
          );
        }
      });

    /**
     * Stops the child: SIGTERM, then SIGKILL after the stop deadline. It is
     * cached, so the drain and the scope that closes after it share one stop:
     * the second caller waits for the first instead of returning while the
     * child is still in its grace period.
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

    // Registered before anything is spawned, because a failed handshake leaves
    // a child with no supervisor. However this controller ends (the drain, a
    // later failure, a finished test), the child is stopped with it.
    process.on("exit", killOrphan);
    yield* Effect.addFinalizer(() =>
      Effect.andThen(
        stop,
        Effect.sync(() => {
          process.off("exit", killOrphan);
        }),
      ),
    );

    supervisor = yield* Effect.forkChild(supervise(yield* start));

    return { runnerId: () => announced, stop };
  });
