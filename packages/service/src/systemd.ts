/**
 * The Supervisor on Linux: a systemd user unit, `hercule.service`, in the
 * user's systemd folder (spec 15 section 4).
 *
 * A user's service manager runs only while the user is logged in, unless
 * lingering is on for the user. So `install` turns lingering on first, and
 * writes nothing when it cannot: a unit that stops at logout would look
 * installed and still leave the machine without Hercule. `uninstall` leaves
 * lingering on, because other user units may depend on it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import {
  ServiceError,
  Supervisor,
  createLogFiles,
  createNotInstalledError,
  deleteUnitFile,
  pointAtLogs,
  refuseOtherHome,
  runOrFail,
  waitForStablePid,
  writeUnitFile,
  type RunCommand,
  type ServiceStatus,
} from "./supervisor";
import { SYSTEMD_UNIT_NAME, parseSystemdUnit, renderSystemdUnit, type ServiceUnit } from "./unit";

/** What the systemd Supervisor needs from the machine; tests pass fakes. */
export interface SystemdDependencies {
  readonly run: RunCommand;
  /** The user's unit folder: `${XDG_CONFIG_HOME:-~/.config}/systemd/user`. */
  readonly unitDir: string;
  /** The user's uid, which `loginctl` takes in place of a user name. */
  readonly uid: number;
  /** The user's name for messages, or `undefined` when it is unknown. */
  readonly userName: string | undefined;
}

/**
 * Reads the pid from the output of `systemctl show -p MainPID`, one `Key=value`
 * per line. Returns `null` when the unit runs no process, which systemd
 * reports as `MainPID=0`.
 */
export const parseSystemdPid = (shown: string): number | null => {
  const match = /^MainPID=(\d+)$/m.exec(shown);
  const pid = match === null ? 0 : Number(match[1]);
  return pid > 0 ? pid : null;
};

/** Creates the systemd Supervisor. */
export const createSystemdSupervisor = (
  dependencies: SystemdDependencies,
): Supervisor["Service"] => {
  const { run } = dependencies;
  // `loginctl` takes a uid wherever it takes a user name.
  const user = dependencies.userName ?? String(dependencies.uid);
  const who = dependencies.userName ?? "this user";
  const unitFile = join(dependencies.unitDir, SYSTEMD_UNIT_NAME);
  const systemctl = (...args: ReadonlyArray<string>) => ["systemctl", "--user", ...args];

  const readPid = Effect.map(
    runOrFail(
      run,
      systemctl("show", SYSTEMD_UNIT_NAME, "-p", "LoadState,ActiveState,MainPID"),
      "systemd did not report the Hercule service",
    ),
    (result) => parseSystemdPid(result.stdout),
  );

  /** Reads the role and the Hercule Home the installed unit runs, or `undefined` when there is none. */
  const readInstalledUnit = Effect.try({
    try: () =>
      existsSync(unitFile) ? parseSystemdUnit(readFileSync(unitFile, "utf8")) : undefined,
    catch: () =>
      new ServiceError({ message: `Could not read ${unitFile}. Check that you own it.` }),
  });

  const readStatus: Effect.Effect<ServiceStatus, ServiceError> = Effect.gen(function* () {
    const installed = yield* readInstalledUnit;
    const pid = yield* readPid;
    return {
      installed: installed !== undefined,
      running: pid !== null,
      pid,
      role: installed?.role ?? null,
      home: installed?.home ?? null,
      unitFile,
    };
  });

  const requireInstalledUnit = Effect.flatMap(readInstalledUnit, (installed) =>
    installed === undefined ? Effect.fail(createNotInstalledError()) : Effect.succeed(installed),
  );

  /** Turns lingering on for the user, unless it is on already. */
  const enableLinger = Effect.gen(function* () {
    const shown = yield* run(["loginctl", "show-user", String(dependencies.uid), "-p", "Linger"]);
    if (shown.exitCode === 0 && shown.stdout.trim() === "Linger=yes") return;
    const enabled = yield* run(["loginctl", "enable-linger", String(dependencies.uid)]);
    if (enabled.exitCode !== 0) {
      return yield* new ServiceError({
        message: `Could not turn on lingering for ${who}, so systemd would stop Hercule when ${who} logs out. Run \`sudo loginctl enable-linger ${user}\`, then run this again.`,
      });
    }
  });

  const install = (unit: ServiceUnit): Effect.Effect<ServiceStatus, ServiceError> =>
    Effect.gen(function* () {
      const installed = yield* readInstalledUnit;
      yield* refuseOtherHome(installed?.home ?? null, unit);
      yield* enableLinger;
      yield* createLogFiles(unit);
      const previousPid = yield* readPid;
      yield* writeUnitFile(unitFile, renderSystemdUnit(unit));
      yield* runOrFail(run, systemctl("daemon-reload"), "systemd did not read the new unit");
      yield* runOrFail(
        run,
        systemctl("enable", SYSTEMD_UNIT_NAME),
        "systemd did not enable the Hercule service",
      );
      yield* runOrFail(
        run,
        systemctl("restart", SYSTEMD_UNIT_NAME),
        "systemd did not start the Hercule service",
      );
      yield* waitForStablePid({ readPid, previousPid, logs: pointAtLogs(unit, unitFile) });
      return yield* readStatus;
    });

  const uninstall = Effect.gen(function* () {
    if (existsSync(unitFile)) {
      yield* runOrFail(
        run,
        systemctl("disable", "--now", SYSTEMD_UNIT_NAME),
        "systemd did not stop the Hercule service",
      );
      yield* deleteUnitFile(unitFile);
      yield* runOrFail(run, systemctl("daemon-reload"), "systemd did not forget the removed unit");
    }
    return yield* readStatus;
  });

  const start = Effect.gen(function* () {
    const installed = yield* requireInstalledUnit;
    if ((yield* readPid) !== null) return yield* readStatus;
    yield* runOrFail(
      run,
      systemctl("start", SYSTEMD_UNIT_NAME),
      "systemd did not start the Hercule service",
    );
    yield* waitForStablePid({ readPid, previousPid: null, logs: pointAtLogs(installed, unitFile) });
    return yield* readStatus;
  });

  const stop = Effect.gen(function* () {
    yield* requireInstalledUnit;
    yield* runOrFail(
      run,
      systemctl("stop", SYSTEMD_UNIT_NAME),
      "systemd did not stop the Hercule service",
    );
    return yield* readStatus;
  });

  const restart = Effect.gen(function* () {
    const installed = yield* requireInstalledUnit;
    const previousPid = yield* readPid;
    yield* runOrFail(
      run,
      systemctl("restart", SYSTEMD_UNIT_NAME),
      "systemd did not restart the Hercule service",
    );
    yield* waitForStablePid({ readPid, previousPid, logs: pointAtLogs(installed, unitFile) });
    return yield* readStatus;
  });

  return Supervisor.of({
    unitFile,
    uninstallNote: `Lingering stays on for ${who}. To turn it off, run \`sudo loginctl disable-linger ${user}\`.`,
    install,
    uninstall,
    start,
    stop,
    restart,
    readStatus,
  });
};
