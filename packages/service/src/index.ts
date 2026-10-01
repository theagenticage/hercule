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
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Effect, Layer } from "effect";
import {
  BOOTSTRAP_KEYS,
  ConfigFileError,
  buildEnvName,
  locateConfigFile,
  locateLogsDir,
} from "@hercule/home";
import { createLaunchdSupervisor } from "./launchd";
import { chooseServiceRole } from "./role";
import { ServiceError, Supervisor, runCommand, type ServiceStatus } from "./supervisor";
import { createSystemdSupervisor } from "./systemd";
import { buildServiceUnit, type ServiceRole } from "./unit";

export {
  ServiceError,
  ServiceNotInstalledError,
  Supervisor,
  type ServiceStatus,
} from "./supervisor";
export type { ServiceRole } from "./unit";

type Env = Readonly<Record<string, string | undefined>>;

/** The path prefix Bun gives the entry script inside a compiled binary. */
const EMBEDDED = "/$bunfs/";

/**
 * Returns the path of the compiled `hercule` binary this process runs, or
 * `undefined` when Hercule runs from a source checkout. From a checkout the
 * executable is Bun itself, and a unit that ran it would run no Hercule.
 */
export const locateCompiledBinary = (): string | undefined =>
  Bun.main.startsWith(EMBEDDED) ? process.execPath : undefined;

/**
 * The Supervisor of this machine: launchd on macOS, systemd on Linux. Fails
 * with `ServiceError` on any other platform.
 */
export const SupervisorLayer: Layer.Layer<Supervisor, ServiceError> = Layer.effect(
  Supervisor,
  Effect.suspend(() => {
    const uid = process.getuid?.() ?? 0;
    // Only for messages. Bun's `userInfo()` reads `$USER` too, and reports
    // "unknown" where it is unset, as under `sudo -u` or in a container.
    const userName = process.env["USER"] ?? process.env["LOGNAME"];
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
        // The XDG spec says to ignore a relative XDG_CONFIG_HOME.
        const configured = process.env["XDG_CONFIG_HOME"];
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
export interface InstallRequest {
  readonly role: ServiceRole;
  /** The absolute Hercule Home the unit runs. */
  readonly home: string;
  /** The `-c key=value` flags on the command line. */
  readonly overrides: ReadonlyArray<readonly [key: string, value: string]>;
  readonly env: Env;
  /** The compiled binary the unit runs, from `locateCompiledBinary`. */
  readonly program: string | undefined;
}

/**
 * Fails when the command line or the environment sets a bootstrap key. The
 * unit runs with none of them, so the service would quietly run with other
 * settings than the ones the user just gave.
 *
 * `HERCULE_HOME` is not a bootstrap key: it chooses the Home, and the unit
 * carries the Home it was installed for.
 */
const refuseConfigOutsideFile = (request: InstallRequest): Effect.Effect<void, ServiceError> => {
  const configFile = locateConfigFile(request.home);
  const flag = request.overrides[0];
  if (flag !== undefined) {
    const [key, value] = flag;
    return Effect.fail(
      new ServiceError({
        message: `-c ${key}=${value} applies only to this command, and the service reads only ${configFile}. Put ${key} in that file instead, then run this again without -c.`,
      }),
    );
  }
  for (const key of BOOTSTRAP_KEYS) {
    const name = buildEnvName(key);
    if (request.env[name] !== undefined) {
      return Effect.fail(
        new ServiceError({
          message: `${name} is set, and the service reads only ${configFile}. Put ${key} in that file instead, then unset ${name} and run this again.`,
        }),
      );
    }
  }
  return Effect.void;
};

/**
 * Installs and (re)starts the unit that runs `request.role` for
 * `request.home`, and returns the status once the process runs. Fails with
 * `ServiceError` when:
 *
 * - Hercule runs from a source checkout rather than the compiled binary;
 * - a `-c` flag or a `HERCULE_*` bootstrap variable is set;
 * - the Supervisor refuses or fails, for example because the installed unit
 *   runs another Hercule Home.
 */
export const installService = (
  request: InstallRequest,
): Effect.Effect<ServiceStatus, ServiceError, Supervisor> =>
  Effect.gen(function* () {
    if (request.program === undefined) {
      return yield* new ServiceError({
        message:
          "A service runs the compiled hercule binary, and this Hercule runs from a source checkout. Build the binary with `pnpm build:binary` and run `./hercule service install`.",
      });
    }
    yield* refuseConfigOutsideFile(request);
    const supervisor = yield* Supervisor;
    return yield* supervisor.install(
      buildServiceUnit({
        role: request.role,
        program: request.program,
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

/** The verbs of `hercule service`. */
const VERBS = ["install", "uninstall", "start", "stop", "restart", "status"] as const;

type Verb = (typeof VERBS)[number];

const isVerb = (word: string | undefined): word is Verb =>
  (VERBS as ReadonlyArray<string | undefined>).includes(word);

/** The exit codes of `hercule service`, the same ones the rest of the CLI uses. */
const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

/** One `hercule service` command line, and where its output goes. */
export interface ServiceCommandRequest {
  /** The arguments after `service`, with the global options removed. */
  readonly args: ReadonlyArray<string>;
  /** The absolute Hercule Home, from `--home` or `HERCULE_HOME`. */
  readonly home: string;
  /** The `-c key=value` flags on the command line. */
  readonly overrides: ReadonlyArray<readonly [key: string, value: string]>;
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
 */
export const runServiceCommand = async (
  request: ServiceCommandRequest,
  dependencies: ServiceCommandDependencies = {
    supervisor: SupervisorLayer,
    program: locateCompiledBinary(),
  },
): Promise<number> => {
  const [verb, ...flags] = request.args;
  const reportMisuse = (reason: string): number => {
    request.err(`hercule: ${reason}`);
    request.err("run `hercule service --help`");
    return EXIT.usage;
  };
  if (!isVerb(verb)) {
    return reportMisuse(
      verb === undefined
        ? `service needs a verb: ${VERBS.join(", ")}`
        : `unknown command \`${verb}\`; the service verbs are ${VERBS.join(", ")}`,
    );
  }
  const unknown = flags.find((flag) => flag !== "--json");
  if (unknown !== undefined) return reportMisuse(`service ${verb} takes no \`${unknown}\``);
  // A `-c` flag changes only the process it is given to, and no verb starts
  // Hercule in this process: the unit runs it, and reads only config.toml.
  const flag = request.overrides[0];
  if (flag !== undefined) {
    return reportMisuse(
      `-c ${flag[0]}=${flag[1]} does not reach the service, which reads only ${locateConfigFile(request.home)}. Put ${flag[0]} in that file instead.`,
    );
  }
  const json = flags.includes("--json");
  // With --json, stdout carries only the status, so the lines for a person go to stderr.
  const say = json ? request.err : request.out;

  const runVerb = Effect.gen(function* () {
    const supervisor = yield* Supervisor;
    switch (verb) {
      case "install": {
        const chosen = yield* chooseServiceRole(request.home);
        say(`Installing the unit for \`hercule ${chosen.role}\`: ${chosen.reason}.`);
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
          say("No Hercule service is installed on this machine, so there is nothing to uninstall.");
        } else {
          say(`Uninstalled the Hercule service and deleted ${before.unitFile}.`);
          if (before.home !== null) say(`The logs in ${locateLogsDir(before.home)} stay.`);
          if (supervisor.uninstallNote !== undefined) say(supervisor.uninstallNote);
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
    const error = outcome.failure;
    request.err(
      error instanceof ConfigFileError
        ? `hercule: ${error.path} ${error.message}`
        : `hercule: ${error.message}`,
    );
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
