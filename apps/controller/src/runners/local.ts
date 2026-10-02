/**
 * The local runner: a runner the controller starts as a child process, so
 * every Hercule has a fleet of at least one runner without anybody joining a
 * machine by hand.
 *
 * The child is a fleet member like any other: nothing records that it is
 * local, and this module knows only what it printed on stdout. Its join token
 * is sent on stdin, the one channel that neither shows in `ps` nor is inherited
 * by the processes the child starts.
 *
 * `controller.read` returns the local runner's id through `LocalRunnerId`,
 * which reads it from the running child on every call rather than from a
 * stored copy.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { locateCompiledBinary, type LogLevel } from "@hercule/home";
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

/**
 * Builds the spawn command. When Hercule is not compiled, the executable is Bun
 * rather than Hercule, so the entry script must be passed too. Without this,
 * `hercule serve` from a checkout has no local runner.
 */
const buildSpawnCommand = (): ReadonlyArray<string> =>
  locateCompiledBinary() === undefined
    ? [process.execPath, Bun.main, "runner", "--local"]
    : LOCAL_RUNNER_COMMAND;

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
  /**
   * Returns the local runner's id, or `undefined` until the child has
   * reported it. It is kept only here: no column says which runner is local.
   */
  readonly runnerId: () => string | undefined;
  /** Stops the local runner. Calling it twice has the same effect as once. */
  readonly stop: Effect.Effect<void>;
}

/**
 * Where a service reads the local runner's id. Its `read` returns the id the
 * running child reported, or `undefined` when the child has not reported one
 * yet or when this controller starts no local runner.
 *
 * It has no default, so a service that reads it cannot be built without
 * someone deciding where the id comes from. The boot provides it next to the
 * local runner it starts, and a test provides its own.
 */
export class LocalRunnerId extends Context.Service<
  LocalRunnerId,
  { readonly read: () => string | undefined }
>()("hercule/controller/runners/LocalRunnerId") {}

/**
 * Parses one announcement line, and returns `None` when the line is not JSON
 * or is not an announcement this build can read.
 */
const parseAnnouncement = Schema.decodeUnknownOption(Schema.fromJsonString(LocalAnnouncement));
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

/** The first line of the child's stdout, and the announcement it parses to. */
export interface FirstLine {
  readonly line: string;
  /** `None` when the line is not an announcement this build can read. */
  readonly announcement: Option.Option<LocalAnnouncement>;
}

/** The announcement lines at the start of the child's stdout. */
export interface ChildAnnouncements {
  /** Completes with the first line, or with `undefined` if the output ends first. */
  readonly first: Deferred.Deferred<FirstLine | undefined>;
  /**
   * Completes with the runner id from the second line, which the child writes
   * only after a first line that asked to join. Completes with `undefined`
   * when the first line was anything else, when the second line is not an
   * announcement this build can read, or when the output ends first, as it
   * does when the join fails.
   */
  readonly joinedRunnerId: Deferred.Deferred<string | undefined>;
}

/** Creates the announcements of one child, neither of them completed yet. */
export const makeChildAnnouncements: Effect.Effect<ChildAnnouncements> = Effect.all({
  first: Deferred.make<FirstLine | undefined>(),
  joinedRunnerId: Deferred.make<string | undefined>(),
});

/**
 * Reads the child's stdout to its end, completes `announcements` from its
 * first lines, and passes everything after them to `forward`. It never fails:
 * a read that fails is logged, and ends the reading.
 *
 * The pipe is read to the end either way, because a child whose stdout buffer
 * fills up would block on its next log line. However the reading ends (the
 * output ends, a read fails, or the fiber is interrupted), each announcement
 * that has not completed yet completes with `undefined`, so nothing waits on
 * a child that will never write it.
 */
export const readChildOutput = (
  stdout: ReadableStream<Uint8Array>,
  announcements: ChildAnnouncements,
  forward: (text: string) => void,
): Effect.Effect<void> => {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  /** Reads the next chunk, or returns `undefined` when the output has ended. */
  const readChunk = Effect.map(
    Effect.tryPromise(() => reader.read()),
    (chunk) => (chunk.done ? undefined : decoder.decode(chunk.value, { stream: true })),
  );

  /** Returns the next whole line, or `undefined` when the output ends first. */
  const readLine = Effect.gen(function* () {
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        return line;
      }
      const text = yield* readChunk;
      if (text === undefined) return undefined;
      buffered += text;
    }
  });

  const forwardRest = Effect.gen(function* () {
    let text: string | undefined = buffered;
    while (text !== undefined) {
      if (text !== "") forward(text);
      text = yield* readChunk;
    }
  });

  const readAll = Effect.gen(function* () {
    const line = yield* readLine;
    if (line === undefined) return;
    const announcement = parseAnnouncement(line);
    yield* Deferred.succeed(announcements.first, { line, announcement });
    if (Option.isSome(announcement) && "join" in announcement.value) {
      const second = yield* readLine;
      if (second === undefined) return;
      const joined = parseAnnouncement(second);
      yield* Deferred.succeed(
        announcements.joinedRunnerId,
        Option.isSome(joined) && "runnerId" in joined.value ? joined.value.runnerId : undefined,
      );
    }
    yield* forwardRest;
  });

  return readAll.pipe(
    // A broken pipe means the child is gone. Completing the announcements
    // here, rather than waiting for the handshake deadline, keeps the boot
    // from being held up for half a minute.
    Effect.catch((error) =>
      Effect.logWarning(`The local runner's output ended: ${String(error.cause)}`),
    ),
    Effect.ensuring(
      Effect.andThen(
        Effect.all([
          // Completing a Deferred that has already completed does nothing.
          Deferred.succeed(announcements.first, undefined),
          Deferred.succeed(announcements.joinedRunnerId, undefined),
        ]),
        // Releases the pipe when the reading was interrupted during a read.
        Effect.ignore(Effect.tryPromise(() => reader.cancel())),
      ),
    ),
  );
};

/**
 * Starts the local runner and supervises it, restarting it when it exits.
 * Fails with `LocalRunnerFailed` when the first child's announcement cannot be
 * read. The first child is started here, so a failed handshake stops the boot
 * rather than leaving the controller next to a child it cannot understand.
 *
 * The child runs with the controller's Hercule Home and log level, so that
 * `-c log.level=debug` on `hercule serve` reaches the local runner's log too.
 */
export const startLocalRunner = (
  options: LocalRunnerOptions,
  inherited: {
    readonly controllerUrl: string;
    readonly home: string;
    readonly logLevel: LogLevel;
  },
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

    // The readers of every child's stdout run in their own scope rather than
    // as children of the supervisor, so stopping the supervisor does not cut
    // off the output of a child that is still shutting down. The scope is made
    // before the stop is registered, so it closes after the stop.
    const readers = yield* Scope.fork(yield* Effect.scope);

    /**
     * Kills the child when the process exits. The drain's deadline calls
     * `process.exit`, which runs no finalizer, and an orphaned child would keep
     * its credential and keep trying to connect to a controller that is gone.
     */
    const killOrphan = (): void => {
      child?.kill("SIGKILL");
    };

    const start = Effect.gen(function* () {
      const spawned = Bun.spawn([...options.command, "-c", `log.level=${inherited.logLevel}`], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
        // The controller's home is not always the default one. The token is
        // never put in the environment: every process the child starts would
        // inherit it.
        env: { ...process.env, HERCULE_HOME: inherited.home },
      });
      child = spawned;

      const announcements = yield* makeChildAnnouncements;
      yield* Effect.forkIn(
        readChildOutput(spawned.stdout, announcements, (text) => process.stdout.write(text)),
        readers,
      );
      const first = yield* Effect.raceFirst(
        Deferred.await(announcements.first),
        Effect.as(Effect.sleep(options.handshakeDeadline), undefined),
      );
      // A child that printed nothing either died or is stuck. Killing it turns
      // both cases into one exit, which the supervisor handles. The boot goes
      // on either way, rather than making the whole API wait for a runner.
      if (first === undefined) {
        spawned.kill("SIGKILL");
        yield* Effect.logWarning("The local runner started but did not print its announcement.");
        return spawned;
      }
      if (Option.isNone(first.announcement)) {
        return yield* Effect.fail(
          new LocalRunnerFailed({
            message: `the local runner's first line was ${JSON.stringify(first.line)}, which this build cannot read`,
          }),
        );
      }
      const announcement = first.announcement.value;

      // A failed write means the child has exited, which the supervisor handles; it is not a failure here.
      const writeEnrolment = (enrolment?: string): Effect.Effect<void> =>
        Effect.ignore(
          Effect.tryPromise(async () => {
            if (enrolment !== undefined) await spawned.stdin.write(enrolment);
            await spawned.stdin.end();
          }),
        );

      if ("runnerId" in announcement) {
        announced = announcement.runnerId;
        // Close the pipe, or the child keeps waiting for an enrolment.
        yield* writeEnrolment();
        return spawned;
      }
      // The token is valid for one join and for an hour, and only this child
      // ever sees it.
      const invitation = yield* joinTokens.create(yield* nowIso);
      yield* writeEnrolment(
        `${JSON.stringify(encodeEnrolment({ controllerUrl: inherited.controllerUrl, token: invitation.token }))}\n`,
      );
      // The child joins through this controller's API, which does not listen
      // until the boot is over, so the id the join gives the child is read in
      // the background rather than waited for here. A second line this build
      // cannot read leaves the id unknown until the child's next start.
      yield* Effect.forkIn(
        Effect.flatMap(Deferred.await(announcements.joinedRunnerId), (runnerId) =>
          Effect.sync(() => {
            if (runnerId !== undefined) announced = runnerId;
          }),
        ),
        readers,
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
