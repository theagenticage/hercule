/**
 * `hercule service`: the one OS service unit per machine that keeps Hercule
 * running across logins and reboots (spec 15 section 4). A launchd
 * LaunchAgent on macOS, a systemd user unit on Linux.
 *
 * The CLI runs the verbs through `runServiceCommand`, and `hercule runner
 * join` installs the runner's unit through `installService`. This package
 * links only `@hercule/home` and `effect`, because the runner's import graph
 * reaches it.
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Effect, Layer } from "effect";
import {
  BOOTSTRAP_KEYS,
  buildEnvName,
  holdsControllerDatabase,
  locateCompiledBinary,
  locateConfigFile,
  locateLogsDir,
  type ConfigFileError,
  type ConfigOverrides,
  type ConfigValueError,
  type Env,
} from "@hercule/home";
import { createLaunchdSupervisor } from "./launchd";
import { chooseServiceRole } from "./role";
import { ServiceError, Supervisor, runCommand, type ServiceStatus } from "./supervisor";
import { createSystemdSupervisor } from "./systemd";
import { buildServicePath, buildServiceUnit, type ServiceRole } from "./unit";

export { ServiceError, Supervisor, type ServiceStatus } from "./supervisor";
export type { ServiceRole } from "./unit";

/**
 * Returns the Supervisor of this machine, given the environment of the
 * command that asks for it: launchd on macOS, systemd on Linux. The layer
 * fails with `ServiceError` on any other platform.
 */
export const makeSupervisorLayer = (env: Env): Layer.Layer<Supervisor, ServiceError> =>
  Layer.effect(
    Supervisor,
    Effect.suspend(() => {
      const uid = process.getuid?.() ?? 0;
      // Only for messages. Bun's `userInfo()` reads `$USER` too, and reports
      // "unknown" where it is unset, as under `sudo -u` or in a container.
      const userName = env["USER"] ?? env["LOGNAME"];
      switch (process.platform) {
        case "darwin":
          return Effect.succeed(
            createLaunchdSupervisor({
              run: runCommand,
              unitDir: join(homedir(), "Library", "LaunchAgents"),
              uid,
              userName,
            }),
          );
        case "linux": {
          // The XDG Base Directory spec has a relative XDG_CONFIG_HOME ignored.
          const configured = env["XDG_CONFIG_HOME"];
          const configHome =
            configured !== undefined && isAbsolute(configured)
              ? configured
              : join(homedir(), ".config");
          return Effect.succeed(
            createSystemdSupervisor({
              run: runCommand,
              unitDir: join(configHome, "systemd", "user"),
              uid,
              userName,
            }),
          );
        }
        default:
          return Effect.fail(
            new ServiceError({
              message: `Hercule installs a service on macOS and Linux only, and this machine runs ${process.platform}. Start \`hercule serve\` or \`hercule runner\` by hand instead.`,
            }),
          );
      }
    }),
  );

/** What `installService` installs, and the command line it was asked from. */
export interface ServiceInstallRequest {
  readonly role: ServiceRole;
  /** The absolute Hercule Home the unit runs. */
  readonly home: string;
  readonly overrides: ConfigOverrides;
  readonly env: Env;
  /** The compiled binary the unit runs, from `locateCompiledBinary`. */
  readonly program: string | undefined;
}

/**
 * Fails when the command line has a `-c` flag. A flag changes only the
 * process it is given to, and the service process reads only `config.toml`,
 * so the user would not get the setting they asked for.
 */
const refuseConfigFlags = (
  home: string,
  overrides: ConfigOverrides,
): Effect.Effect<void, ServiceError> => {
  const flag = overrides[0];
  if (flag === undefined) return Effect.void;
  const [key, value] = flag;
  return Effect.fail(
    new ServiceError({
      message: `-c ${key}=${value} applies only to this command, and the service reads only ${locateConfigFile(home)}. Put ${key} in that file instead, then run this again without -c.`,
    }),
  );
};

/**
 * Fails when the environment sets a bootstrap key. The unit runs with none of
 * them, so the service would quietly run with other settings than the ones
 * the user has.
 *
 * `HERCULE_HOME` is not a bootstrap key: it chooses the Home, and the unit
 * carries the Home it was installed for.
 */
const refuseConfigVariables = (home: string, env: Env): Effect.Effect<void, ServiceError> => {
  const key = BOOTSTRAP_KEYS.find((each) => env[buildEnvName(each)] !== undefined);
  if (key === undefined) return Effect.void;
  const name = buildEnvName(key);
  return Effect.fail(
    new ServiceError({
      message: `${name} is set, and the service reads only ${locateConfigFile(home)}. Put ${key} in that file instead, then unset ${name} and run this again.`,
    }),
  );
};

/**
 * Fails when a path has a control character. A line break in a path would
 * end the line of a systemd unit early and let the rest of the path add a
 * setting of its own.
 */
const refuseControlCharacters = (what: string, path: string): Effect.Effect<void, ServiceError> =>
  [...path].some((character) => character < " " || character === "\x7f")
    ? Effect.fail(
        new ServiceError({
          message: `${what} ${JSON.stringify(path)} has a control character, which a unit file cannot hold. Use a path without one.`,
        }),
      )
    : Effect.void;

/**
 * Checks whether every user of this machine can write to a path. A path that
 * cannot be read is not, because it holds no program the service could run.
 */
const isWorldWritable = (path: string): boolean => {
  try {
    return (statSync(path).mode & 0o002) !== 0;
  } catch {
    return false;
  }
};

/**
 * Fails when other users of this machine could change what the service runs:
 * when they can write to the binary, or to a folder on the PATH the service
 * runs with. The service runs as this user, so a program another user put on
 * that PATH would run with this user's credentials.
 *
 * A folder that only a group can write to passes, because Homebrew's
 * `/usr/local/bin` is writable by the `admin` group.
 */
const refuseWorldWritablePaths = (
  program: string,
  servicePath: string,
): Effect.Effect<void, ServiceError> =>
  Effect.gen(function* () {
    if (isWorldWritable(program)) {
      return yield* new ServiceError({
        message: `Every user on this machine can write to ${program}, so anyone could change the program the service runs. Run \`chmod o-w ${program}\`, then run this again.`,
      });
    }
    const folder = servicePath.split(":").find(isWorldWritable);
    if (folder !== undefined) {
      return yield* new ServiceError({
        message: `${folder} is on the PATH the service runs with, and every user on this machine can write to it, so anyone could put a program there that the service runs. Remove ${folder} from PATH, or run \`chmod o-w ${folder}\`, then run this again.`,
      });
    }
  });

/**
 * Checks everything `installService` checks before it changes anything, and
 * returns the compiled binary the unit will run. `hercule runner join` calls
 * this before it spends its join token, so a refusal leaves the token unused.
 * Fails with `ServiceError` when:
 *
 * - Hercule runs from a source checkout rather than the compiled binary;
 * - a `-c` flag or a `HERCULE_*` bootstrap variable is set;
 * - the binary, the Home or the PATH has a control character;
 * - other users can write to the binary or to a folder on the PATH;
 * - the role is `runner` and the Home holds a controller database, whose
 *   unit runs `hercule serve`.
 *
 * Fails with `ConfigFileError` or `ConfigValueError` when the Home's
 * `config.toml` cannot be used.
 */
export const checkServiceCanBeInstalled = (
  request: ServiceInstallRequest,
): Effect.Effect<string, ServiceError | ConfigFileError | ConfigValueError> =>
  Effect.gen(function* () {
    const program = request.program;
    if (program === undefined) {
      return yield* new ServiceError({
        message:
          "A service runs the compiled hercule binary, and this Hercule runs from a source checkout. Build the binary with `pnpm build:binary` and run `./hercule service install`.",
      });
    }
    yield* refuseConfigFlags(request.home, request.overrides);
    yield* refuseConfigVariables(request.home, request.env);
    const servicePath = buildServicePath(program, request.env["PATH"]);
    yield* refuseControlCharacters("The binary", program);
    yield* refuseControlCharacters("The Hercule Home", request.home);
    yield* refuseControlCharacters("The PATH", servicePath);
    yield* refuseWorldWritablePaths(program, servicePath);
    if (request.role === "runner" && (yield* holdsControllerDatabase(request.home))) {
      return yield* new ServiceError({
        message: `The Hercule Home ${request.home} holds a controller database, so its service runs \`hercule serve\`, which starts a runner of its own. To make this machine a separate runner, give it its own Home with --home.`,
      });
    }
    return program;
  });

/**
 * Installs and (re)starts the unit that runs `request.role` for
 * `request.home`, and returns the status once the process runs. Fails with
 * the errors of `checkServiceCanBeInstalled`, and with `ServiceError` when
 * the Supervisor refuses or fails, for example because the installed unit
 * runs another Hercule Home.
 */
export const installService = (
  request: ServiceInstallRequest,
): Effect.Effect<ServiceStatus, ServiceError | ConfigFileError | ConfigValueError, Supervisor> =>
  Effect.gen(function* () {
    const program = yield* checkServiceCanBeInstalled(request);
    const supervisor = yield* Supervisor;
    return yield* supervisor.install(
      buildServiceUnit({
        role: request.role,
        program,
        home: request.home,
        callerPath: request.env["PATH"],
      }),
    );
  });

/** Returns the one line that describes a status for a person. */
export const describeStatus = (status: ServiceStatus): string => {
  if (!status.installed) return "No Hercule service is installed on this machine.";
  const command = status.role === null ? "Hercule" : `\`hercule ${status.role}\``;
  const runs = status.home === null ? command : `${command} for the Hercule Home ${status.home}`;
  return status.pid === null
    ? `The Hercule service is installed to run ${runs}, and is not running.`
    : `The Hercule service runs ${runs}, as pid ${status.pid}.`;
};

/** The verbs of `hercule service`, in the order the help lists them. */
export const SERVICE_VERBS = [
  "install",
  "uninstall",
  "start",
  "stop",
  "restart",
  "status",
] as const;

type ServiceVerb = (typeof SERVICE_VERBS)[number];

const isServiceVerb = (word: string | undefined): word is ServiceVerb =>
  (SERVICE_VERBS as ReadonlyArray<string | undefined>).includes(word);

/** The exit codes of `hercule service`, the same ones the rest of the CLI uses. */
const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

/** One `hercule service` command line, and where its output goes. */
export interface ServiceCommandRequest {
  /** The arguments after `service`, with the global options removed. */
  readonly args: ReadonlyArray<string>;
  /** The absolute Hercule Home, from `--home` or `HERCULE_HOME`. */
  readonly home: string;
  readonly overrides: ConfigOverrides;
  readonly env: Env;
  /** Writes one line to stdout. */
  readonly out: (line: string) => void;
  /** Writes one line to stderr. */
  readonly err: (line: string) => void;
}

/** The Supervisor and the binary a command uses. Tests replace both. */
export interface ServiceCommandDependencies {
  readonly supervisor: Layer.Layer<Supervisor, ServiceError>;
  readonly program: string | undefined;
}

/**
 * Runs the verb of a `hercule service` command and returns the exit code: 0
 * on success, 1 when the verb failed, 2 when the command line is wrong.
 *
 * The CLI prints `--help` itself. The command line is checked before the
 * Supervisor is created, so a usage error never reaches launchd or systemd.
 *
 * Every verb refuses a `-c` flag, because no verb starts Hercule in this
 * process: the unit runs it, and reads only `config.toml`.
 */
export const runServiceCommand = async (
  request: ServiceCommandRequest,
  dependencies: ServiceCommandDependencies = {
    supervisor: makeSupervisorLayer(request.env),
    program: locateCompiledBinary(),
  },
): Promise<number> => {
  const [verb, ...flags] = request.args;
  const reportMisuse = (reason: string): number => {
    request.err(`hercule: ${reason}`);
    request.err("run `hercule service --help`");
    return EXIT.usage;
  };
  if (!isServiceVerb(verb)) {
    return reportMisuse(
      verb === undefined
        ? `service needs a verb: ${SERVICE_VERBS.join(", ")}`
        : `unknown command \`${verb}\`; the service verbs are ${SERVICE_VERBS.join(", ")}`,
    );
  }
  const unknown = flags.find((flag) => flag !== "--json");
  if (unknown !== undefined) return reportMisuse(`service ${verb} takes no \`${unknown}\``);
  const json = flags.includes("--json");
  // With --json, stdout carries only the status, so the lines for a person go to stderr.
  const printForPerson = json ? request.err : request.out;

  const runVerb = Effect.gen(function* () {
    yield* refuseConfigFlags(request.home, request.overrides);
    const supervisor = yield* Supervisor;
    switch (verb) {
      case "install": {
        const chosen = yield* chooseServiceRole(request.home);
        printForPerson(`Installing the unit for \`hercule ${chosen.role}\`: ${chosen.reason}.`);
        return yield* installService({
          role: chosen.role,
          home: request.home,
          overrides: request.overrides,
          env: request.env,
          program: dependencies.program,
        });
      }
      case "uninstall": {
        const before = yield* supervisor.readStatus;
        const after = yield* supervisor.uninstall;
        if (!before.installed) {
          printForPerson(
            "No Hercule service is installed on this machine, so there is nothing to uninstall.",
          );
        } else {
          printForPerson(`Uninstalled the Hercule service and deleted ${before.unitFile}.`);
          if (before.home !== null)
            printForPerson(`The logs in ${locateLogsDir(before.home)} stay.`);
          if (supervisor.uninstallNote !== undefined) printForPerson(supervisor.uninstallNote);
        }
        return after;
      }
      case "start":
        return yield* supervisor.start;
      case "stop":
        return yield* supervisor.stop;
      case "restart":
        return yield* supervisor.restart;
      case "status":
        return yield* supervisor.readStatus;
    }
  });

  const outcome = await Effect.runPromise(
    Effect.result(Effect.provide(runVerb, dependencies.supervisor)),
  );
  if (outcome._tag === "Failure") {
    request.err(`hercule: ${outcome.failure.message}`);
    return EXIT.failed;
  }
  const status = outcome.success;
  if (json) {
    request.out(JSON.stringify(status, null, 2));
  } else if (verb !== "uninstall") {
    request.out(describeStatus(status));
  }
  return EXIT.ok;
};
