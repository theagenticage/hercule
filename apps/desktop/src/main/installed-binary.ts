/**
 * The Hercule binary installed on this Mac, `~/.local/bin/hercule`, which main
 * runs to find and start Hercule, and to read its setup URL. Spec 15 §4 owns
 * the commands and their `--json` output.
 *
 * Main asks the binary rather than reading the Hercule Home itself: it never
 * names a Home or a file in one. Every command runs with every `HERCULE_*`
 * variable removed from its environment and no `--home`, so the binary uses
 * its default Home, `~/.hercule`. Main decodes the output with a schema of
 * its own, which holds only the fields main reads, because the app links no
 * `@hercule/service` (ADR 0037).
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { parseControllerUrl } from "./controller-connection";
import {
  describeFailedExit,
  type ProgramExit,
  removeVariablesWithPrefix,
  runProgram,
} from "./run-program";

/** The origin of a controller, as the binary prints it, such as `http://127.0.0.1:4937`. */
const ControllerOrigin = Schema.String.check(
  Schema.makeFilter((url: string) =>
    parseControllerUrl(url) === url ? undefined : `Expected a controller's origin, got ${url}`,
  ),
);

/**
 * What `hercule service <verb> --json` prints, as far as main reads it. The
 * output holds more fields, which decoding drops.
 *
 * - `installed` and `running`: whether a Service Unit is installed, and
 *   whether its process runs.
 * - `role`: what the Service Unit runs, `serve` for Hercule's controller or
 *   `runner`, or null when none is installed.
 * - `controllerUrl`: the origin a process on this Mac opens Hercule at, from
 *   the default Hercule Home's `config.toml`, or null when that file cannot
 *   be read.
 * - `logsDir`: the default Hercule Home's logs folder.
 */
export const ServiceReport = Schema.Struct({
  installed: Schema.Boolean,
  running: Schema.Boolean,
  role: Schema.NullOr(Schema.Literals(["serve", "runner"])),
  controllerUrl: Schema.NullOr(ControllerOrigin),
  logsDir: Schema.String,
});
export type ServiceReport = typeof ServiceReport.Type;

const decodeServiceReport = Schema.decodeUnknownOption(Schema.fromJsonString(ServiceReport));

/** The error a command fails with when there is no binary at its path. */
export class BinaryNotFound extends Data.TaggedError("BinaryNotFound")<{
  readonly message: string;
}> {}

/**
 * The error a command fails with when it exits with an error, prints output
 * that does not decode, or runs past its time limit. `line` is the reason, in
 * one line: usually the last line the binary wrote to stderr, without its
 * `hercule: ` prefix. Spec 15 §4 makes each of those one line that tells the
 * user what to do.
 */
export class BinaryCommandFailed extends Data.TaggedError("BinaryCommandFailed")<{
  readonly line: string;
}> {}

/** How long `status` and `setup-url` may run: each reads a few files and asks launchd once. */
const QUICK_COMMAND_TIME_LIMIT = "10 seconds";

/** The exit code of `hercule setup-url` when the Hercule Home holds no setup URL. */
const NO_SETUP_URL_EXIT_CODE = 3;

/** The Hercule binary installed on this Mac. */
export class InstalledBinary extends Context.Service<
  InstalledBinary,
  {
    /**
     * Runs `hercule service status --json` and returns what it reports.
     * Fails with BinaryNotFound when there is no binary, and with
     * BinaryCommandFailed when the command fails, prints output that does
     * not decode, or runs longer than 10 seconds.
     */
    readonly readStatus: Effect.Effect<ServiceReport, BinaryNotFound | BinaryCommandFailed>;

    /**
     * Runs `hercule service install --json`, with `path` as its `PATH`, and
     * returns what it reports. The Service Unit records that `PATH`, so the
     * runner finds the user's programs. The command installs the Service
     * Unit, or starts it again, and exits once Hercule has run for 3
     * seconds; it gives up after about a minute. Fails as `readStatus` does,
     * with no time limit: interrupting the effect stops the command.
     */
    readonly install: (
      path: string,
    ) => Effect.Effect<ServiceReport, BinaryNotFound | BinaryCommandFailed>;

    /**
     * Runs `hercule setup-url` and returns the setup URL it prints, such as
     * `http://127.0.0.1:4937/setup?token=...`, or null when the Hercule Home
     * holds none. Fails as `readStatus` does.
     */
    readonly readSetupUrl: Effect.Effect<string | null, BinaryNotFound | BinaryCommandFailed>;
  }
>()("hercule/desktop/InstalledBinary") {}

/**
 * Returns one line about why `exit`, a command's exit, failed: as
 * describeFailedExit returns it, without the `hercule: ` prefix the binary
 * starts each of its errors with.
 */
export const describeBinaryFailure = (exit: ProgramExit): string =>
  describeFailedExit(exit, "Hercule").replace(/^hercule: /, "");

/**
 * Returns main's environment without any `HERCULE_*` variable, so that the
 * binary reads its settings from its default Hercule Home alone. `install`
 * refuses to run with one set, because the Service Unit would run without
 * it. Main's environment is read at each call, so each command runs with
 * the environment main has at that moment.
 */
const buildBinaryEnvironment = (): NodeJS.ProcessEnv =>
  removeVariablesWithPrefix(process.env, "HERCULE_");

/** Builds the service on the binary at `binaryPath`. */
export const makeInstalledBinaryLayer = (binaryPath: string): Layer.Layer<InstalledBinary> => {
  /**
   * Runs the binary with `args` and returns how it exited. Fails with
   * BinaryNotFound when there is no file at `binaryPath`, and with
   * BinaryCommandFailed when the binary could not be started otherwise.
   */
  const runBinary = (
    args: ReadonlyArray<string>,
    env: NodeJS.ProcessEnv,
  ): Effect.Effect<ProgramExit, BinaryNotFound | BinaryCommandFailed> =>
    runProgram(binaryPath, args, { env }).pipe(
      Effect.mapError((error) =>
        error.code === "ENOENT"
          ? new BinaryNotFound({ message: `There is no Hercule binary at ${binaryPath}.` })
          : new BinaryCommandFailed({ line: `Hercule could not be started: ${error.message}` }),
      ),
    );

  /**
   * Runs `hercule service <verb> --json` and decodes what it prints. Fails
   * when it exits with an error, or prints output that does not decode.
   */
  const runServiceCommand = (
    verb: string,
    env: NodeJS.ProcessEnv,
  ): Effect.Effect<ServiceReport, BinaryNotFound | BinaryCommandFailed> =>
    Effect.gen(function* () {
      const exit = yield* runBinary(["service", verb, "--json"], env);
      if (exit.exitCode !== 0)
        return yield* new BinaryCommandFailed({ line: describeBinaryFailure(exit) });
      const report = decodeServiceReport(exit.stdout);
      if (Option.isNone(report)) {
        return yield* new BinaryCommandFailed({
          line: `\`hercule service ${verb} --json\` printed a status the app cannot read. Install Hercule again.`,
        });
      }
      return report.value;
    });

  /**
   * Fails with BinaryCommandFailed when `command` runs longer than
   * QUICK_COMMAND_TIME_LIMIT, and stops it.
   */
  const limitQuickCommand = <A, E>(name: string, command: Effect.Effect<A, E>) =>
    command.pipe(
      Effect.timeoutOrElse({
        duration: QUICK_COMMAND_TIME_LIMIT,
        orElse: () =>
          Effect.fail(
            new BinaryCommandFailed({
              line: `\`${name}\` did not finish within ${String(Duration.toSeconds(QUICK_COMMAND_TIME_LIMIT))} seconds.`,
            }),
          ),
      }),
    );

  return Layer.succeed(InstalledBinary)({
    readStatus: Effect.suspend(() =>
      limitQuickCommand(
        "hercule service status",
        runServiceCommand("status", buildBinaryEnvironment()),
      ),
    ),
    install: (path) =>
      Effect.suspend(() =>
        runServiceCommand("install", { ...buildBinaryEnvironment(), PATH: path }),
      ),
    readSetupUrl: limitQuickCommand(
      "hercule setup-url",
      Effect.gen(function* () {
        const exit = yield* runBinary(["setup-url"], buildBinaryEnvironment());
        if (exit.exitCode === NO_SETUP_URL_EXIT_CODE) return null;
        if (exit.exitCode !== 0) {
          return yield* new BinaryCommandFailed({ line: describeBinaryFailure(exit) });
        }
        return exit.stdout.trim();
      }),
    ),
  });
};
