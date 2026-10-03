/**
 * The runner role: parses `hercule runner` arguments and runs the matching
 * command. This module's import graph must never reach the controller, the DB
 * engine, the plugin host, or the web bundle.
 *
 * `join` belongs to this role instead of the CLI, because every file it writes
 * belongs to the runner.
 *
 * Both daemon forms stop cleanly on SIGINT or SIGTERM instead of being killed.
 * Closing the connection's scope is where the runner tells the controller it
 * is going away. A runner that just disappeared would instead show as
 * unreachable for a minute.
 *
 * Both daemon forms write their log lines to `<home>/logs/runner.log`, never
 * to stdout: the controller that spawns a local runner reads a line from its
 * stdout, and a service unit discards stdout.
 */
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import type * as Scope from "effect/Scope";
import { Result } from "effect";
import {
  loadBootstrapConfig,
  locateCompiledBinary,
  parseGlobalOptions,
  resolveHomePathToActOn,
  type ConfigOverrides,
} from "@hercule/home";
import { makeProcessLogLayer } from "@hercule/process-log";
import { makeSupervisorLayer } from "@hercule/service";
import { runCredentialAction } from "./credentials";
import { runDaemon } from "./daemon";
import { runJoinCommand } from "./join";
import { runLocalRunner } from "./local";
import { providerLogins } from "./providers";
import { sessions } from "./sessions";
import { setController } from "./set-controller";

/** The same exit codes the CLI uses. */
const EXIT = { failed: 1, usage: 2 } as const;

const USAGE = [
  "usage: hercule runner",
  "       hercule runner --local",
  "       hercule runner join <controller-url> --token <token> [--reserved] [--no-service]",
  "       hercule runner set-controller <controller-url>",
].join("\n");

/**
 * Installs SIGINT and SIGTERM handlers, and returns an effect that completes
 * when either signal arrives. The handlers stay installed until the scope
 * closes, which is after the connection is closed. Otherwise a second signal
 * would reach Bun's default handler and kill the process during shutdown.
 */
const untilStopped: Effect.Effect<Effect.Effect<void>, never, Scope.Scope> = Effect.acquireRelease(
  Effect.sync(() => {
    const stopped = Latch.makeUnsafe(false);
    const stop = (): void => {
      stopped.openUnsafe();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return { stopped, stop };
  }),
  ({ stop }) =>
    Effect.sync(() => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }),
).pipe(Effect.map(({ stopped }) => stopped.await));

/**
 * Runs a daemon until it fails or a stop signal arrives, with its log lines
 * going to `<home>/logs/runner.log` at the configured `log.level`. When the
 * daemon fails, prints the error and sets exit code 1. Does the same without
 * starting the daemon when `config.toml`, a `-c` flag or a `HERCULE_*`
 * variable is invalid.
 */
const runUntilStopped = async (
  options: {
    readonly home: string;
    readonly overrides: ConfigOverrides;
  },
  work: Effect.Effect<void, { readonly message: string }>,
): Promise<void> => {
  const config = await Effect.runPromise(
    Effect.result(
      loadBootstrapConfig({ home: options.home, overrides: options.overrides, env: process.env }),
    ),
  );
  if (Result.isFailure(config)) {
    console.error(`hercule: ${config.failure.message}`);
    process.exitCode = EXIT.failed;
    return;
  }
  const outcome = await Effect.runPromise(
    Effect.result(
      Effect.scoped(
        Effect.flatMap(untilStopped, (stopped) =>
          // The session shutdown runs inside the stop branch. So `raceFirst`
          // only interrupts `work`, which closes the connection, after every
          // session's exit has been sent on that connection.
          Effect.raceFirst(work, Effect.andThen(stopped, sessions.shutdown("runner_restart"))),
        ),
      ).pipe(
        // Stop any provider login in progress. A login process blocked on
        // stdin would otherwise outlive this process, still waiting for a
        // credential.
        Effect.ensuring(providerLogins.stopAll),
        Effect.provide(
          makeProcessLogLayer({
            home: options.home,
            role: "runner",
            level: config.success.logLevel,
          }),
        ),
      ),
    ),
  );
  if (outcome._tag === "Failure") {
    console.error(`hercule: ${outcome.failure.message}`);
    process.exitCode = EXIT.failed;
  }
};

const reportMisuse = (reason: string): void => {
  console.error(`hercule: ${reason}`);
  console.error(USAGE);
  process.exitCode = EXIT.usage;
};

/**
 * Returns the Home a runner command acts on. Inside a session with no Home
 * named, prints the refusal, sets the usage exit code and returns undefined.
 * It runs after the command line is checked, so a typo is still reported as
 * a typo inside a session.
 */
const resolveHomeOrReportRefusal = (homeOption: string | undefined): string | undefined => {
  const resolved = resolveHomePathToActOn(homeOption, process.env);
  if (Result.isSuccess(resolved)) return resolved.success;
  console.error(`hercule: ${resolved.failure.option}: ${resolved.failure.message}`);
  process.exitCode = EXIT.usage;
  return undefined;
};

export async function run(argv: readonly string[]): Promise<void> {
  const options = parseGlobalOptions(argv);
  if (Result.isFailure(options)) {
    console.error(`hercule: ${options.failure.option}: ${options.failure.message}`);
    process.exitCode = EXIT.usage;
    return;
  }
  const rest = options.success.rest;
  const verb = rest[0];

  if (verb === undefined || verb.startsWith("-")) {
    // Any other option is a typo, and starting a daemon would be the wrong response.
    const unknown = rest.find((token) => token !== "--local");
    if (unknown !== undefined) {
      reportMisuse(`unknown runner option \`${unknown}\``);
      return;
    }
    const home = resolveHomeOrReportRefusal(options.success.home);
    if (home === undefined) return;
    return await runUntilStopped(
      { home, overrides: options.success.overrides },
      verb === "--local" ? runLocalRunner(home) : runDaemon(home),
    );
  }
  if (verb !== "join" && verb !== "set-controller") {
    // Any other subcommand that reaches this role came from
    // `hercule git-credential`, because the dispatcher sends every other
    // runner subcommand to the CLI. git passes the action name, and only `get`
    // returns anything. It reads no Home, so it runs inside a session too.
    return await runCredentialAction(verb);
  }

  const args = rest.slice(1);

  if (verb === "set-controller") {
    if (args.length !== 1) {
      reportMisuse("set-controller takes one controller URL");
      return;
    }
    const home = resolveHomeOrReportRefusal(options.success.home);
    if (home === undefined) return;
    const outcome = await Effect.runPromise(
      Effect.result(setController({ home, controllerUrl: args[0]! })),
    );
    if (outcome._tag === "Failure") {
      console.error(`hercule: ${outcome.failure.message}`);
      process.exitCode = EXIT.failed;
      return;
    }
    console.log(`This runner now looks for its controller at ${outcome.success}.`);
    return;
  }

  const flag = args.indexOf("--token");
  const token = flag < 0 ? undefined : args[flag + 1];
  const named = flag < 0 ? args : args.filter((_, at) => at !== flag && at !== flag + 1);
  const reserved = named.includes("--reserved");
  const noService = named.includes("--no-service");
  // Whatever is left after removing the flags and the token is the URL, so a
  // stray flag is rejected instead of ignored.
  const targets = named.filter((value) => value !== "--reserved" && value !== "--no-service");
  const controllerUrl = targets[0];
  if (controllerUrl === undefined) {
    reportMisuse("join needs the controller's URL");
    return;
  }
  if (targets.length > 1) {
    reportMisuse("join takes one controller URL");
    return;
  }
  if (token === undefined || token === "") {
    reportMisuse("join needs --token <token>");
    return;
  }
  const home = resolveHomeOrReportRefusal(options.success.home);
  if (home === undefined) return;

  const outcome = await Effect.runPromise(
    Effect.result(
      runJoinCommand({
        controllerUrl,
        token,
        home,
        reserved,
        service: noService
          ? undefined
          : {
              request: {
                role: "runner",
                home,
                overrides: options.success.overrides,
                env: process.env,
                program: locateCompiledBinary(),
              },
              supervisor: makeSupervisorLayer(process.env),
            },
        out: (line) => console.log(line),
      }),
    ),
  );
  if (outcome._tag === "Failure") {
    console.error(`hercule: ${outcome.failure.message}`);
    process.exitCode = EXIT.failed;
  }
}
