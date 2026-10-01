/**
 * The Supervisor on macOS: a launchd LaunchAgent in the user's GUI domain,
 * `gui/<uid>`, labelled `sh.hercule.service` (spec 15 section 4).
 *
 * A LaunchAgent, not a system daemon, because the controller reads the master
 * key from the user's login keychain, which a system daemon cannot reach.
 *
 * The mechanics are the ones the edge `install.sh` used before this package
 * existed: `launchctl bootstrap` loads
 * the plist, `launchctl kickstart -k` restarts the job launchd already holds,
 * and a changed plist needs `launchctl bootout` first, because launchd reads
 * the plist only when it loads the job.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import {
  ServiceError,
  Supervisor,
  createLogFiles,
  createNotInstalledError,
  deleteUnitFile,
  describeLogLocation,
  refuseOtherHome,
  runOrFail,
  waitForStablePid,
  waitUntilUnloaded,
  writeUnitFile,
  type RunCommand,
  type ServiceStatus,
} from "./supervisor";
import { LAUNCHD_LABEL, renderLaunchdPlist, type ServiceRole, type ServiceUnit } from "./unit";

/** What the launchd Supervisor needs from the machine; tests pass fakes. */
export interface LaunchdDependencies {
  readonly run: RunCommand;
  /** The folder of the user's LaunchAgents: `~/Library/LaunchAgents`. */
  readonly unitDir: string;
  readonly uid: number;
  /** The user's name for messages, or `undefined` when it is unknown. */
  readonly userName: string | undefined;
}

/** The parts of an installed plist this module reads, as `plutil -convert json` prints them. */
const InstalledPlist = Schema.fromJsonString(
  Schema.Struct({
    ProgramArguments: Schema.optional(Schema.Array(Schema.String)),
    EnvironmentVariables: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
);

/** What launchd holds for the label: whether the job is loaded, and its pid while it runs. */
interface LaunchdJob {
  readonly loaded: boolean;
  readonly pid: number | null;
}

/**
 * Reads the pid from the output of `launchctl print`, which has a line
 * `pid = <n>` while the job runs. Returns `null` when there is none.
 */
export const parseLaunchdPid = (printed: string): number | null => {
  const match = /^\s*pid = (\d+)\s*$/m.exec(printed);
  return match === null ? null : Number(match[1]);
};

/** Creates the launchd Supervisor. */
export const createLaunchdSupervisor = (
  dependencies: LaunchdDependencies,
): Supervisor["Service"] => {
  const { run } = dependencies;
  const unitFile = join(dependencies.unitDir, `${LAUNCHD_LABEL}.plist`);
  const domain = `gui/${dependencies.uid}`;
  const target = `${domain}/${LAUNCHD_LABEL}`;

  const readJob: Effect.Effect<LaunchdJob> = Effect.map(
    run(["launchctl", "print", target]),
    (result) =>
      result.exitCode === 0
        ? { loaded: true, pid: parseLaunchdPid(result.stdout) }
        : { loaded: false, pid: null },
  );
  const readPid = Effect.map(readJob, (job) => job.pid);
  const isLoaded = Effect.map(readJob, (job) => job.loaded);

  /**
   * Reads the role and the Hercule Home the installed plist runs, or returns
   * `undefined` when there is no plist. A plist an older edge `install.sh`
   * wrote reads the same way: it runs `[<binary>, "serve"]` with
   * `HERCULE_HOME` set.
   */
  const readInstalledUnit = Effect.gen(function* () {
    if (!existsSync(unitFile)) return undefined;
    const unreadable = new ServiceError({
      message: `${unitFile} is not a plist Hercule can read. Delete it and run \`hercule service install\`.`,
    });
    const converted = yield* run(["plutil", "-convert", "json", "-o", "-", unitFile]);
    if (converted.exitCode !== 0) return yield* unreadable;
    const plist = yield* Schema.decodeUnknownEffect(InstalledPlist)(converted.stdout).pipe(
      Effect.mapError(() => unreadable),
    );
    const word = plist.ProgramArguments?.[1];
    const role: ServiceRole | null = word === "serve" || word === "runner" ? word : null;
    return { role, home: plist.EnvironmentVariables?.["HERCULE_HOME"] ?? null };
  });

  const readStatus: Effect.Effect<ServiceStatus, ServiceError> = Effect.gen(function* () {
    const installed = yield* readInstalledUnit;
    const job = yield* readJob;
    return {
      installed: installed !== undefined,
      running: job.pid !== null,
      pid: job.pid,
      role: installed?.role ?? null,
      home: installed?.home ?? null,
      unitFile,
    };
  });

  /** Reads the installed unit, or fails when there is none. */
  const requireInstalledUnit = Effect.flatMap(readInstalledUnit, (installed) =>
    installed === undefined ? Effect.fail(createNotInstalledError()) : Effect.succeed(installed),
  );

  /**
   * Unloads the job and waits until launchd no longer holds it. A failing
   * `bootout` is not an error on its own: the job may have gone away in the
   * meantime, and the wait is what checks the outcome.
   */
  const unload = (nextStep: string) =>
    Effect.andThen(
      run(["launchctl", "bootout", target]),
      waitUntilUnloaded(isLoaded, "launchd did not stop the Hercule service", nextStep),
    );

  const load = runOrFail(
    run,
    ["launchctl", "bootstrap", domain, unitFile],
    "launchd did not load the Hercule service",
  );

  /** Waits for a started process, pointing at the logs of the installed unit's role. */
  const waitForStart = (
    installed: { readonly role: ServiceRole | null; readonly home: string | null },
    previousPid: number | null,
  ) =>
    waitForStablePid({
      readPid,
      previousPid,
      nextStep: describeLogLocation(installed, unitFile),
    });

  const install = (unit: ServiceUnit): Effect.Effect<ServiceStatus, ServiceError> =>
    Effect.gen(function* () {
      const session = yield* run(["launchctl", "print", domain]);
      if (session.exitCode !== 0) {
        return yield* new ServiceError({
          message: `${dependencies.userName ?? "This user"} is not logged in to this Mac's desktop, so launchd has nowhere to run Hercule. Run this in Terminal on the Mac itself.`,
        });
      }
      const installed = yield* readInstalledUnit;
      yield* refuseOtherHome(installed?.home ?? null, unit);
      yield* createLogFiles(unit);

      const text = renderLaunchdPlist(unit);
      const job = yield* readJob;
      const unchanged = yield* Effect.try({
        try: () => existsSync(unitFile) && readFileSync(unitFile, "utf8") === text,
        catch: () =>
          new ServiceError({ message: `Could not read ${unitFile}. Check that you own it.` }),
      });
      if (job.loaded && unchanged) {
        yield* runOrFail(
          run,
          ["launchctl", "kickstart", "-k", target],
          "launchd did not restart the Hercule service",
        );
      } else {
        if (job.loaded) yield* unload(describeLogLocation(unit, unitFile));
        yield* writeUnitFile(unitFile, text);
        yield* load;
      }
      yield* waitForStart(unit, job.pid);
      return yield* readStatus;
    });

  const uninstall = Effect.gen(function* () {
    if (yield* isLoaded) yield* unload("Run `hercule service uninstall` again.");
    yield* deleteUnitFile(unitFile);
    return yield* readStatus;
  });

  const start = Effect.gen(function* () {
    const installed = yield* requireInstalledUnit;
    const job = yield* readJob;
    if (job.pid !== null) return yield* readStatus;
    if (job.loaded) {
      yield* runOrFail(
        run,
        ["launchctl", "kickstart", target],
        "launchd did not start the Hercule service",
      );
    } else {
      yield* load;
    }
    yield* waitForStart(installed, null);
    return yield* readStatus;
  });

  // `bootout` rather than `kill`: launchd would restart a killed job, because
  // the unit keeps it alive. The plist stays, so the job loads again at the
  // next login, the way `systemctl --user stop` leaves an enabled unit.
  const stop = Effect.gen(function* () {
    yield* requireInstalledUnit;
    if (yield* isLoaded) yield* unload("Run `hercule service stop` again.");
    return yield* readStatus;
  });

  const restart = Effect.gen(function* () {
    const installed = yield* requireInstalledUnit;
    const job = yield* readJob;
    if (job.loaded) {
      yield* runOrFail(
        run,
        ["launchctl", "kickstart", "-k", target],
        "launchd did not restart the Hercule service",
      );
    } else {
      yield* load;
    }
    yield* waitForStart(installed, job.pid);
    return yield* readStatus;
  });

  return Supervisor.of({
    uninstallNote: undefined,
    install,
    uninstall,
    start,
    stop,
    restart,
    readStatus,
  });
};
