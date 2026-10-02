/**
 * The `hercule service` command line: its help, its verbs and its exit codes.
 * The dispatcher hands it every invocation that starts with `service`.
 */
import { Effect, Layer, Result } from "effect";
import {
  buildControllerOrigin,
  loadBootstrapConfig,
  locateCompiledBinary,
  locateLogsDir,
  parseGlobalOptions,
  resolveHomePath,
  type ConfigOverrides,
  type Env,
} from "@hercule/home";
import { installService, refuseConfigFlags } from "./install";
import { makeSupervisorLayer } from "./platform";
import { chooseServiceRole } from "./role";
import { Supervisor, type ServiceError, type ServiceStatus } from "./supervisor";

/**
 * The exit codes of `hercule service`. A failure here happened on this
 * machine, so code 1 does not mean an error envelope, as it does for the
 * commands that call the controller.
 */
const EXIT = {
  ok: 0,
  /** The verb failed or was refused. */
  failed: 1,
  /** The command line was wrong, and nothing was changed. */
  usage: 2,
} as const;

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

/** The help of `hercule service`, one line per entry. */
const SERVICE_HELP: ReadonlyArray<string> = [
  "usage: hercule service <verb> [--json]",
  "",
  "Installs and controls the one OS service unit that keeps Hercule running on this machine",
  "across logins and reboots: a launchd LaunchAgent on macOS, a systemd user unit on Linux. The",
  "unit runs the compiled hercule binary for this Hercule Home, and reads its settings only from",
  "<home>/config.toml, so every verb refuses -c flags, and install refuses HERCULE_* settings in",
  "the environment.",
  "",
  "verbs:",
  "  install    write the unit and (re)start it; prints whether it runs serve or runner, and why",
  "  uninstall  stop the unit and delete it; the logs stay",
  "  start      start the installed unit when it is not running",
  "  stop       stop the unit's process; the unit stays installed and starts at the next login",
  "  restart    stop the unit's process and start it again",
  "  status     print whether a unit is installed, what it runs, and its pid",
  "",
  "flags:",
  "  --json  print { installed, running, pid, role, home, unitFile, controllerUrl, logsDir } once",
  "          the verb is done",
  "",
  "In that JSON, home is the Hercule Home the installed unit runs, which can be another Home than",
  "this command's. controllerUrl and logsDir describe the Home this command ran for: the address",
  "Hercule answers at on this machine, from that Home's config.toml alone (null when Hercule",
  "cannot read it), and its logs folder.",
  "",
  "The process logs to <home>/logs/controller.log or runner.log; what it prints before its log",
  "opens goes to the .stderr.log beside it.",
  "",
  "exit: 0 succeeded, 1 the verb failed on this machine, with one line that explains what to",
  "do, 2 the command line was wrong and nothing changed.",
];

/**
 * What every verb prints with `--json` once it is done (spec 15 section 4):
 * the status of the Service Unit, and two fields about the Hercule Home this
 * command ran for. The two Homes can differ: `home` is the Home the installed
 * unit runs, and a command run with `--home` asks about another one.
 *
 * - `controllerUrl`: the origin a process on this machine opens Hercule at,
 *   or `null` when the Home's `config.toml` cannot be used.
 * - `logsDir`: the Home's logs folder.
 */
export interface ServiceReport extends ServiceStatus {
  readonly controllerUrl: string | null;
  readonly logsDir: string;
}

/**
 * Returns the origin a process on this machine opens Hercule at for a Hercule
 * Home, such as `http://127.0.0.1:4937`. It is built from `bind.host` and
 * `bind.port` in the Home's `config.toml`, or their defaults. Returns `null`
 * when `config.toml` cannot be read, or holds a value Hercule cannot use.
 *
 * `-c` flags and `HERCULE_*` variables are ignored, because the Service Unit
 * runs Hercule with `config.toml` alone.
 */
const readControllerUrl = (home: string): Effect.Effect<string | null> =>
  loadBootstrapConfig({ home, overrides: [], env: {} }).pipe(
    Effect.map((config) => buildControllerOrigin(config.bindHost, config.bindPort)),
    Effect.orElseSucceed(() => null),
  );

/** Returns the one line that describes a status for a person. */
export const describeStatus = (status: ServiceStatus): string => {
  if (!status.installed) return "No Hercule service is installed on this machine.";
  const command = status.role === null ? "Hercule" : `\`hercule ${status.role}\``;
  const runs = status.home === null ? command : `${command} for the Hercule Home ${status.home}`;
  return status.pid === null
    ? `The Hercule service is installed to run ${runs}, and is not running.`
    : `The Hercule service runs ${runs}, as pid ${status.pid}.`;
};

/** One `hercule service` command line, and where its output goes. */
export interface ServiceCommandRequest {
  /** The arguments after `service`, with the global options removed. */
  readonly args: ReadonlyArray<string>;
  /** The absolute Hercule Home, from `--home`, else `HERCULE_HOME`, else `~/.hercule`. */
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
 * Runs a `hercule service` command and returns the exit code: 0 on success,
 * 1 when the verb failed, 2 when the command line is wrong.
 *
 * `--help` or `-h` anywhere prints the help. The command line is checked
 * before the Supervisor is created, so a usage error never reaches launchd or
 * systemd.
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
  if (request.args.includes("--help") || request.args.includes("-h")) {
    for (const line of SERVICE_HELP) request.out(line);
    return EXIT.ok;
  }
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
  if (Result.isFailure(outcome)) {
    request.err(`hercule: ${outcome.failure.message}`);
    return EXIT.failed;
  }
  const status = outcome.success;
  if (json) {
    const report: ServiceReport = {
      ...status,
      controllerUrl: await Effect.runPromise(readControllerUrl(request.home)),
      logsDir: locateLogsDir(request.home),
    };
    request.out(JSON.stringify(report, null, 2));
  } else if (verb !== "uninstall") {
    request.out(describeStatus(status));
  }
  return EXIT.ok;
};

/**
 * The `service` role: runs `hercule service <verb>` for the Hercule Home the
 * global options choose, and sets the process's exit code.
 */
export async function run(argv: readonly string[]): Promise<void> {
  const options = parseGlobalOptions(argv);
  if (Result.isFailure(options)) {
    console.error(`hercule: ${options.failure.option}: ${options.failure.message}`);
    process.exitCode = EXIT.usage;
    return;
  }
  process.exitCode = await runServiceCommand({
    args: options.success.rest,
    home: resolveHomePath(options.success.home, process.env),
    overrides: options.success.overrides,
    env: process.env,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
