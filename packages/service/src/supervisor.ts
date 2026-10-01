/**
 * The Supervisor: the OS service manager that keeps Hercule running, behind
 * one interface with an implementation per platform (`launchd.ts`,
 * `systemd.ts`). This module holds the interface, the status it reports, its
 * errors, and the steps both implementations share.
 */
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { Context, Duration, Effect, Schema } from "effect";
import { locateLogsDir } from "@hercule/home";
import { locateServiceLogs, type ServiceRole, type ServiceUnit } from "./unit";

/**
 * What `hercule service status` reports, and what every verb prints with
 * `--json` once it is done.
 *
 * - `installed`: a unit file exists.
 * - `running`: the supervisor reports a process for the unit, whose id is `pid`.
 * - `role` and `home`: what the installed unit runs, or `null` when no unit is
 *   installed or the unit does not name it.
 * - `unitFile`: where the unit file is, or would be, written.
 */
export interface ServiceStatus {
  readonly installed: boolean;
  readonly running: boolean;
  readonly pid: number | null;
  readonly role: ServiceRole | null;
  readonly home: string | null;
  readonly unitFile: string;
}

/**
 * A service verb failed or was refused. The message is one or two sentences:
 * what went wrong, and what to do about it.
 */
export class ServiceError extends Schema.TaggedError<ServiceError>()("ServiceError", {
  message: Schema.String,
}) {}

/** Returns the error `start`, `stop` and `restart` fail with when no unit is installed. */
export const createNotInstalledError = (): ServiceError =>
  new ServiceError({
    message: "No Hercule service is installed on this machine. Run `hercule service install`.",
  });

/** What one run of a command returned. */
export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs a command to completion. Never fails: a command that cannot start
 * returns a non-zero exit code with the reason in `stderr`. Injected, so tests
 * never run a real supervisor.
 */
export type RunCommand = (argv: ReadonlyArray<string>) => Effect.Effect<CommandResult>;

/** Runs a real command with `Bun.spawn`, with stdin closed. */
export const runCommand: RunCommand = (argv) =>
  Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode: await child.exited, stdout, stderr };
    },
    catch: (error) => (error instanceof Error ? error.message : String(error)),
  }).pipe(Effect.catch((reason) => Effect.succeed({ exitCode: 127, stdout: "", stderr: reason })));

/**
 * The OS service manager, for the one Hercule unit of this machine and user.
 *
 * Every verb returns the status after it is done. `install` and the verbs that
 * start the process return only once the process has started and still runs
 * under the same pid `STABLE_PID_DURATION` later.
 */
export class Supervisor extends Context.Service<
  Supervisor,
  {
    /**
     * A sentence `uninstall` adds to its output about what it leaves behind
     * on purpose, or `undefined` when it leaves nothing.
     */
    readonly uninstallNote: string | undefined;
    /**
     * Writes the unit, registers it and (re)starts it, so the process that
     * runs afterwards is this unit's. Fails when the installed unit runs
     * another Hercule Home, or when the supervisor cannot run a unit for this
     * user.
     */
    readonly install: (unit: ServiceUnit) => Effect.Effect<ServiceStatus, ServiceError>;
    /** Stops and removes the unit. Succeeds when there is none. Leaves the logs. */
    readonly uninstall: Effect.Effect<ServiceStatus, ServiceError>;
    /** Starts the installed unit when it is not running. */
    readonly start: Effect.Effect<ServiceStatus, ServiceError>;
    /** Stops the installed unit's process. The unit stays installed. */
    readonly stop: Effect.Effect<ServiceStatus, ServiceError>;
    /** Stops the installed unit's process, if it runs, and starts it again. */
    readonly restart: Effect.Effect<ServiceStatus, ServiceError>;
    /** Reads the status of the unit. */
    readonly readStatus: Effect.Effect<ServiceStatus, ServiceError>;
  }
>()("hercule/service/Supervisor") {}

/** How often the waits below ask the supervisor again. */
const POLL_INTERVAL = Duration.millis(500);

/**
 * How long a wait lasts, in seconds. A supervisor waits ten seconds before it
 * restarts a process that exited, and launchd may wait those ten seconds
 * before the first start too, when the previous process ran for less than ten
 * seconds.
 */
const WAIT_LIMIT_SECONDS = 30;

/** How many times a wait asks the supervisor before it gives up. */
const MAX_POLLS =
  Duration.toMillis(Duration.seconds(WAIT_LIMIT_SECONDS)) / Duration.toMillis(POLL_INTERVAL);

/** How long a new process must keep its pid to count as started. */
const STABLE_PID_DURATION = Duration.seconds(3);

/**
 * Returns the sentence of a failure message that points at the log files of
 * the installed unit. A unit edited by hand may name no Hercule Home or no
 * role, and then the unit file is where the logs are named.
 */
export const describeLogLocation = (
  installed: { readonly home: string | null; readonly role: ServiceRole | null },
  unitFile: string,
): string => {
  if (installed.home === null || installed.role === null) {
    return `See ${unitFile} for where the process writes its output.`;
  }
  const logs = locateServiceLogs(installed.home, installed.role);
  return `See ${logs.log} and ${logs.stderrLog} for the reason.`;
};

/**
 * Waits until the supervisor runs the unit under a pid other than
 * `previousPid`, and that pid is still the one `STABLE_PID_DURATION` later.
 * Fails otherwise, with a message that ends with `nextStep`.
 *
 * A process that fails at boot, for example because another controller holds
 * its port, exits at once, and the supervisor starts it again later under a
 * new pid. So a new pid alone does not prove that the process started.
 */
export const waitForStablePid = (options: {
  readonly readPid: Effect.Effect<number | null, ServiceError>;
  readonly previousPid: number | null;
  /** The sentence that ends a failure message, usually from `describeLogLocation`. */
  readonly nextStep: string;
}): Effect.Effect<number, ServiceError> =>
  Effect.gen(function* () {
    let startedPid: number | null = null;
    for (let poll = 0; startedPid === null; poll += 1) {
      const pid = yield* options.readPid;
      if (pid !== null && pid !== options.previousPid) {
        startedPid = pid;
      } else if (poll >= MAX_POLLS) {
        return yield* new ServiceError({
          message: `The Hercule service did not start within ${WAIT_LIMIT_SECONDS} seconds. ${options.nextStep}`,
        });
      } else {
        yield* Effect.sleep(POLL_INTERVAL);
      }
    }
    yield* Effect.sleep(STABLE_PID_DURATION);
    if ((yield* options.readPid) !== startedPid) {
      return yield* new ServiceError({
        message: `The Hercule service stopped right after it started. ${options.nextStep}`,
      });
    }
    return startedPid;
  });

/**
 * Waits until `isLoaded` returns false. Fails when it still returns true
 * after `WAIT_LIMIT_SECONDS`, with a message that starts with `failure`, adds
 * the limit and ends with `nextStep`.
 */
export const waitUntilUnloaded = (
  isLoaded: Effect.Effect<boolean, ServiceError>,
  failure: string,
  nextStep: string,
): Effect.Effect<void, ServiceError> =>
  Effect.gen(function* () {
    for (let poll = 0; yield* isLoaded; poll += 1) {
      if (poll >= MAX_POLLS) {
        return yield* new ServiceError({
          message: `${failure} within ${WAIT_LIMIT_SECONDS} seconds. ${nextStep}`,
        });
      }
      yield* Effect.sleep(POLL_INTERVAL);
    }
  });

/**
 * Fails when the installed unit runs a Hercule Home other than the one being
 * installed. One unit per machine: installing a second Home would silently
 * stop the first.
 *
 * Both paths are resolved before they are compared, because a plist written
 * by hand may spell the same folder with a trailing slash.
 */
export const refuseOtherHome = (
  installedHome: string | null,
  unit: ServiceUnit,
): Effect.Effect<void, ServiceError> =>
  installedHome === null || resolve(installedHome) === resolve(unit.home)
    ? Effect.void
    : Effect.fail(
        new ServiceError({
          message: `The Hercule service on this machine runs the Hercule Home ${installedHome}, and there is one unit per machine. To keep it, run this with --home ${installedHome}; to replace it, run \`hercule service uninstall\` first.`,
        }),
      );

/**
 * Creates the logs folder of the unit's Hercule Home and the unit's stderr
 * log, both readable only by the owner. A supervisor opens the stderr log
 * before it starts the process, and launchd neither creates folders nor
 * creates the file with any mode but the default, while a crash trace in it
 * may quote what the process was handling.
 */
export const createLogFiles = (unit: ServiceUnit): Effect.Effect<void, ServiceError> =>
  Effect.try({
    try: () => {
      mkdirSync(locateLogsDir(unit.home), { recursive: true, mode: 0o700 });
      // `mode` applies only when the folder is created.
      chmodSync(locateLogsDir(unit.home), 0o700);
      closeSync(openSync(unit.stderrLog, "a", 0o600));
      chmodSync(unit.stderrLog, 0o600);
    },
    catch: () =>
      new ServiceError({
        message: `Could not create ${locateLogsDir(unit.home)}. Check that you own ${unit.home}.`,
      }),
  });

/**
 * Writes a unit file to a temporary file beside it and renames it into
 * place, so a supervisor never reads half a file. The file is mode 0644:
 * launchd refuses a plist that other users can write.
 */
export const writeUnitFile = (path: string, text: string): Effect.Effect<void, ServiceError> =>
  Effect.try({
    try: () => {
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, text, { mode: 0o644 });
        renameSync(temporary, path);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
    catch: () => new ServiceError({ message: `Could not write ${path}. Check that you own it.` }),
  });

/** Deletes a unit file. Succeeds when there is none. */
export const deleteUnitFile = (path: string): Effect.Effect<void, ServiceError> =>
  Effect.try({
    try: () => rmSync(path, { force: true }),
    catch: () => new ServiceError({ message: `Could not delete ${path}. Check that you own it.` }),
  });

/**
 * Runs a supervisor command and fails with `failure` and the command's own
 * error output when it exits non-zero.
 */
export const runOrFail = (
  run: RunCommand,
  argv: ReadonlyArray<string>,
  failure: string,
): Effect.Effect<CommandResult, ServiceError> =>
  Effect.flatMap(run(argv), (result) =>
    result.exitCode === 0
      ? Effect.succeed(result)
      : Effect.fail(
          new ServiceError({
            message: `${failure}: \`${argv.join(" ")}\` exited with ${result.exitCode}${describeOutput(result)}`,
          }),
        ),
  );

/** Returns a command's error output as the end of a sentence, or a full stop when it printed none. */
const describeOutput = (result: CommandResult): string => {
  const output = (result.stderr.trim() || result.stdout.trim()).replaceAll(/\s*\n\s*/g, " ");
  return output === "" ? "." : `: ${output}`;
};
