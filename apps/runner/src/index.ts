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
 */
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Logger from "effect/Logger";
import type * as Scope from "effect/Scope";
import { Result } from "effect";
import { parseGlobalOptions, resolveHomePath } from "@hercule/home";
import { runCredentialAction } from "./credentials";
import { runDaemon } from "./daemon";
import { join } from "./join";
import { runLocalRunner } from "./local";
import { providerLogins } from "./providers";
import { sessions } from "./sessions";
import { setController } from "./set-controller";

/** The same exit codes the CLI uses. */
const EXIT = { failed: 1, usage: 2 } as const;

const USAGE = [
  "usage: hercule runner",
  "       hercule runner --local",
  "       hercule runner join <controller-url> --token <token> [--reserved]",
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
 * Runs a daemon until it fails or a stop signal arrives. On failure, prints
 * the error and sets a failing exit code.
 *
 * All logs go to stderr, because the controller that spawns a local runner
 * reads a line from its stdout.
 */
const runUntilStopped = async (
  work: Effect.Effect<void, { readonly message: string }>,
): Promise<void> => {
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
        Effect.provideService(Logger.LogToStderr, true),
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
    const home = resolveHomePath(options.success.home, process.env);
    // Any other option is a typo, and starting a daemon would be the wrong response.
    const unknown = rest.find((token) => token !== "--local");
    if (unknown !== undefined) {
      reportMisuse(`unknown runner option \`${unknown}\``);
      return;
    }
    return await runUntilStopped(verb === "--local" ? runLocalRunner(home) : runDaemon(home));
  }
  if (verb !== "join" && verb !== "set-controller") {
    // Any other subcommand that reaches this role came from
    // `hercule git-credential`, because the dispatcher sends every other
    // runner subcommand to the CLI. git passes the action name, and only `get`
    // returns anything.
    return await runCredentialAction(verb);
  }

  const args = rest.slice(1);
  const home = resolveHomePath(options.success.home, process.env);

  if (verb === "set-controller") {
    if (args.length !== 1) {
      reportMisuse("set-controller takes one controller URL");
      return;
    }
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
  // Whatever is left after removing the flags and the token is the URL, so a
  // stray flag is rejected instead of ignored.
  const targets = named.filter((value) => value !== "--reserved");
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

  const outcome = await Effect.runPromise(
    Effect.result(join({ controllerUrl, token, home, reserved })),
  );

  if (outcome._tag === "Failure") {
    console.error(`hercule: ${outcome.failure.message}`);
    process.exitCode = EXIT.failed;
    return;
  }
  console.log(`This machine joined as ${outcome.success.name}.`);
  console.log(`Its credential is in ${outcome.success.configPath}.`);
}
